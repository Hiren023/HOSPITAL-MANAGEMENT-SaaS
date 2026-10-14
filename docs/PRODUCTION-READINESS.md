# Production Readiness Review — Phase 10

**Status: REVIEW COMPLETE. NOT APPROVED FOR PRODUCTION DEPLOYMENT.**

Reviewed: 14 October 2026
Scope: `apps/api`, `apps/web`, `packages/shared`, CI configuration, documentation.

---

## 0. What this review is, and what it is not

### What was actually done

| Activity | Performed | Evidence |
| --- | --- | --- |
| `npm audit` (full tree) | **Yes** | `found 0 vulnerabilities` |
| `npm outdated` | **Yes** | 20 packages behind, all minor/patch except TypeScript |
| `npm run lint` | **Yes** | exit 0, 0 problems |
| `npm run typecheck` | **Yes** | exit 0 after fixing a compiler OOM (see F-01) |
| `npm test` (all workspaces) | **Yes** | **43 shared + 699 api + 310 web = 1,052 passing** |
| `npm run build` | **Yes** | exit 0; api 368 files, web 685 KB JS |
| Tracked-secret scan | **Yes** | `scripts/audit-secrets-scan.mjs`; `.env` never committed, in history either |
| Manual source review | **Yes** | 10 areas, §2 below |

### What was NOT done — and is not claimed anywhere

- **No penetration test.** No external tester, no adversarial engagement, no
  red-team exercise. Every finding below comes from reading code and running the project's
  own checks.
- **No legal review.** No jurisdiction-specific analysis of consent, retention, data
  residency, or data-protection obligations. **A qualified lawyer has not reviewed this
  system.**
- **No regulatory approval.** No certification, accreditation, or conformance assessment
  of any kind has been obtained or sought.
- **No clinical validation.** The record models are structurally sound and tested. They
  have **not** been validated by a clinician, and clinical correctness is not claimed.
- **No production backup restore.** No backup was taken, and no restore was attempted or
  verified. §6.3 is a *procedure to be executed*, not a record of one.
- **No load, stress or soak testing.** No performance figure in this document is measured
  under load.
- **No infrastructure provisioned.** Nothing was deployed. No cloud resource was created,
  no paid service was enabled, no production data exists.
- **No dependency licences were legally assessed.** CI runs an automated licence scan
  (`dependency-review-action`); its output was not reviewed by a lawyer.

Anyone quoting this document as evidence that the product is safe, compliant or
production-ready is misquoting it. It is a **code review plus an automated check run**, and
it found four things that must be fixed first.

---

## 1. Verdict

**Do not deploy to production.** Four findings block it, and one of them
(F-01) would have broken the build outright.

| # | Severity | Finding | Blocks deploy |
| --- | --- | --- | --- |
| F-01 | **Critical** | `tsc` exhausted the heap; typecheck had never completed | **Yes** |
| F-02 | **High** | No Content-Security-Policy or security headers on the web app | **Yes** |
| F-03 | **High** | No React error boundary anywhere in the client | **Yes** |
| F-04 | **High** | No backup, restore, or disaster-recovery procedure exists | **Yes** |
| F-05 | Medium | Audit log grows without bound; no retention policy | No |
| F-06 | Medium | 3.3 MB source map published in the production build | No |
| F-07 | Medium | Three scripts contain the demo password in source | No |
| F-08 | Medium | Two list endpoints hard-cap at 500 rows without paging | No |
| F-09 | Low | 685 KB JS, unsplit, no cache-busting guarantee reviewed | No |
| F-10 | Low | `a11y` coverage is partial and not enforced in CI | No |

Everything else audited is in good shape, and §3 records what is genuinely strong so a
reviewer does not have to re-derive it.

---

## 2. Findings

### F-01 — `tsc` exhausted the heap; `npm run typecheck` had never completed · **Critical**

**Evidence.** `npm run verify` exited **134** with:

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed -
JavaScript heap out of memory
```

Reproduced at `--max-old-space-size` of 3072, 4096, 5120, 6144 and 8192 MB — the OOM was
not a tuning problem. Bisecting the API `tsconfig` by directory and then by file:

| Probe | Result |
| --- | --- |
| `packages/shared` alone | pass, 133 MB |
| `src/config/env.ts` alone | pass |
| `src/utilities/mongo-compat.ts` alone | pass |
| `src/infrastructure/db/tenant-plugin.ts` alone | pass |
| `src/modules/subscriptions/**` alone | pass |
| `src/modules/notifications/**` alone | **OOM** |
| `src/modules/notifications/notification.models.ts` alone | **OOM** |

**Cause.** The module registered its models through a generic helper that passed an
explicit type argument to Mongoose:

```ts
function register<T>(name: string, schema: Schema): mongoose.Model<T> {
  return mongoose.models[name] ?? mongoose.model<T>(name, schema)
}
register<Record<string, unknown>>('Notification', notificationSchema)
```

`mongoose.model<T>(...)` forces TypeScript to fully instantiate `Model<T>`. `Model` has
hundreds of members, each generic, so resolving them against `Record<string, unknown>`
means resolving hundreds of generic signatures over an index-signature type. This is a
known, reproducible way to exhaust `tsc`.

**Fix applied.** Register without a type argument, matching the other seven model modules:

```ts
function register(name: string, schema: Schema): mongoose.Model<unknown> {
  const existing = mongoose.models[name] as mongoose.Model<unknown> | undefined
  return existing ?? (mongoose.model(name, schema) as unknown as mongoose.Model<unknown>)
}
```

**Result, measured after the fix:**

```
Types:      221,160
Memory used: 660,149K   (~645 MB)
```

`npm run verify` exits **0** in 527 s with 1,052 tests passing.

**Why this was Critical rather than annoying.** `npm run typecheck` was the step that
guaranteed no type error ever reached a runtime. It was not running. The ten type errors
it had been hiding are now fixed — see the commit for this review. **Any claim that this
codebase typechecks is only true from this commit onward.** Before it, the claim would have
been false, and nothing in the repository said otherwise.

### F-02 — No security headers on the web application · **High**

**Evidence.** The API sets a strict header set (`apps/api/src/app.ts:85`): CSP
`default-src 'none'`, `frame-ancestors 'none'`, `X-Content-Type-Options`, HSTS in
production. `apps/web/index.html` contains only `charset`, `viewport` and `color-scheme`.
No `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`,
`Referrer-Policy` or `Permissions-Policy` is served for the application itself. A grep for
`helmet|contentSecurityPolicy` across `apps/web` returns nothing.

The API's CSP is the correct one for a JSON service and irrelevant to the HTML document,
which is the one a browser renders.

**Risk.** Without a CSP the browser enforces no restriction on injected script. Every
other XSS control in this project — React's escaping, Zod validation, `validate()` — is a
second line of defence behind a control that is currently absent. If any rendering path
ever produces HTML (a template, a `dangerouslySetInnerHTML`, a future rich-text field), there
is nothing behind it.

**Remediation.** Serve the web build behind a reverse proxy or CDN that sets at minimum:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'; object-src 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()
```

Enable `'unsafe-inline'` for `style-src` **only if** the build requires it — Tailwind and
the charting layer often do — and prefer a nonce if it can. `connect-src 'self'` assumes
the API is same-origin via a proxy; if it is a separate origin, name it explicitly rather
than using `*`.

**Verification once deployed:** `curl -sI https://<host>/ | grep -i -E 'content-security|strict-transport'`.

### F-03 — No React error boundary in the client · **High**

**Evidence.** No error boundary exists in `apps/web`. The effect was observed directly
during this review: a single bad property read in `UnauthorizedState` produced

```
[Unhandled error] ReferenceError: homePathFor is not defined
An error occurred in the <UnauthorizedState> component.
Consider adding an error boundary to your tree.
```

and **the entire screen went blank** — no message, no recovery, no way back except a
reload.

This is not hypothetical. It happened **twice in this session**, both times from defects
that a boundary would have contained:

1. A duplicated `/platform` route resolved to a component that called `.slice()` on
   `undefined`. The entire Super Admin console rendered blank.
2. `UnauthorizedState` read `user.role` when `user` was `null`, so the 403 screen itself
   crashed.

**Risk.** In a clinical product, a blank screen is a safety problem, not a cosmetic one. A
clinician who hits a white page cannot tell a crash from a network fault, and the natural
response is to retry — or to enter the data somewhere less safe.

**Remediation.** Add a route-level boundary wrapping `AppShell` content that renders a
recoverable error state: what failed, a retry control, a link to a known-good screen, and a
correlation `requestId` the user can quote to support. Keep the boundary **above** the
guards so it also catches guard failures. Add a top-level `window.onerror` /
`unhandledrejection` reporter that logs to the API without patient data.

**Verification:** a test that renders a component which throws and asserts the recovery UI
appears rather than an empty document.

### F-04 — No backup, restore, or disaster-recovery procedure exists · **High**

**Evidence.** `docs/RUNBOOK.md` has no backup section. No backup job, script or
configuration exists anywhere in the repository. No snapshot, export or PITR policy is
defined. `MONGODB_URI` points at a single instance with no replica set, and there is no
second site.

**This is the finding that loses data.** Everything else on this list degrades a service.
This one destroys it, and it does so silently — there is no signal that recovery is
impossible until the moment it is needed.

**Remediation.** See `docs/DEPLOYMENT.md` §6 for the full checklist. The minimum before
any production data exists:

1. Continuous backup on (Atlas M10+ or equivalent) plus point-in-time restore.
2. **A restore rehearsed on a schedule**, into a scratch cluster, timed. An untested backup
   is a hypothesis.
3. Recovery objectives agreed in writing: **RPO** (how much data loss is acceptable) and
   **RTO** (how long downtime is acceptable). Neither is currently defined.
4. Private object storage with versioning and its own backup — clinical PDFs and invoices
   live outside the database.
5. Documented key management so encrypted backups can actually be decrypted in an incident.

**Blocking.** No production data should exist until a restore has been executed and timed.

### F-05 — Audit log grows without bound; no retention policy · **Medium**

**Evidence.** `apps/api/src/modules/audit/audit.model.ts:50-52` declares three indexes and
**no TTL**. The model blocks `deleteMany` (line 64) — a deliberate anti-tamper measure — and
no pruning job, archival process or retention policy exists anywhere. Other collections do
use TTL correctly (`refreshSession`, `passwordReset`, `otpChallenge`), so the omission is
specific to the audit log.

**Risk, and it is a genuine conflict.** Unbounded growth will eventually exhaust disk and
take the service down. But the anti-tamper guarantee and data-subject erasure rights pull in
opposite directions: the table cannot be edited or deleted, and a data subject's request to
be forgotten cannot be honoured in it.

**Remediation.** Decide the policy before production, not during an incident:

- Define a retention period per event class. Access and clinical events are likely to need
  materially longer than a failed sign-in.
- **Archive, don't delete.** Move aged rows to cold storage (or an archive collection)
  under a documented, audited procedure. Erasure can then be honoured in the primary table
  while the retention obligation is met by the archive.
- Keep append-only semantics for anything inside the retention window.
- Add a disk-usage alert on the audit collection specifically (§7).

### F-06 — 3.3 MB source map published in the production build · **Medium**

**Evidence.** `apps/web/vite.config.ts:33` sets `sourcemap: true` unconditionally.
`apps/web/dist/` contains `index-uUKXr04h.js.map` at **3,304 KB** against a 685 KB bundle.
The map is not referenced from `index.html` via `sourceMappingURL`, so browsers will not
auto-fetch it — but it is served by any static host that serves the directory.

**Risk.** A source map is a near-complete disclosure of application structure. It makes
reconnaissance trivial and materially weakens obfuscation-based protection (which is weak
anyway — this is TypeScript, not compiled-and-obfuscated JavaScript).

**Remediation.** Gate on environment:

```ts
sourcemap: mode !== 'production',
```

If the map is genuinely wanted in production for error monitoring, upload it to the
monitoring service at build time and **do not** publish it. A leaked map is a permanent,
undeletable disclosure.

### F-07 — Demo password committed in source · **Medium**

**Evidence.** `scripts/audit-secrets-scan.mjs` reports 8 non-fixture matches, all the same
fictional value `correct-horse-battery-staple`:

| File | Lines |
| --- | --- |
| `scripts/demo-flow.mjs` | 36, 49, 80, 145, 148 |
| `scripts/verify-hospital-admin.mjs` | 22 |
| `scripts/verify-platform-console.mjs` | 18 |
| `scripts/verify-proxy-auth.mjs` | 38 |

The test fixtures contain 24 more, which is correct — that is what a fixture is.

**Risk is low but not zero.** The value is fictional and the accounts exist only in local
databases. The concern is precedent and habit: a team that has a password in source today
has a weaker default tomorrow. A script whose entire purpose is to log in with a password is
also the script most likely to be pointed at a real environment by someone in a hurry.

**Remediation.** Read the password from an environment variable in all four scripts, and
fail with a clear message when it is absent:

```js
const PASSWORD = process.env.DEMO_PASSWORD
if (!PASSWORD) {
  console.error('Set DEMO_PASSWORD. Refusing to use a password committed to source.')
  process.exit(1)
}
```

Keep the fictional literal in **test** fixtures only, where a fixed value is the point.

### F-08 — Two list endpoints hard-cap at 500 rows · **Medium**

**Evidence.**

| File | Line | Query |
| --- | --- | --- |
| `apps/api/src/modules/appointments/appointments.service.ts` | 821 | `skip: 0, limit: 500` |
| `apps/api/src/modules/clinical/clinical.service.ts` | 301 | `skip: 0, limit: 500` |

Both are day-view / schedule queries bounded to a date range, so 500 is generous rather than
arbitrary. But the truncation is **silent** — a clinic with 600 appointments in a day gets
500 returned and no indication that 100 are missing.

**Risk.** A doctor viewing a busy day could believe they are seeing every appointment. A
missing appointment is a missed patient, not a cosmetic defect.

**Remediation.** Surface the truncation explicitly: return a `truncated: true` flag and the
true total when the cap is hit, and show a visible banner in the day view. Add a test that
a 501-appointment day reports truncation. Long term, add server-side paging to these two
endpoints like the other lists already have.

### F-09 — 685 KB unsplit JavaScript bundle · **Low**

**Evidence.** `apps/web/dist/index-uUKXr04h.js` is 685 KB uncompressed (minified), against a
`chunkSizeWarningLimit: 700` that is set just above it — the build is one kilobyte from
warning. Single entry chunk; no manual or vendor splitting.

**Risk.** Every navigation loads all of it. On a hospital network or a 3G connection this is
the difference between a usable app and a blank one, which interacts directly with F-03.

**Remediation.** Route-level `React.lazy` for the platform console, billing and clinical
modules; split vendor (`react`, `react-router`, `react-query`, `date-fns`) into a cached
chunk. Validate with Lighthouse on a throttled connection. **This has not been measured.**

### F-10 — Accessibility coverage partial and not enforced in CI · **Low**

**Evidence.** 9 of 18 web test files call `expectNoSeriousViolations` (axe). Coverage is
concentrated on shared components and a few screens; `NotificationsPage` and
`PatientConsentCard` have no axe assertion. CI (`ci.yml:54-64`) runs lint, typecheck, test
and build — **no accessibility job**, so an axe regression fails nothing if it lands on an
uncovered screen.

**Risk.** Individual screens are checked; the routes that matter most clinically are not
systematically covered, and nothing prevents that from getting worse.

**Remediation.** Add an axe assertion to every feature screen's test (this is a per-screen
change, not a framework change), then add a CI job that fails on new serious violations.
Track full WCAG 2.2 AA conformance as separate work — **it has not been assessed here**, and
automated axe checks catch perhaps a third of real issues.

---

## 3. What is genuinely strong

Recorded so a reviewer does not have to re-derive it, and because a findings-only document
reads as a worse product than this is.

| Area | Evidence |
| --- | --- |
| **Tenant isolation** | Mongoose plugin injects `hospitalId` into every filtered operation and **throws** when no tenant context is bound — there is no "no context means all tenants" path (`tenant-plugin.ts:87-104`). Platform reads require an explicit, audited `withPlatformScope()`. Asserted by a dedicated isolation suite. |
| **Credential storage** | Argon2id. No password or token literal has ever been committed; verified across all history, not just the working tree. |
| **Secrets in the environment** | `apps/api/src/config/env.ts` **refuses to boot** in production with a placeholder secret or a wildcard CORS origin, reporting every problem at once. `.env` is git-ignored and absent from history. |
| **Dependency posture** | `npm audit` → **0 vulnerabilities** across the full tree. All 20 outdated packages are minor/patch except TypeScript, which is pinned deliberately to 5.9.3. |
| **CI security scanning** | `npm audit --audit-level=high`, `dependency-review-action`, **gitleaks**, and **CodeQL** all run on every push. |
| **Error responses** | The error handler never returns a stack trace or driver message (`error-handler.ts:15`). |
| **Log redaction** | Pino applies redaction at the serializer level, so a developer cannot log a raw request without it being scrubbed (`logger.ts`). |
| **Rate limiting** | Seven tiers defined including login (10 per 15 min) and registration (5 per hour), plus a global API limit. |
| **CSRF posture** | The refresh token is `HttpOnly, SameSite=Strict` with rotation and revocation, and the access token is held in memory, not a cookie. This is the correct architecture for a bearer-token API and makes CSRF structurally inapplicable — **provided web and API are served same-origin**. See §4. |
| **Input validation** | Zod schemas on every body, query and param, `.strict()` throughout, with field errors mapped back to inputs. |
| **Money correctness** | Integer minor units, no floats, server-computed totals, explicit manual-vs-verified separation, idempotency by unique index. |
| **Test depth** | 1,052 tests. Cross-tenant access, unauthorized actions, duplicate requests, refunds and rounding are all covered by real assertions, not smoke tests. |
| **Clinical honesty** | `ARCHITECTURE.md` §9 states plainly what is *not* implemented. No compliance claim is made anywhere. |

---

## 4. Cross-cutting risks requiring a decision

Not defects. Each needs an answer from someone with authority before go-live.

### 4.1 CSRF depends on same-origin deployment

The CSRF posture in §3 holds **only if the web app and the API share an origin** (or if the
API's CORS allow-list contains only your own exact web origins *and* the refresh cookie is
`SameSite=Strict`). Deploying the frontend to `app.example.com` and the API to
`api.example.com` is cross-site: `SameSite=Strict` then prevents the cookie from being sent
at all, which breaks refresh — or, if `SameSite` is relaxed to `None` to make it work,
CSRF protection is gone and must be replaced with an explicit token or a custom header
check.

**Decision required:** pick one topology before building the deployment.
**Recommendation:** serve both behind one origin via a reverse proxy (`/api/*` → API,
`/*` → static web). It is simpler, removes CORS entirely, and keeps the current cookie
design valid.

### 4.2 Encryption at rest and in transit

TLS termination is assumed but not configured in this repository, and MongoDB client
encryption is not used. Clinical data is stored in plaintext inside the database.

**Decision required:** which layer encrypts at rest (Atlas encryption-at-rest satisfies
this; a self-managed MongoDB does not), and whether field-level encryption is required by
policy. Note that field-level encryption conflicts with server-side aggregation — the
reporting queries in Phase 8 would need redesign.

### 4.3 Multi-instance deployment breaks in-memory rate limiting

Rate limiters are in-memory. Two API instances means two independent limit buckets, so the
effective login limit **doubles**. Nothing warns about this.

**Decision required:** single instance (simplest, and adequate for an initial deployment),
or a shared store (Redis) behind `express-rate-limit`.

### 4.4 The notification sweep has no scheduler

`sweepNotifications` is an endpoint the platform calls. **Nothing calls it
automatically.** Until a scheduler exists, queued notifications never send.

This is documented in `ARCHITECTURE.md` §9, and it is a deployment dependency, not a
defect — but it must appear on the release checklist so it is not discovered in production.

---

## 5. Per-area audit summary

| # | Area | Result | Findings |
| --- | --- | --- | --- |
| 1 | Auth, sessions, authorization, isolation | **Strong** | None. Argon2id, rotation, revocation, memory-only access tokens, enforced tenant scope. |
| 2 | Validation, injection, XSS, CSRF, CORS, headers, rate limits | **Gaps** | F-02, §4.1 |
| 3 | File upload, private access, scanning, download authz | **Not applicable** | No upload surface exists. Only server-generated PDFs, private, `no-store`, `nosniff`, authorized per-request. Path traversal defended by resolve-and-prefix check. See `docs/DEPLOYMENT.md` §5.4 for what is required *before* uploads are added. |
| 4 | Secrets and environment | **Strong** | No tracked secrets; production refuses placeholders and wildcard CORS. |
| 5 | Dependency vulnerabilities | **Strong** | 0 vulnerabilities; CI scans, gitleaks and CodeQL active. 20 packages behind, all low risk. |
| 6 | Error handling and logging | **Good** | No stack traces to clients, serializer-level redaction. **F-03**: no client-side boundary. |
| 7 | Indexes, connection security, backups | **Gap** | 43 indexes declared; `ensureIndexes()` runs on boot. **F-04**: no backup or restore. |
| 8 | Audit logging and retention | **Gap** | Append-only and well-indexed, **F-05**: no retention. |
| 9 | A11y, responsive, performance, pagination | **Partial** | **F-08**, **F-09**, **F-10**. Never rendered in a real browser during development. |
| 10 | Tests, CI, build, deployment docs | **Partial** | 1,052 tests, 4-job CI, green build. `docs/DEPLOYMENT.md` written by this review. |

---

## 6. Remediation priority

### Must complete before any production deploy

1. **F-01** — ✅ **Fixed in this review.** Typecheck completes in 20 s / 645 MB.
2. **F-02** — Configure CSP, HSTS and the remaining headers at the reverse proxy.
3. **F-03** — Add a route-level error boundary with a recovery UI.
4. **F-04** — Enable backup + PITR, **execute a timed restore into a scratch cluster**, and
   agree RPO/RTO in writing.
5. **§4.1** — Choose and document the deployment topology.

### Should complete before general availability

6. **F-05** — Agree audit retention; implement archival.
7. **F-06** — Disable production source maps.
8. **F-07** — Move demo passwords to environment variables.
9. **F-08** — Surface truncation in the day view.

### Housekeeping

10. **F-09** — Code-split the bundle.
11. **F-10** — axe on every screen; CI enforcement.

---

## 7. Recommendations requiring approval

**Nothing below has been provisioned. Each needs explicit approval first, because each may
involve a paid service or a production data decision.**

| # | Recommendation | Cost | Approval needed |
| --- | --- | --- | --- |
| 1 | MongoDB Atlas M10+ with continuous backup and PITR | Paid | **Yes — paid service** |
| 2 | Private S3 bucket (or equivalent) with versioning for PDFs | Paid | **Yes — paid service** |
| 3 | Production domain + TLS certificate (ACME/Let's Encrypt is free) | Free | Yes — DNS change |
| 4 | Error monitoring (Sentry) | Free tier likely sufficient | **Yes — third-party, receives PHI-adjacent data** |
| 5 | Uptime/heartbeat monitoring | Free tier likely sufficient | Yes |
| 6 | Redis for shared rate limiting (only if multi-instance) | Paid | **Yes — paid service** |
| 7 | CDN/WAF in front of the static web build | Paid | **Yes — paid service** |

**No production data should be created until F-04 is closed and a restore has been
rehearsed.**

---

## 8. Verification record

Commands run on 14 October 2026, verbatim results:

```
npm audit --audit-level=low     → found 0 vulnerabilities
npm run lint                    → exit 0, 0 problems
npm run typecheck               → exit 0        (F-01 fixed)
npm test                        → 43 shared + 699 api + 310 web = 1,052 passed
npm run build                   → exit 0
  apps/api/dist                 → 368 files
  apps/web/dist/index-*.js      → 685 KB
  apps/web/dist/index-*.js.map  → 3,304 KB      (F-06)
node scripts/audit-secrets-scan.mjs
  → MATCHES: 32 (8 non-fixture, all fictional demo passwords — F-07)
  → .env never tracked, never present in history
tsc --diagnostics (api, after F-01 fix)
  → Types: 221,160   Memory used: 660,149K
```

CI (`.github/workflows/ci.yml`) runs: lint → typecheck → test → build, plus a security job
with `npm audit --audit-level=high`, `dependency-review-action`, **gitleaks** and
**CodeQL**.

---

## 9. Statement of limitations

This review is a **static code review and an automated check run**. It is competent at
finding what is present in the code and absent from the configuration. It cannot find a
logic flaw nobody thought to look for, a runtime-only race, or a misconfiguration in a
system that has not been built yet.

Specifically: **no penetration test was performed, no legal review was performed, no
regulatory approval was obtained, and no production backup restore was executed or
verified.** The clinical record models have not been validated by a clinician. No
performance figure has been measured under load. No infrastructure has been provisioned and
nothing has been deployed.

The four blocking findings above are real and are fixed or specified. Clearing them is
necessary for production. It is **not** sufficient to assert the product is safe, compliant
or clinically sound.