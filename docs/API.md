# API Guide

**Infinigrow Hospital Cloud API** · Infinigrow Softech

Current version: **v1** · base path `/api/v1`

> **Status (Phase 0):** the API currently exposes health probes and a capability
> discovery endpoint. Authentication and all domain routes arrive in Phase 1. Nothing
> below describes an unimplemented endpoint as if it existed.

---

## Conventions

### Base paths

| Path | Purpose |
| --- | --- |
| `/` | Product metadata |
| `/health` | Liveness probe — process is running (does **not** touch the database) |
| `/health/ready` | Readiness probe — 503 when a dependency is unavailable |
| `/api/v1` | Versioned product API |
| `/api/v1/docs` | OpenAPI explorer *(Phase 1; disabled in production)* |

Liveness and readiness are intentionally separate: a database outage should not cause an
orchestrator to kill a healthy process.

### Response envelope

Success:

```json
{
  "success": true,
  "data": { "status": "ok", "service": "infinigrow-hospital-cloud-api" },
  "meta": { "requestId": "3f2a…" }
}
```

Failure:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [ { "path": "email", "message": "Must be a valid email address" } ],
    "requestId": "3f2a…"
  }
}
```

### Correlation

Every request carries an `X-Request-Id`. The server generates one when absent, echoes it
in the response, and includes it in every log line. A client-supplied id is honoured only
when it matches `^[A-Za-z0-9_-]{8,128}$`; anything else is replaced — an unvalidated id
would permit log forging and header injection.

Quote this id in a support ticket.

### Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 422 | Request failed schema validation |
| `UNAUTHENTICATED` | 401 | Missing, expired or invalid credentials |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `NOT_FOUND` | 404 | Absent, **or** belongs to another hospital |
| `CONFLICT` | 409 | Duplicate unique value (UHID, invoice number, double booking) |
| `TENANT_SCOPE_REQUIRED` | 403 | A tenant-scoped operation ran with no hospital context |
| `RATE_LIMITED` | 429 | Too many requests |
| `ACCOUNT_LOCKED` | 423 | Temporarily locked after repeated failures |
| `MFA_REQUIRED` | 401 | Second factor needed |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeds the configured limit |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Unsupported content encoding |
| `SERVICE_UNAVAILABLE` | 503 | A dependency is unavailable |
| `INTERNAL_ERROR` | 500 | Unexpected fault — details logged, never returned |

**Clients must branch on `code`, never on `message`.** Messages may be reworded or
localised; codes are stable.

> `NOT_FOUND` is returned both when a resource does not exist **and** when it belongs to
> another hospital. The message is the fixed string `Resource not found`, so the API never
> confirms that an identifier exists elsewhere.

### Authentication endpoints

Full design and trade-offs: [`AUTH.md`](./AUTH.md).

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/auth/login` | — | Sign in; sets the refresh cookie |
| `POST` | `/api/v1/auth/refresh` | refresh cookie | Rotate the token pair |
| `POST` | `/api/v1/auth/logout` | refresh cookie | Revoke the token family (idempotent) |
| `GET` | `/api/v1/auth/me` | Bearer | Current identity, resolved from the membership |
| `POST` | `/api/v1/auth/forgot-password` | — | Send a reset OTP; response is always identical |
| `POST` | `/api/v1/auth/reset-password` | — | Complete a reset with the OTP |

### Platform endpoints (SUPER_ADMIN only)

All under `/api/v1/platform/*` and gated by `requirePlatformPermission`.

| Method | Path | Required permission | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/platform/hospitals` | — (rate limited) | Register a hospital; created `PENDING`. The **only** unauthenticated route under `/platform/*` |
| `GET` | `/api/v1/platform/overview` | `platform:hospital:read` | Tenant and account metrics. Aggregate counts only — no clinical data |
| `GET` | `/api/v1/platform/hospitals` | `platform:hospital:read` | List tenants. **Server-side** `page`, `pageSize`, `q`, `status`, `plan`, `sort` |
| `GET` | `/api/v1/platform/hospitals/:hospitalId` | `platform:hospital:read` | Tenant detail. Recorded in the audit trail as `hospital.viewed` |
| `GET` | `/api/v1/platform/hospitals/:hospitalId/users` | `platform:user:manage` | Staff accounts at one tenant |
| `POST` | `/api/v1/platform/hospitals/:hospitalId/approve` | `platform:hospital:approve` | Activate a tenant and its administrator |
| `POST` | `/api/v1/platform/hospitals/:hospitalId/suspend` | `platform:hospital:suspend` | Suspend a tenant. `reason` is **required** (10–500 chars) |
| `POST` | `/api/v1/platform/hospitals/:hospitalId/reactivate` | `platform:hospital:suspend` | Restore a suspended tenant |
| `PUT` | `/api/v1/platform/hospitals/:hospitalId/plan` | `platform:plan:manage` | Assign a subscription plan. Assignment only — no payment |
| `PATCH` | `/api/v1/platform/users/:userId/status` | `platform:user:manage` | Activate or suspend an account **globally**. `reason` required; self-change refused |
| `GET` | `/api/v1/platform/audit` | `platform:audit:read` | Audit trail. Cursor-paginated, strictly filtered, redacted on read |
| `GET` | `/api/v1/platform/reports/operational` | `platform:report:read` | Operational report. `days` (1–365, default 30) |

Every route except public registration applies both `authenticate` and
`requirePlatformPermission`, applied at the router level so a new endpoint inherits the
boundary by construction.

**No platform route returns patient data.** The overview and reports count `hospitals`,
`users` and `memberships` only, and no permission anywhere in the product grants a
`SUPER_ADMIN` access to clinical records (`SECURITY.md` R14).

Platform routes live in one router under one prefix so a `SUPER_ADMIN` capability cannot
be added at an unexpected path, and a hospital role can never reach one.

### Hospital administration endpoints

Tenant-scoped: a hospital membership only. A `SUPER_ADMIN` is refused every route here
with `403`, because a platform operator has no hospital to administer.

| Method | Path | Required permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/hospital` | `hospital:read` | This hospital's own profile |
| `PATCH` | `/api/v1/hospital` | `hospital:write` | Edit name, registration number, contact details, address |
| `PATCH` | `/api/v1/hospital/settings` | `hospital:settings:manage` | Operational defaults. Separate from the profile on purpose |
| `GET` | `/api/v1/departments` | `department:read` | List. **Server-side** `page`, `pageSize`, `q`, `isActive` |
| `POST` | `/api/v1/departments` | `department:write` | Create. `name` and `code` unique **within this hospital** |
| `GET` | `/api/v1/departments/:departmentId` | `department:read` | One department |
| `PATCH` | `/api/v1/departments/:departmentId` | `department:write` | Rename, describe, deactivate |
| `GET` | `/api/v1/doctors` | `doctor:read` | List doctor profiles |
| `POST` | `/api/v1/doctors` | `doctor:write` | Attach a profile to an existing `DOCTOR` account |
| `GET` | `/api/v1/doctors/:profileId` | `doctor:read` | One profile, including its weekly schedule |
| `PATCH` | `/api/v1/doctors/:profileId` | `doctor:write` | Professional details |
| `GET` | `/api/v1/doctors/:profileId/schedule` | `schedule:read` | Weekly schedule |
| `PUT` | `/api/v1/doctors/:profileId/schedule` | `schedule:write` | **Replace** the week. Not a merge |
| `GET` | `/api/v1/staff` | `user:read` | Staff accounts. `page`, `pageSize`, `q`, `role`, `membershipStatus` |
| `POST` | `/api/v1/staff` | `user:write` | Create an account. `SUPER_ADMIN` and `PATIENT` are refused |
| `PATCH` | `/api/v1/staff/:userId/role` | `user:permissions:manage` | Change role. Explicit grants are capped at the role's ceiling |
| `PATCH` | `/api/v1/staff/:userId/status` | `user:permissions:manage` | Activate or suspend. `reason` required |

Every route applies `authenticate` and `requireTenantScope` before it runs, injected by
the route registrar rather than repeated per handler — so a new route cannot be added
without the boundary. There is deliberately **no `hospitalId` in any path, query or
body**: the hospital is whatever the signed session says it is, so there is no
identifier for a caller to tamper with.

Three things worth knowing about these endpoints:

- **A doctor profile is attached to a staff account, not created with one.** Identity and
  professional record are separate documents, so suspending access never destroys a
  registration number.
- **`registrationNumber` is masked** for callers without `doctor:write`. It is never
  searchable and never written to the audit trail. The response carries
  `registrationNumberMasked: true` so a client can say *why* it is showing a mask rather
  than rendering a blank.
- **Schedule times are minutes from midnight**, not `HH:mm` strings and not dates.
  Ordering, overlap and midnight-crossing checks are then exact, and no timezone is
  involved — a hospital's working day is local.

### Patient endpoints

Tenant-scoped. `patient:read` to read, `patient:write` to create and change.

| Method | Path | Required permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/patients` | `patient:read` | Search. **Server-side** `page`, `pageSize`, `q`, `gender`, `isActive`, `patientNumber`, `phone` |
| `POST` | `/api/v1/patients` | `patient:write` | Register. The patient number is allocated by the server |
| `POST` | `/api/v1/patients/duplicate-check` | `patient:write` | Possible duplicates for a partial form. A **warning**, never a block |
| `GET` | `/api/v1/patients/:patientId` | `patient:read` | One patient |
| `PATCH` | `/api/v1/patients/:patientId` | `patient:write` | Update, or deactivate |

**Data minimisation, enforced server-side.** A caller holding `patient:read` but not
`patient:write` receives demographics only: `phone`, `email`, `address` and
`emergencyContact` are `null`, and `contactVisible` is `false` so a client can say *why*
rather than rendering a blank that looks like missing data. That is the `ACCOUNTANT`
configuration: billing staff who can attach a charge to the right person without holding a
register of who they live with and who to telephone in an emergency.

No clinical field exists on the schema - no allergies, notes or diagnosis - and `.strict()`
refuses unknown keys, so clinical content cannot be smuggled in through an unexpected field.
That belongs to the consultation module.

**Patient numbers are unique per hospital, never globally.** Two hospitals each hand out
`PT-000001`. A global constraint would turn a duplicate-key error into a side channel
revealing one tenant's register size to every other.

### Appointment endpoints

Tenant-scoped. `appointment:read` / `appointment:write` mean **my own** appointments; the
`:any` variants mean the whole clinic. A doctor holds only the plain pair; reception and
administration hold `:any`, because booking on behalf of other doctors is their job.

| Method | Path | Required permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/appointments/day` | `appointment:read` | One **hospital-local** day. `date`, `doctorUserId`, `departmentId` |
| `GET` | `/api/v1/appointments/availability` | `appointment:read` | Free slots as ISO instants, per doctor |
| `GET` | `/api/v1/appointments` | `appointment:read` | List. `page`, `status`, `doctorUserId`, `patientId`, `from`, `to` |
| `POST` | `/api/v1/appointments` | `appointment:write` | Book |
| `GET` | `/api/v1/appointments/:appointmentId` | `appointment:read` | One appointment, with its full status history |
| `PATCH` | `/api/v1/appointments/:appointmentId/reschedule` | `appointment:write` | Move it. `reason` required |
| `POST` | `/api/v1/appointments/:appointmentId/cancel` | `appointment:write` | Cancel and free the slot. `reason` required |
| `PATCH` | `/api/v1/appointments/working-hours` | `hospital:settings:manage` | Opening hours by weekday. `null` means closed |

**Times are ISO 8601 instants with an explicit offset.** A bare `"2026-10-11T09:00:00"` is
refused, with a message showing what to send instead. See [`TIMEZONE.md`](./TIMEZONE.md)
for the full policy.

Cancelling is a `POST`, not a `DELETE`. Cancelling is not removal: the appointment stays,
its status history keeps every transition, and the slot is released so someone else can
book it.

**Double booking is prevented by the database.** Occupied time is materialised as one
`AppointmentSlot` row per booked slot, unique on `{hospitalId, doctorUserId, slotStart}`.
A duplicate-key error *is* the conflict; see [`ARCHITECTURE.md`](./ARCHITECTURE.md) for why
an application-level check is not sufficient.

### Clinical endpoints

Tenant-scoped. `consultation:read` / `consultation:write` mean **my own records**; the
`:any` variants mean every clinician's in this hospital. A doctor does not hold `:any` by
default. `prescription:*` follow the same clinical split.

| Method | Path | Required permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/consultations/queue` | `consultation:read` | The clinician's day. `date` is the **hospital-local** calendar day |
| `GET` | `/api/v1/consultations` | `consultation:read` | List. `patientId`, `appointmentId`, `doctorUserId`, `status`, `from`, `to` |
| `POST` | `/api/v1/consultations` | `consultation:write` | Create a **draft** |
| `GET` | `/api/v1/consultations/:id` | `consultation:read` | One record, with its amendments and prescriptions |
| `PATCH` | `/api/v1/consultations/:id` | `consultation:write` | Edit. A **draft** edits in place; a **finalized** record requires `amendmentReason` |
| `POST` | `/api/v1/consultations/:id/finalize` | `consultation:write` | Seal it. One-way. Requires `attestation: true` |
| `GET` | `/api/v1/patients/:id/clinical-summary` | `consultation:read` | Authorized history, scoped to what the caller may read |
| `POST` | `/api/v1/prescriptions` | `prescription:write` | Draft against a **finalized** consultation |
| `GET` | `/api/v1/prescriptions/:id` | `prescription:read` | One prescription |
| `POST` | `/api/v1/prescriptions/:id/issue` | `prescription:write` | Seal it and generate the PDF. Requires `attestation: true` |
| `GET` | `/api/v1/prescriptions/:id/document` | `prescription:read` | **Authorized** download of the generated PDF |

**Nothing here generates anything.** There is no endpoint that infers, suggests, summarises
or completes a clinical value. Every field on a consultation and every medicine on a
prescription was authored by a person, and the API records who. The patient schema has no
clinical field at all, and `.strict()` refuses an unexpected key — so `diagnosis` cannot be
smuggled in through a property nobody thought to model.

**A finalized consultation is never overwritten.** `PATCH` on one returns `409` without an
`amendmentReason`; with one, the change is appended to `amendments[]` carrying the **before**
and **after** values, who, when and why. The original wording stays readable. There is no
`un-finalize` — un-sealing a signed record is indistinguishable, to anyone reading the
history, from never having signed it.

**`dose`, `route` and `frequency` are required on every prescribed item.** This is a
completeness check, not a safety judgement — nothing in this codebase can assess whether a
drug is appropriate for a patient, and nothing tries. What it prevents is a drug name
reaching a patient with no dose or no route, which is not a prescription at all.

**Documents are not addresses.** `GET .../document` is the only route through which those
bytes leave the system. It re-checks permission on the underlying prescription at the moment
of download and responds `Cache-Control: private, no-store` with `nosniff`. A prescription
payload carries a boolean (`documentAvailable`), never a URL or a storage key — a URL is a
capability that outlives the authorization decision behind it.

The generated PDF names its prescriber, states on its face that it is a clinician-authored
document, and carries the hospital reference. Verify clinically before dispensing.

### Attendance endpoints

Tenant-scoped. `attendance:read` / `attendance:write` are **self-scoped**; `:any` reaches the
whole team; `attendance:approve` is the authority that decides a correction. Only a hospital
administrator holds `:any` by default.

| Method | Path | Required permission | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/attendance/check-in` | `attendance:write` | Record arrival. **Takes no body** |
| `POST` | `/api/v1/attendance/check-out` | `attendance:write` | Record departure. **Takes no body** |
| `GET` | `/api/v1/attendance/me` | `attendance:read` | My own records |
| `GET` | `/api/v1/attendance` | `attendance:read:any` | The team for a `workDate` |
| `POST` | `/api/v1/attendance/:id/correction-requests` | `attendance:write` | Ask for a change. Does **not** change the record |
| `POST` | `/api/v1/attendance/:id/correction-requests/:decision/decision` | `attendance:approve` | `approve` or `reject` a pending correction |

**Check-in takes no timestamp.** The server clock is the only source; a client able to state
its own arrival time could claim an eight-hour shift by setting a device back. One record
per person per day is enforced by a **unique index**, not a lookup — check-then-insert has a
race window that two reception desks would lose.

**Corrections are a workflow, not an edit.** There is no `PATCH` on an attendance record,
deliberately: a time that can be adjusted by the person it describes proves nothing. A
correction is *requested* with a reason (min 10 characters) and applied only by a holder of
`attendance:approve`, who cannot decide their own request. Both the original and the
requested value stay on the record afterwards. A rejection changes nothing, including the
status — marking a rejected record `CORRECTED` would claim a change happened when none did.

`workDate` is the hospital's **local** calendar day. A night shift belongs to the local day,
and deriving that from a UTC timestamp would put it on the wrong day for anyone not on UTC.

### Billing endpoints

Tenant-scoped. `billing:read` to look, `billing:write` to charge. Payment recording needs
`payment:write` — deliberately a **different permission**, so a role can raise an invoice
without being able to record that it was paid. Conflating them would mean anyone who can
bill can write off a balance by marking it settled.

Every amount is an integer count of the currency's minor unit (`*Minor`, e.g. `50000` =
₹500.00). See [`MONEY.md`](./MONEY.md) for the rounding rules and for the accounting
assumptions that need professional review.

| Method | Path | Required permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/services` | `billing:read` | The catalogue. `q`, `category`, `isActive` |
| `POST` | `/api/v1/services` | `billing:write` | Add a priced service |
| `PATCH` | `/api/v1/services/:serviceId` | `billing:write` | Change price, tax or active flag |
| `GET` | `/api/v1/invoices` | `billing:read` | List. `patientId`, `status`, `from`, `to` |
| `POST` | `/api/v1/invoices` | `billing:write` | Create a **draft** from line items |
| `GET` | `/api/v1/invoices/:invoiceId` | `billing:read` | One invoice, with its payments and balance |
| `POST` | `/api/v1/invoices/:invoiceId/issue` | `billing:write` | Seal it. One-way |
| `POST` | `/api/v1/invoices/:invoiceId/void` | `billing:write` | Void with a reason. Refused while money is on it |
| `GET` | `/api/v1/invoices/:invoiceId/document` | `billing:read` | **Authorized** PDF download |
| `GET` | `/api/v1/payments` | `payment:read` | List. `invoiceId`, `patientId`, `method`, `source`, `verification`, `from`, `to` |
| `POST` | `/api/v1/payments` | `payment:write` | Record a payment or refund. Honours `Idempotency-Key` |
| `POST` | `/api/v1/payments/:paymentId/verify` | `payment:write` | Mark a gateway payment reconciled |

**A client cannot send a total.** No request schema has a field for one. `.strict()` refuses
it with `422`. The server recomputes every figure from the lines, and there is nothing here
that could be mistaken for a total the client believes in.

**No payment credential is accepted or stored.** There is no `cardNumber`, `cvv`, `expiry`,
`pan` or `accountNumber` field; sending one is a `422`. `reference` carries a receipt number,
UPI reference or cheque number.

**`Idempotency-Key` makes a retry safe.** First request `201` with `replayed: false`; the same
key with the same payload `200` with `replayed: true` and the original payment; the same key
with a *different* payload `409`, because silently replaying would confirm money that was
never taken. Backed by a unique index, so it holds under concurrency.

**`source` and `verification` are separate facts.** A `MANUAL` payment is always `UNVERIFIED` —
a person asserted it and no system confirmed it. A `GATEWAY` payment starts `PENDING` and only
becomes `VERIFIED` through the explicit verify call, which names who did it.

### Report endpoints

Two permission tiers, deliberately.

| Method | Path | Required permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/reports/revenue` | **`report:financial`** | Revenue, split by verification status |
| `GET` | `/api/v1/reports/revenue.csv` | **`report:financial`** | The same, as CSV |
| `GET` | `/api/v1/reports/appointments` | `report:read` | Counts by status, attendance and no-show rates |
| `GET` | `/api/v1/reports/appointments.csv` | `report:read` | As CSV |
| `GET` | `/api/v1/reports/attendance` | `report:read` | Days and hours per person |
| `GET` | `/api/v1/reports/attendance.csv` | `report:read` | As CSV |

A doctor holds `report:read` but **not** `report:financial`, and must not be able to derive a
hospital's turnover from operational data and arithmetic. That is the distinction the pair
exists for: operational facts about time are not facts about money.

Revenue returns `from`, `to`, `granularity` (`daily` | `monthly`) and a `series` with one
bucket per period. Buckets are generated for the whole range, so a day with no takings is
still a row — a missing day reads as "no data" when it should read as "nothing taken".

**Revenue never returns a single total.** It returns `manualTotalMinor`,
`verifiedGatewayTotalMinor`, `pendingGatewayTotalMinor`, `refundedMinor` and a
`settledTotalMinor` that is the sum of the first two less refunds. Collapsing them would
present an unreconciled provider claim as money in hand.

Buckets follow the **hospital's local calendar day** (`settings.timezone`), not UTC, so a
day's takings stay in one column.

**CSV export neutralises spreadsheet formulas.** A value beginning `=`, `+`, `-` or `@` is
prefixed with a tab, and a UTF-8 BOM is written so Excel opens it correctly. Without the
first, opening an export executes a formula — which is how CSV exports become an attack path.
Every export is recorded in the audit trail.

### Tenant scoping

> `hospitalId` is **never** read from a request. It is resolved from the caller's active
> membership on every request.

- A `hospitalId` in a query, body or path is ignored.
- A `hospitalId` field in a body is **rejected outright** by the `.strict()` schema.
- Accessing another tenant's record returns `404`, never `403`.
- Every platform operation is recorded as `access.platform_scope_used` in the audit log.

### Security headers

### CORS

The origin must appear in `CORS_ORIGINS`. Unlisted origins are rejected with `403`.
Requests without an `Origin` header (server-to-server, health checks) are allowed.
Credentials are not shared across origins — authentication uses a `Bearer` token plus an
`HttpOnly` cookie, not a cross-origin cookie.

### Pagination

| Style | Parameters | Use for |
| --- | --- | --- |
| Cursor | `?cursor=<opaque>&limit=<1..100>` | Clinical and audit listings (default) |
| Offset | `?page=1&pageSize=<1..100>` | Admin tables needing a total count |

### Rate limits

| Route class | Window | Limit |
| --- | --- | --- |
| Login | 15 min | 10 |
| Registration | 1 h | 5 |
| Password reset | 1 h | 5 |
| MFA verification | 15 min | 10 |
| General API | 1 min | 300 |
| File upload | 15 min | 30 |

`RateLimit-*` headers are sent. Development uses an in-memory store; **production requires
a shared store** across instances (see [`SECURITY.md`](./SECURITY.md) R12).

---

## Current endpoints

### `GET /`

```json
{
  "success": true,
  "data": {
    "product": "Infinigrow Hospital Cloud",
    "vendor": "Infinigrow Softech",
    "tagline": "Ideas grow without limits",
    "apiVersion": "0.1.0-phase0",
    "apiBasePath": "/api/v1",
    "documentation": "/api/v1/docs"
  }
}
```

### `GET /health`

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "infinigrow-hospital-cloud-api",
    "version": "0.1.0-phase0",
    "uptimeSeconds": 42,
    "timestamp": "2026-10-09T19:54:55.581Z"
  }
}
```

### `GET /health/ready`

Returns `200` when the database answers a ping, `503` otherwise. Use this for load
balancer and container readiness; use `/health` for liveness.

### `GET /api/v1`

Capability discovery. Returns the live error-code vocabulary and role matrix so client
generators and integration tests assert against the running service rather than a
duplicated copy that can drift.

---

## Planned surface (Phase 9+)

Listed for planning only — **not implemented**: `/auth/switch-hospital`, `/billing`,
`/payments`, `/reports`.

Delivered so far: `/auth`, `/platform`, hospital administration, `/patients`,
`/appointments`, `/consultations`, `/prescriptions`, `/attendance`.

---

## Versioning policy

- Additive changes (new optional fields, new endpoints) ship within the current version.
- Breaking changes require `/api/v2`; the previous version runs in parallel for a stated
  window.
- Deprecated endpoints announce `Deprecation` and `Sunset` headers before removal.