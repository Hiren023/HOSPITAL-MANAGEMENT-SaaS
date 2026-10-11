# Creating the first Super Admin, securely

A `SUPER_ADMIN` is the SaaS operator: it can approve, suspend and inspect **every**
hospital on the platform. It holds `platform:*` permissions and, by design, has **no
hospital membership** — the API will not let a platform role see a single patient's
record, but it can see every tenant, every staff account and the whole audit trail.

That asymmetry is why provisioning one is deliberately awkward. There is no public
endpoint that can create it, no default account, and no password anywhere in this
repository.

---

## 1. Why there is no endpoint

The tempting design is `POST /platform/super-admins` behind a bootstrap token. It is
wrong for a specific reason: a registration path that mints platform operators is a
registration path that anyone who finds it can walk. Public hospital registration works
precisely because a new hospital is harmless until a human approves it. A platform
operator is not harmless — it can suspend a hospital and lock its staff out of their own
records.

So the first operator is created **offline, by someone who already has server access**.
Server access is the capability. There is no way to escalate from the network.

---

## 2. The procedure

### Step 1 — generate signing keys

```bash
node scripts/generate-jwt-keys.mjs
```

Paste the output into `.env`. The private key is a signing key for the entire platform:
anyone holding it can mint tokens for any user, including a `SUPER_ADMIN`. It belongs in
a secret manager in production, never in the repository.

### Step 2 — create the operator, offline

```bash
cd apps/api
npx tsx src/scripts/bootstrap-super-admin.ts \
  --email you@yourcompany.example \
  --name "Your Name" \
  --password "$SUPER_ADMIN_PASSWORD" \
  --i-am-secure
```

The script **refuses to run** when `NODE_ENV=production`. Provisioning a production
operator is an audited runbook procedure with human review — see §4.

### Step 3 — verify

```bash
npm run demo:flow
npm run verify:proxy-auth
```

`verify:proxy-auth` exercises the exact request path a browser uses, including the
refresh cookie, and confirms a bad token is rejected.

### Step 4 — do not use that password

The password above is a bootstrap credential. Rotate it before the account is used
anywhere real. There is no self-service password change yet — Phase 4 adds
platform-initiated account status control, and password rotation for operators is on the
list for Phase 5.

---

## 3. Why each guard exists

| Guard | What it prevents |
| --- | --- |
| `NODE_ENV=production` refusal | A production operator being created from a laptop, where the SSH session and the shell history are not under your control. |
| `--i-am-secure` flag | An operator created by a command that looks like every other command in a deploy script, run accidentally by someone who never read this page. |
| 12-character minimum | A short password on the account that can suspend every customer. |
| Refuses to overwrite | A `--password` typo silently replacing a working operator and locking everyone out of the console. |
| Never printed | The password is not echoed, not logged, and not written to the audit trail. |

The script writes an audit entry — `membership.created` with the note *"First platform
administrator created"* — so the account's origin is recorded in the same trail as every
other change.

---

## 4. Production provisioning

In production, do **not** run the bootstrap script. Instead:

1. Provision the operator from a controlled workstation, connected to a production
   **read-write** connection only for the duration.
2. Have a second person verify the email address and the intended permissions.
3. Record the provisioning in your change-management system before you start.
4. Rotate the bootstrap password immediately after first sign-in.
5. Store the JWT signing key in your secret manager, not in an environment file on disk.

Two operators is the minimum sensible number. One operator means a single lost password
ends tenant administration until an engineer intervenes.

---

## 5. Adding more operators after bootstrap

There is no self-service path yet, and that is on purpose for now. Until Phase 5 ships
one, each additional operator goes through the same offline script. Run it with
`--i-am-secure`, from a controlled workstation, and never with a shared password.

**Never** promote an existing hospital account to platform scope by editing the database.
`platformRole` on the user document is the flag `login` reads to recognise a platform
operator, and hand-editing it bypasses every control described above. It also leaves no
audit trail, which is exactly what an audit trail exists to prevent.

---

## 6. Verifying the boundary yourself

The tests in `apps/api/src/tests/platform.test.ts` prove the boundary from the API side,
and `apps/web/src/features/platform/platform-console.test.tsx` proves it from the browser
side. Both assert that every platform route returns **403** — not 404, not 200 — to a
hospital administrator, a doctor and an anonymous caller.

To check by hand:

```bash
# 1. Sign in as a hospital administrator, then try the platform area.
#    Expected: "Access restricted", and the browser makes no request to /api/v1/platform/*.
# 2. Sign in as the operator and open /platform.
#    Expected: the console loads.
# 3. Sign out, then browse to /platform/hospitals.
#    Expected: the sign-in screen, not an empty console that looks like "no hospitals exist".
```

Step 3 matters more than it looks. An anonymous visitor landing on an empty console
would read it as "the platform has no customers", which is both wrong and alarming during
an incident.