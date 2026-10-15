# Authentication & Session Design

**Infini Health** · Infinigrow Softech

This document explains the chosen authentication approach, its trade-offs, and why the
alternatives were rejected. It is the reference for `docs/ARCHITECTURE.md` §5.

---

## 1. Chosen approach

A **hybrid access + refresh token** scheme.

| Credential | Form | Lifetime | Storage (client) | Storage (server) |
| --- | --- | --- | --- | --- |
| Access token | EdDSA-signed JWT | **10 minutes** | Memory only | Not stored (stateless) |
| Refresh token | Opaque 256-bit random | **14 days** | `HttpOnly` cookie | SHA-256 hash in `refresh_sessions` |

### Access token

- **Asymmetric EdDSA (Ed25519).** Only the API holds the private key. A leaked
  verification key cannot be used to mint tokens — the reason an HMAC shared secret was
  rejected.
- **Minimal claims**: `sub`, `role`, `hospitalId`, `membershipId`, `sid`. No permission
  list is embedded; permissions are recomputed per request, so a role change takes
  effect **immediately** rather than at token expiry.
- **10-minute lifetime** bounds the window in which a terminated or de-roled user
  retains access. It is a belt-and-braces measure — the membership re-check is the
  primary control.

### Refresh token

- **Opaque**, not a JWT. A JWT refresh token cannot be revoked without a denylist, which
  defeats the point.
- **Rotated on every use.** Each refresh issues a new token and marks the old one
  consumed.
- **Family-based reuse detection.** Every refresh token belongs to a `familyId`. Replaying
  a consumed token revokes the **entire family**, logging out both the attacker and the
  legitimate user — who must re-authenticate. This is the standard defence against token
  theft (docs/SECURITY.md R6).
- **Stored hashed (SHA-256).** A database leak yields no usable sessions. SHA-256 rather
  than a password KDF because the input is 256 bits of CSPRNG output — there is no
  dictionary to attack, and a KDF would only add latency to every request.

### Cookie attributes

```
HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=1209600
```

| Attribute | Purpose |
| --- | --- |
| `HttpOnly` | Unreachable from JavaScript, so an XSS bug cannot read it |
| `Secure` | Never transmitted over plain HTTP (production) |
| `SameSite=Strict` | Never attached to a cross-site request — this is what removes the CSRF vector |
| `Path=/api/v1/auth` | Sent only to routes that need it, not to every API call |

---

## 2. Trade-offs, stated honestly

| Decision | Trade-off | Why accepted |
| --- | --- | --- |
| **Stateless access tokens** | A revoked user's token stays valid for up to 10 minutes | Bounded by the short TTL *and* backed by a per-request membership re-check, so revocation is effective immediately. A denylist would remove the stateless benefit. |
| **Membership re-check on every request** | One extra query per request | Correctness beats a cached permission list that goes stale. Mitigated later by a ≤60 s cache with explicit invalidation on change. |
| **Refresh token in a cookie, access token in memory** | The access token is lost on a page reload, so the client must call `/refresh` on load | This is the correct trade for a healthcare product: a durable credential stays out of JavaScript's reach, and the short-lived one is cheap to re-obtain. |
| **Cookie instead of cookie-less API** | Requires CSRF discipline for cookie-bearing routes | `SameSite=Strict` removes cross-site delivery; a double-submit token is added if any state-changing cookie-authenticated route appears. |
| **Opaque refresh tokens** | Requires server-side state | Only way to make revocation and reuse detection actually work. |
| **No refresh-token reuse grace window** | A network retry logs the user out | A grace window re-opens the replay window an attacker needs. Prefer the annoyance to the compromise. |

The client half of this design — how the browser holds, refreshes and discards these
credentials, and why the access token is never written to `localStorage` — is documented
in `FRONTEND.md` §2.

---

## 3. Alternatives considered and rejected

| Option | Why rejected |
| --- | --- |
| Server-side sessions only (opaque cookie, no JWT) | Every request hits the session store. At hospital scale that is a bottleneck for no security gain, since refresh state is server-side either way. |
| Long-lived JWT with no refresh token | A stolen token is valid for weeks. Unacceptable for clinical access. |
| HMAC (HS256) access tokens | A leaked verification secret permits **forging** tokens. Asymmetric keys contain the blast radius. |
| Storing refresh tokens in `localStorage` | Readable by any script on the page. One XSS bug becomes full account takeover. |
| Embedding the permission list in the access token | Requires a full token refresh for a permission change; roles would stay stale until expiry. |
| "Remember me" long-lived refresh token | A permanent credential on a shared clinical workstation is an unacceptable risk. |

---

## 4. Login and lockout

- **Uniform failure response.** Wrong password, unknown email, and a malformed attempt
  all produce the identical message `Invalid email or password` and the identical status.
- **Constant-time-ish unknown-user path.** When no user exists, the server still performs
  an Argon2id verification against a decoy hash. Without it, response timing alone would
  reveal which email addresses are registered (docs/SECURITY.md R11).
- **Lockout after 5 failures**, held on the user document so it survives a restart and is
  not defeated by rotating source IPs.
- **Password hashing**: Argon2id, OWASP parameters (19 MiB, t=2, p=1).
  `verifyPassword` returns `false` for a malformed hash rather than throwing, because the
  underlying library throws and that would disclose that an account's hash is corrupt.

---

## 5. Tenant scope and the access token

> **`hospitalId` in the token is a claim, not proof.**

The token carries `hospitalId` so the request does not need a lookup, but every request
independently re-validates that a membership exists and is `ACTIVE`:

```ts
// middleware/auth.ts
const membership = await MembershipModel.findOne({
  _id: claims.membershipId,
  userId: claims.userId,
  hospitalId: claims.hospitalId,
  status: 'ACTIVE',
})
if (!membership) throw ApiError.forbidden('Your access to this hospital has been revoked')
```

So forging a token would still require a valid, active membership for that hospital. The
JWT alone grants nothing.

`SUPER_ADMIN` receives a `PlatformContext` with **no** `hospitalId` field at all. Any
attempt to reach tenant data from a platform context fails closed, rather than defaulting
to "no hospital means all hospitals".

---

## 6. OTP and email verification

- **CSPRNG-generated**, 6 digits (`crypto.randomInt`), never `Math.random`.
- **10-minute expiry**, enforced server-side and backed by a MongoDB TTL index.
- **5 attempts per code.** A 6-digit space is only 10⁶ values; without a cap it is
  guessable in hours.
- **Stored hashed.** A database leak yields no live codes.
- **Never logged.** Delivery is a pluggable adapter (`resolveOtpDelivery`). If no SMTP
  provider is configured the request **fails closed** — there is deliberately no fallback
  that prints the code to the log. The code appears only in the message body, never in a
  subject line (which would leak it into mail-server logs and notification previews).

Rate limits: 5 password-reset requests per hour, 10 OTP verifications per 15 minutes.

---

## 7. Authorisation model

```
authenticate        → verifies signature, re-reads user, re-validates membership,
                      builds RequestContext (tenant) or PlatformContext (platform)
requireTenantScope  → rejects a platform actor on a tenant-only route
requirePermission   → checks the permission set resolved from the MEMBERSHIP
requirePlatformPermission → accepts only SUPER_ADMIN, and only `platform:*` names
```

Permissions are resolved by `resolvePermissions(role, grantedPermissions)`, which
**intersects** explicit grants with the role's ceiling: a grant can narrow a role but
never widen it, and a hospital role can never hold a `platform:*` permission.

---

## 8. Audit

Every authentication and administrative action writes an `AuditLog` entry: login success
and failure, logout, token refresh, reuse detection, account lockout, password reset,
hospital registration/approval/suspension, membership changes, and platform-scope use.

- **Append-only, enforced at the schema level.** A pre-hook rejects update and delete
  operations, so even a direct console call cannot remove evidence.
- **Identifiers, never values.** `metadata` holds field *names*, ids and outcomes. A
  recursive redactor strips passwords, tokens, OTPs, MFA secrets and patient identifiers
  at any nesting depth, with a depth bound so a pathological structure cannot hang the
  write.

---

## 9. Known limitations

| Limitation | Impact | Plan |
| --- | --- | --- |
| Membership re-check on every request | One extra query per request | ≤60 s cache with explicit invalidation (Phase 1c) |
| Rate limiter uses an in-memory store | Limit multiplies with instance count | Shared Redis/Mongo store — **release gate** in `RUNBOOK.md` |
| MFA (TOTP) enrolment not built | Admins lack second-factor protection | Phase 1c; enforcement toggle already reserved |
| Refresh cookie not rotated on privilege change | A refresh issued before a role change stays valid | Mitigated by the per-request membership re-check |
| Email verification is not yet enforced at login | A user can sign in before verifying | Phase 1c |

---

## 10. Operational requirements

Environment variables (all Phase 1, all validated at startup):

```
JWT_PRIVATE_KEY   # Ed25519 PKCS#8 PEM
JWT_PUBLIC_KEY    # Ed25519 SPKI PEM
JWT_ISSUER
JWT_AUDIENCE
MAIL_HOST, MAIL_PORT, MAIL_SECURE, MAIL_USER, MAIL_PASSWORD, MAIL_FROM
```

Generate a key pair for development:

```powershell
node -e "const{cryptoKeyPairSync}=require('crypto');const{privateKey,publicKey}=cryptoKeyPairSync('ed25519',{privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});console.log('JWT_PRIVATE_KEY='+privateKey.replace(/\n/g,'\\n'));console.log('JWT_PUBLIC_KEY='+publicKey.replace(/\n/g,'\\n'))"
```