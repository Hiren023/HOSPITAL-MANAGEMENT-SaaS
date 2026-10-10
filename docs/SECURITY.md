# Security Risk Register & Threat Model

**Infinigrow Hospital Cloud** · Infinigrow Softech
Severity: **C**ritical · **H**igh · **M**edium · **L**ow

This document is the living register referenced by [`ARCHITECTURE.md`](./ARCHITECTURE.md). Each
risk records the mitigation, where it is implemented, and how it is **verified**. A mitigation
with no verification is treated as unproven.

Related: [`COMPLIANCE-NOTES.md`](./COMPLIANCE-NOTES.md) · [`RUNBOOK.md`](./RUNBOOK.md)

---

## Threat model summary

| Asset | Adversary | Primary concern |
| --- | --- | --- |
| Patient records (PHI) | Malicious or negligent insider; compromised clinician account | Tenant crossover, excessive access, silent browsing |
| Tenant separation | One hospital's user attacking another's | IDOR, `hospitalId` tampering, cache leakage between tenants |
| Credentials & sessions | External attacker; stolen device | Credential stuffing, token theft, session persistence after termination |
| Billing integrity | Insider or external attacker | Record tampering, duplicate invoices, unauthorised refunds |
| Availability | External attacker | Resource exhaustion, rate-limit bypass, report abuse |
| Audit trail | Insider covering tracks | Log tampering, PHI leakage into logs, missing records |

**Explicit non-goal:** protecting against a compromised production host, a malicious database
administrator, or an authorised insider with legitimate access and time. Those require
organisational controls (see [`COMPLIANCE-NOTES.md`](./COMPLIANCE-NOTES.md)).

---

## Risk register

### R1 — Cross-tenant data access (IDOR) · **Critical**

A clinician from Hospital A reads or writes Hospital B's patients, appointments or invoices by
substituting an identifier.

**Mitigation (three enforcing layers):**

1. `hospitalId` is derived from the verified membership, never from request input
   (`apps/api/src/infrastructure/db/tenant-context.ts`).
2. `AsyncLocalStorage` + Mongoose plugin auto-injects `hospitalId` into every tenant query and
   **throws** when no context is bound (Phase 1).
3. Controllers cannot import Mongoose models (ESLint `no-restricted-imports`).

**Behaviour:** cross-tenant access returns `404`, never `403`, so existence is not disclosed.

**Verified by:** `tenant-context.test.ts` (context plumbing, concurrent isolation, fail-closed
behaviour) now; the full isolation matrix in `apps/api/src/tests/tenant-isolation.test.ts` in
Phase 1.

---

### R2 — Client-supplied `hospitalId` or role is trusted · **Critical**

The API accepts the tenant or role from the request, so any client can claim another hospital
or escalate to admin.

**Mitigation:** tenant context and permissions are resolved server-side only. Role and
permissions are recomputed from the membership on every request — never read from the token
body without a server-side membership check (Phase 1). `resolvePermissions()` cannot exceed a
role's ceiling.

**Verified by:** `packages/shared/src/types/role.test.ts` — role ceiling, platform/hospital
separation, escalation refusal.

---

### R3 — NoSQL operator injection · **High**

An attacker submits `{"email": {"$ne": null}}` or `{"password": {"$gt": ""}}`, turning a value
match into a query-control primitive.

**Mitigation (defence in depth):**

- Zod `.strict()` schemas reject unknown keys on every route.
- `assertNoMongoOperators()` walks free-form maps (`Record<string, unknown>`) and throws on any
  key containing `$` or starting with `.`.
- `mongoose.set('sanitizeFilter', true)` and `strictQuery` are set before any model compiles
  (`apps/api/src/infrastructure/db/connection.ts`).

**Verified by:** `connection.test.ts` asserts both Mongoose globals are enabled;
`packages/shared` tests cover `assertNoMongoOperators`. Dedicated injection payloads land with
the routes in Phases 1–6.

---

### R4 — Stale authorisation after role change or termination · **High**

A user retains access until their access token expires because the token carries old claims.

**Mitigation:** access tokens are short-lived (10 minutes) **and** the membership is
re-checked server-side on each request, with a short-lived cache (≤ 60 s). Role change,
suspension or departure revokes refresh sessions immediately.

**Verified by:** Phase 1 (not yet implemented).

---

### R5 — Weak password storage and credential stuffing · **High**

**Mitigation:** Argon2id with memory-hard parameters (via `@node-rs/argon2`, prebuilt
binaries — no node-gyp). Minimum 12 characters (NIST SP 800-63B length-first policy).
Exponential backoff and lockout on repeated failures. MFA (TOTP) mandatory for
`SUPER_ADMIN` and `HOSPITAL_ADMIN`. Optional password pepper held in a secret manager.

**Verified by:** Phase 1.

---

### R6 — Token theft via cross-site scripting · **High**

A malicious script in the page steals the session token and reads patient data.

**Mitigation:** access token held in memory only (never `localStorage`); refresh token in an
`HttpOnly; Secure; SameSite=Strict` cookie unreachable from JavaScript. Strict CSP.
`dangerouslySetInnerHTML` is a **lint error** (`eslint.config.js`) — render text through JSX.
Clinical content is stored as structured data, not HTML.

**Verified by:** lint rule; `api-client.ts` sends the access token only as a `Bearer` header.

---

### R7 — CSRF against cookie-authenticated routes · **High**

A cross-origin page submits a state-changing request that the browser attaches the refresh
cookie to.

**Mitigation:** `SameSite=Strict` cookie; state-changing routes that rely on the cookie also
require a double-submit CSRF token; CORS is an explicit allowlist and cookies are not shared
across origins.

**Verified by:** Phase 1.

---

### R8 — PHI, credentials or secrets in logs · **High**

A developer logs a request or an error object and patient data reaches the log aggregator,
where it is broadly readable and long-lived.

**Mitigation (three layers):**

1. Pino redaction of `authorization`, `cookie` and 15+ credential/PHI field names.
2. Request and response serialisers emit **method, URL and status only** — bodies and headers
   are never serialised.
3. `errorHandler` logs unexpected errors server-side but returns a generic message; client
   errors are logged as a code and status.

**Verified by:** `apps/api/src/infrastructure/logger.test.ts` — asserts that a password, a
bearer token, a date of birth, a phone number and a diagnosis string are absent from the log
stream, while non-sensitive context remains for debugging.

---

### R9 — Over-broad clinical access · **High**

Reception or finance staff read consultation notes they have no clinical need to see.

**Mitigation:** `RECEPTIONIST` and `ACCOUNTANT` hold no `consultation:read` or
`prescription:read`. Billing responses use role-specific schemas that omit clinical fields
entirely — the data is not sent and then hidden. Doctors are additionally limited to their
care team (departments and assigned appointments). Every PHI access is audited.

**Verified by:** RBAC matrix tests; response-schema tests land with each module.

---

### R10 — Mass assignment · **High**

Spreading a request body into a model lets an attacker set `hospitalId`, `role` or
`isActive`.

**Mitigation:** strict Zod allowlists on every route; repository writes take an explicitly
constructed object, never `req.body`. Lint and review rules.

**Verified by:** Phase 1 onward, per route.

---

### R11 — Identifier enumeration · **Medium**

An attacker probes IDs to discover that a patient exists at another hospital.

**Mitigation:** every "does not exist" and "belongs to another tenant" case returns the same
`404 Resource not found`. Login and password-reset responses are identical for existing and
non-existing accounts, with comparable timing.

**Verified by:** `app.test.ts` asserts the not-found message; `env.test.ts` covers the
non-enumerable error vocabulary.

---

### R12 — Rate limiting bypass across instances · **Medium**

Per-instance memory limiters reset on deploy and multiply with instance count.

**Mitigation:** stricter, dedicated policies for login, registration, password reset and MFA.
Production requires a **shared** store (Redis, or Mongo) — in-memory is development-only.
Documented as a release gate in [`RUNBOOK.md`](./RUNBOOK.md).

**Verified by:** Phase 1 for auth endpoints; shared store is a Phase 8 release gate.

---

### R13 — Insecure file storage · **High**

Uploaded scans, logos and documents are publicly readable, or an attacker uploads a
dangerous file, or uses path traversal.

**Mitigation:** private buckets with public access blocked at the bucket-policy level; access
only through short-lived pre-signed URLs (≤ 5 minutes); server-generated object keys (never a
user-supplied filename); MIME, extension and magic-byte validation; strict size limits;
malware-scanning hook before a document becomes available; no static directory serving.

**Verified by:** Phase 4.

---

### R14 — Document leakage or injection · **Medium**

A PDF invoice or prescription is rendered for a user who should not see it, or injected content
appears in the generated file.

**Mitigation:** authorisation is checked **before** rendering, not at download time;
pre-signed URLs are short-lived and single-purpose; `pdfkit` text is escaped; every generation
is audited; sequential invoice numbers prevent enumeration.

**Verified by:** Phase 4 and Phase 6.

---

### R15 — Missing or mutable audit trail · **High**

An insider reads records without a trace, or deletes evidence afterwards.

**Mitigation:** `audit_logs` is append-only — **no update or delete route exists at any level**.
Entries record actor, role, action, resource type and id, timestamp, IP, user agent and
request id. They store field *names* of what changed, never PHI *values*. Separate retention
policy, and integrity verification in the runbook.

**Verified by:** Phase 1; a CI test asserts no mutating route references the audit model.

---

### R16 — Data loss and unrecoverable backups · **High**

No working backups, or backups that have never been restore-tested.

**Mitigation:** MongoDB Atlas continuous cloud backup and point-in-time restore on a paid tier
(free M0 provides neither). Restore drill rehearsed on a schedule and recorded in the runbook.

**Verified by:** Phase 8 release gate.

---

### R17 — Supply-chain compromise · **Medium**

A compromised or malicious dependency executes in the build or at runtime.

**Mitigation:** committed lockfile and `npm ci` in CI; Dependabot; `npm audit --audit-level=high`
and dependency review as gating jobs; minimal dependency surface; new dependencies require
review; gitleaks secret scanning; CodeQL analysis.

**Verified by:** CI workflow `.github/workflows/ci.yml`.

---

### R18 — Over-broad CORS and missing headers · **Medium**

**Mitigation:** explicit origin allowlist read from validated configuration; wildcard refused
in production; `helmet` with an API-appropriate CSP; HSTS in production only;
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`;
`x-powered-by` disabled.

**Verified by:** `app.test.ts` (headers present, framework not disclosed); `env.test.ts`
(production refuses wildcard and localhost origins).

---

### R19 — Development data reaching production · **Medium**

Synthetic seed records, or a staging connection string, ends up in a production deployment.

**Mitigation:** the seeder refuses to run unless `NODE_ENV=development` **and** an explicit
`--i-am-in-dev` flag is supplied. The environment validator refuses a production boot with
placeholder values, wildcard CORS or debug logging. CI runs the production configuration
checks.

**Verified by:** Phase 1 (seeder guard), CI for configuration.

---

### R20 — Misconfiguration and weak defaults · **Low**

**Mitigation:** Zod-validated environment that **fails fast** and reports every problem at
once, rather than one per restart. Safe development defaults; explicit production overrides for
`LOG_LEVEL`, `ENABLE_API_DOCS`, `CORS_ORIGINS`, `MONGODB_URI`, `TRUST_PROXY`.

**Verified by:** `apps/api/src/config/env.test.ts` — including the trap where the string
`"false"` must parse as `false`, not `true`, since truthiness would silently disable security
controls.

---

### R21 — Workspace path contains spaces · **Low**

`C:\HOSPITAL MANAGEMENT SaaS` — Docker bind mounts, some shell scripts and CI path handling
can misbehave.

**Mitigation:** `scripts/check-workspace-path.ts` warns on every install and **fails** in CI
(`--strict`). Verified working for Node, npm, Vite, Vitest and Git in Phase 0. Renaming to
`C:\dev\infinigrow-hospital-cloud` remains the recommended option.

**Verified by:** the script itself, plus Phase 0 execution on this machine.

---

## Secure development lifecycle

| Stage | Control |
| --- | --- |
| Authoring | Strict TypeScript (`noUncheckedIndexedAccess`, no `any`), lint rules that encode architecture |
| Review | Mandatory review for auth, tenant-scope and permission changes |
| Pre-merge | `lint → typecheck → test → build` plus audit, dependency review, gitleaks, CodeQL |
| Release | Phase 8 checklist: restore drill, header audit, pen-test findings triaged |
| Operations | Runbook, alerting on auth anomalies, documented incident and breach procedure |

## Security testing plan

| Test | Phase | Status |
| --- | --- | --- |
| Logger redaction of credentials and PHI | 0 | **Implemented** |
| Environment refuses unsafe production settings | 0 | **Implemented** |
| Security headers and CORS allowlist | 0 | **Implemented** |
| Error handler leaks no internals | 0 | **Implemented** |
| RBAC least-privilege and escalation refusal | 0 | **Implemented** |
| Tenant context fail-closed and concurrent isolation | 0 | **Implemented** |
| NoSQL injection payloads against every route | 1–6 | Planned |
| Tenant isolation matrix (every endpoint × two hospitals) | 1–6 | Planned |
| Mass-assignment attempts on every write route | 1–6 | Planned |
| Token rotation and reuse detection | 1 | Planned |
| Rate-limit exhaustion | 1 | Planned |
| File upload and signed-URL tests | 4 | Planned |
| Dependency and container scanning | 8 | Planned |
| External penetration test | 8 | Planned (requires a paid resource — approval required) |