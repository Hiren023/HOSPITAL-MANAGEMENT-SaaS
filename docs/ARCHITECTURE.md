# Architecture

**Infinigrow Hospital Cloud** · maintained by Infinigrow Softech · last updated during Phase 0.

This document expands sections 3–8 of [`PROJECT_PROPOSAL.md`](./PROJECT_PROPOSAL.md) into the
concrete decisions actually implemented. Everything described here is verified by the test
suite unless explicitly marked as *planned*.

---

## 1. Repository layout

An npm workspaces monorepo with three packages:

| Package | Path | Purpose |
| --- | --- | --- |
| `@infinigrow/shared` | `packages/shared` | Types, Zod schemas, RBAC matrix, API envelope, error codes, limits |
| `@infinigrow/api` | `apps/api` | Express 5 REST API |
| `@infinigrow/web` | `apps/web` | React 19 single-page application |

`shared` is consumed by both applications so that a permission, an error code or a validation
rule is defined exactly once. It compiles to `dist/` and is imported as a real dependency;
there is no path-alias trickery between workspaces.

---

## 2. Layering (enforced, not merely documented)

```
HTTP route / middleware
        ↓
     controller        ← knows req/res, nothing else
        ↓
      service          ← business logic; receives validated input + RequestContext
        ↓
    repository         ← THE ONLY PLACE raw Mongoose queries are allowed
        ↓
     Mongoose model
```

Two lint rules protect this boundary:

| Rule | Location | Effect |
| --- | --- | --- |
| `no-restricted-imports` on `mongoose` | `eslint.config.js` | Only files under `apps/api/src/infrastructure/**` may import `mongoose` |
| `no-restricted-imports` on `**/infrastructure/db/models/*` | `eslint.config.js` | Only repositories may import a Mongoose model |

Services never read `hospitalId` from request input. They receive a `RequestContext` built by
middleware, which is the single source of tenant identity.

---

## 3. Tenant isolation

This is the highest-severity concern in the product and is designed in three enforcing layers.

### 3.1 Tenant context is derived, never supplied

> `hospitalId` is **never** read from a request body, query string or path parameter.

`RequestContext` is constructed in middleware from the verified membership and exposed through
`AsyncLocalStorage` (`apps/api/src/infrastructure/db/tenant-context.ts`):

```ts
export interface RequestContext {
  requestId: string
  userId: UserId
  membershipId: MembershipId
  role: Role
  hospitalId: HospitalId   // ← from the verified membership, never from input
  permissions: ReadonlySet<Permission>
  ip: string
  userAgent: string
}
```

A client-supplied `hospitalId` is ignored and recorded. Switching tenant is only possible
through an explicit endpoint that validates an **active membership** (Phase 1).

### 3.2 Platform scope is an explicit, narrow opt-in

Platform operations (tenant approval, plan management) run without a hospital scope. A
`PlatformContext` has no `hospitalId` field at all, so `getTenantContext()` returns `null` and
any attempt to touch tenant data fails loudly rather than silently succeeding.

### 3.3 Storage-level enforcement (Phase 1)

A Mongoose plugin registered on every tenant-scoped schema will:

1. **inject** `{ hospitalId: ctx.hospitalId }` into every query filter, and
2. **throw** when a tenant-scoped query executes with no tenant context bound.

The plumbing — `AsyncLocalStorage`, `requireTenantContext()`, concurrent-context isolation —
is implemented and tested in Phase 0. The plugin itself lands in Phase 1.

**Aggregations need the id as an `ObjectId`, not a string.** A `Query` casts string ids
for typed paths, but an aggregation is handed to the driver as-is, so
`{ $match: { hospitalId: '6acb…' } }` silently matches nothing. The failure is total and
silent: the query succeeds and returns an empty result, indistinguishable from an empty
table. The plugin's `aggregate` hook therefore builds a real `ObjectId` and throws on one
it cannot parse, rather than quietly matching nothing.

### 3.3.1 Where the tenant boundary is applied (Phase 5)

Hospital administration is the first route family that runs entirely inside an implicit
tenant context, and it establishes the pattern the rest will follow:

- The router is **module-private**. Routes are registered only through a `tenantRoute()`
  helper that prepends `authenticate` and `requireTenantScope`, so a route cannot be added
  without the boundary.
- The middleware is deliberately **not** applied with `router.use()`. A router mounted at
  the API root runs `router.use` middleware for every path that enters it — including
  paths matching no route — which turned the tenant gate into a global one on `/api/v1/*`:
  unknown paths answered `401` instead of `404`, and `requireTenantScope` rejected
  `SUPER_ADMIN` before `/platform/*` was reached. Wrapping the routes rather than the
  router keeps the guarantee without widening the blast radius.
- **No `hospitalId` is accepted anywhere** on these routes, in any path, query or body.
  A `.strict()` schema rejects one outright rather than ignoring it, so the failure is
  visible instead of silent.

### 3.4 HTTP semantics

Accessing a resource that belongs to another tenant returns **404 `NOT_FOUND`**, not 403
`FORBIDDEN`. The message is a fixed string (`Resource not found`), so the API never confirms
that an identifier exists somewhere else. See [`SECURITY.md`](./SECURITY.md) R11.

---

### 3.5 Double booking is decided by the database (Phase 6)

MongoDB has no time-range exclusion constraint, so "is this doctor free between 09:00 and
09:20?" cannot be expressed as an index over a start and an end. What it *can* express is
uniqueness over a tuple.

Occupied time is therefore materialised: one `AppointmentSlot` row per booked slot, with a
unique index on `{ hospitalId, doctorUserId, slotStart }`. Booking inserts those rows, and
a duplicate-key error **is** the conflict.

This is not an optimisation over an application check. Check-then-insert has a race window
between the two statements: two receptionists booking 09:00 simultaneously both read "free",
both write, and the second silently duplicates. A unique index has no such window, because
the constraint is evaluated by the thing doing the writing, no matter how many application
instances are running.

The slot grid also makes partial overlaps fall out correctly. A 40-minute appointment
occupies three 20-minute slots, so an 11:20 booking collides with an 11:00 one without any
interval arithmetic anywhere.

**This only works if the index exists.** `mongoose.connect` is called with `autoIndex:
false`, on the reasoning that index builds should be an explicit, verifiable step rather
than a side effect of boot. That reasoning is sound, but the explicit step was missing:
`connection.ts` referred to a migration runner that was never written, so the database
carried only its `_id` index and *every unique constraint in the schema was absent*, in
development and in production alike. Phase 5 did not notice because its duplicate tests
relied on application-level lookups; Phase 6 could not, which is how it surfaced.
`infrastructure/db/indexes.ts` now performs that step on boot, and the test harness calls
it so constraint tests exercise the real thing rather than a fiction of it.

### 3.6 Self-scoping is a permission, not a role name

A doctor may read and write their OWN appointments. Only a holder of `appointment:read:any`
or `appointment:write:any` may see or move anyone else's. That is enforced in the service,
on the query and on the target row.

Modelling it as permissions rather than a role-name check keeps "self only" inside the same
mechanism as every other authorisation decision, and means a future role that should see the
whole clinic is granted that explicitly rather than having it inferred from its name.
Reception and administration hold `:any`; a doctor deliberately does not.

### 3.7 Time is instants, never strings (Phase 6)

Appointments store UTC instants. Weekday and time-of-day are derived at read time in the
hospital's configured IANA zone and never stored alongside, because a second copy is a
second source of truth that drifts the first time a hospital changes timezone.

The API refuses a bare local time and requires an explicit offset. A wall-clock reading does
not identify a moment, and around a DST transition some local times do not exist at all.
The full policy, including the two `Intl` traps this had to handle, is in
[`TIMEZONE.md`](./TIMEZONE.md).

### 3.8 Signed clinical records are amended, never rewritten (Phase 7)

A consultation is a `DRAFT` or a `FINALIZED` record. A draft is a clinician's own scratch
work and edits in place. Finalizing seals it, and from that moment `PATCH` requires a
written `amendmentReason` and appends an immutable entry to `amendments[]` carrying the
**before** value, the **after** value, who changed it, when, and why.

Keeping `before` is the part that matters. An amendment that recorded only the new text
would be indistinguishable, a year later, from an ordinary edit — and a clinical record that
can be quietly rewritten is not evidence of what anyone believed at the time. The server
refuses a silent edit with `409`; the UI hides the editor on a sealed record and offers the
amendment path instead, so a clinician is never told "you cannot do this" after writing a
careful paragraph.

There is deliberately no "un-finalize". Un-sealing a signed record looks exactly like never
having signed it.

### 3.9 Generated documents are private by construction (Phase 7)

A prescription PDF is stored under an opaque key and referenced by that key, never by a URL.
Three alternatives were rejected explicitly:

- **A public URL** is readable by anyone who has it, forever, including people who should
  never have seen the patient.
- **An "unguessable" public path** is not access control. A 128-bit filename leaks through a
  shared link, a browser history, a proxy log or a screenshot, and none of those can be
  revoked.
- **A signed URL as the primary mechanism** expires, but until it does it has the same
  problem, and it moves the authorization decision out of the application where it can be
  audited.

So the only way out is `GET /prescriptions/:id/document`, which re-checks permission on the
underlying prescription *at the moment of download* and responds `private, no-store` with
`nosniff`. Revoking someone's access takes effect on their next request. The wire format
carries a boolean (`documentAvailable`) precisely so there is nothing addressable to leak.
`file-store.ts` is an interface with a local-disk implementation, so object storage can
replace it without touching a route.

The PDF itself is written by hand rather than by a library — one document type does not
justify the dependency, and the only subtlety is the cross-reference table's byte offsets.
The test asserts `%PDF-`, `startxref` and `%%EOF` are present, which proves the bytes are
genuinely a PDF rather than merely starting with the right four characters.

### 3.10 Nothing here generates a clinical value (Phase 7)

There is no endpoint that infers, suggests, summarises or completes a diagnosis, an
assessment or a medication. This is a scope decision, recorded here because it is the kind
of thing that erodes without anyone deciding to change it: the patient schema has no
clinical field at all and `.strict()` refuses an unexpected key, the consultation schema has
no `suggestedDiagnosis`, and every medicine on a prescription requires a clinician-supplied
dose, route and frequency.

A test asserts that no suggestion-shaped route exists. It is a weak test — it will not catch
a route named something unexpected — but it fails loudly the day somebody adds one, which is
more than nothing.

The models are structurally sound and covered by tests. **They have not been clinically
validated, and nothing in this repository is a claim of regulatory compliance or clinical
safety assurance.** Deploying this for real clinical use requires independent clinical and
regulatory review, which is not something code or a test suite can establish.

### 3.11 Attendance corrections are a workflow, and so is the API surface (Phase 7)

An attendance record is evidence of where a person was, so it cannot be adjustable by the
person it describes. There is no `PATCH` on the resource. A change is *requested* with a
reason and applied only by a holder of `attendance:approve`, who cannot decide their own
request. Both values are kept afterwards, so the record shows what was claimed and what was
authorised — the same principle as a clinical amendment, applied to time.

Two supporting decisions:

- **Check-in accepts no timestamp.** The server clock is the only source. One record per
  person per day is enforced by a unique index rather than a lookup, for the same
  check-then-insert race reason as the appointment slot grid.
- **Self-service and team views are separate resources.** `/attendance/me` and
  `/attendance`. A single route with a `userId` filter would have meant a caller who omitted
  the filter got their own records while believing they had the team's — a report that looks
  authoritative and is wrong about everyone but one person. Separate resources put the scope
  in the URL where it cannot be misread.

### 3.12 Money is integers, and the client cannot send a total (Phase 8)

Every amount is an integer count of the currency's minor unit. `0.1 + 0.2` is
`0.30000000000000004`, and a patient overcharged by four ten-thousandths of a rupee cannot
dispute it. Every amount is validated as a safe integer before it reaches the database.

Rounding is half away from zero, applied once per line, and the invoice total is the exact sum
of the already-rounded line totals. That is not an implementation detail — it is what makes a
printed invoice add up to itself. Recomputing a total from unrounded lines and rounding again
produces a figure that disagrees with its own arithmetic by a paisa.

A request carries line items and **nothing else**. There is no field in which a client's
arithmetic could arrive, so the strongest form of "never trust the frontend's total" is
making it unrepresentable: a schema that *accepted* a total and overwrote it would invite
someone to "fix" a discrepancy by using the client's value.

Full rules, and the accounting assumptions that need a qualified review, are in
[`MONEY.md`](./MONEY.md).

### 3.13 Manual money is not verified money (Phase 8)

Every payment carries `source` (who says it happened: a person, or a provider) and
`verification` (whether that has been confirmed). They are constrained: `MANUAL` is always
`UNVERIFIED`, because no system confirmed it and calling it anything else would be dishonest;
`GATEWAY` starts `PENDING` and only becomes `VERIFIED` through an explicit call that names who
performed it.

**Revenue reports do not return one total.** They return the amount by verification status.
Summing them would present an unreconciled provider claim as cash, and a receivables report
built on that number would be wrong in the direction that *hides money* — which is the
failure mode a financial report should be most careful about, not least.

The same split survives CSV export. A spreadsheet that collapsed it would reintroduce exactly
the misreading the report avoids, one download later.

### 3.14 Idempotency by unique index, not by check-then-insert (Phase 8)

`POST /payments` honours an `Idempotency-Key`, enforced by a unique index rather than a
lookup. Check-then-insert has a race window, and "two reception desks press the button at the
same moment" is a real situation rather than a theoretical one: both requests read "no such
key", both insert, and one customer is charged twice.

The index makes the loser come back as a replay instead. A pre-check exists only to give a
clearer answer, never as the guarantee. The same key with a *different* payload is a `409`:
silently replaying would confirm money that was never taken.

### 3.15 Issued invoices are voided, not edited or deleted (Phase 8)

An issued invoice is a document somebody has been handed. Editing it in place would mean the
copy they hold no longer matches the system, so the only correction is **void with a recorded
reason** and a fresh invoice. Voiding is refused while any payment exists against it, because
that would leave the payment pointing at nothing.

A voided invoice stays in the ledger. The money may already have been reported on, and
deleting the document would make a previously-true report false retroactively. This is the
same principle as amendments on a sealed clinical record, applied to money.

Refunds are **new** payments referencing what they reverse, never mutations, and cannot
exceed what was taken.

### 3.16 CSV export is an attack surface (Phase 8)

A value beginning `=`, `+`, `-` or `@` is prefixed with a tab before it is written, and a
UTF-8 BOM is emitted so Excel opens the file correctly. Without the first, opening an export
in a spreadsheet **executes** a patient name that happens to begin with `=` — which is how CSV
exports become an injection path rather than a data export. Commas, quotes and newlines are
quoted so a name with a comma does not shift every column after it.

Every export is audited. An export is the easiest way to take data out of the system in bulk,
so "someone exported the revenue report" should be an event you can answer for.

### 3.17 An entitlement is not a permission (Phase 9)

A **permission** says who you are. An **entitlement** says what this hospital bought.
They are separate types, separately enforced, and deliberately not conflated.

Conflating them would mean a plan purchase could grant clinical access, and a role change
could silently remove billing. Neither should be reachable by a commercial decision, so
`entitlements` lives in the shared plan catalogue and **no request ever carries one**.

A tenant administrator cannot renew, upgrade, suspend or un-suspend itself. The tenant
side of the subscription API is read-only. The only payment state a tenant can reach is
the one it already has — the same rule Phase 8 applies to an invoice, lifted one level up.

### 3.18 The entitlement gate fails closed, and lives in the registrar (Phase 9)

A missing subscription, an unreadable one, or a module key outside the union all **DENY**.
There is no code path that allows access it cannot positively prove, which is the property
that makes this safe to put in front of a paid-for module.

The check is applied by `createTenantRouter({ module })`, not written on each route.
Listing `requireModule('BILLING')` on 30 billing routes would work right up until somebody
adds a 31st and forgets — and the failure is silent, because a missing gate looks exactly
like a working route until a tenant on the Starter plan reaches it. Making the gate a
property of the *router* means a new route cannot skip it, and there is no list of handlers
to keep in sync.

It stays inside `route()` rather than becoming `router.use(...)` for the same reason the
registrar exists at all: `router.use` also runs for paths that match no route, which would
turn a `404` into a `403` and leak the fact that a module exists.

Write methods additionally require a writable subscription, derived from the HTTP method so
a new `POST` route is write-gated without anyone remembering. There are no side-effecting
`GET`s in this API; if one is ever added it needs a documented exception, not a silent hole.

### 3.19 Suspension stops writes, never reads, and never deletes (Phase 9)

`SUSPENDED` blocks every write and blocks **no reads**. `EXPIRED` and `CANCELLED` block
both, because the subscription has genuinely ended and the tenant should be told to renew
rather than left browsing a stale copy.

The asymmetry is the point. A hospital in a billing dispute must be able to look at its own
patients, its own stock and its own books. A suspended tenant with an unreadable patient
list is a patient-safety problem, not a billing one — and suspending must never be
indistinguishable from losing the data.

**No code path in this module deletes a tenant's records.** Suspension changes an access
decision and nothing else. That is asserted by a test that counts records before and after
a suspension cycle.

The tenant subscription screen and the entitlements endpoint are deliberately **outside**
the gate, because they are the screen that explains why the gate closed. Gating them would
return `403 renewal required` from the page that shows the renewal date.

### 3.20 Status is derived from dates, never typed in by hand (Phase 9)

Trial expiry, overdue and suspension are all consequences of `trialEndsAt`,
`currentPeriodEndsAt`, `gracePeriodEndsAt` and `paymentState`. `deriveStatus()` computes
them, so a stored status can never disagree with the dates that justify it — which is
otherwise the first question asked after a billing dispute.

Two rules follow:

- **A sweep only advances.** `SUSPENDED`, `EXPIRED` and `CANCELLED` are terminal until a
  person acts, so a sweep must not quietly un-suspend a cancelled tenant.
- **`evaluate()` is idempotent.** It is invoked from a sweep, from a platform button and
  by an operator refreshing the page, and an endpoint that behaved differently on its
  second call would be impossible to reason about during an incident.

Reactivating clears the suspension but deliberately does **not** restore `ACTIVE`: the
tenant goes to `PAST_DUE` and runs its own grace period, because somebody still has to
confirm money arrived. **Un-suspending is not paying.**

### 3.21 Nothing in the payment adapter can report success (Phase 9)

`PaymentProvider` has no method that returns `VERIFIED`. `confirmCheckout` may return
`PENDING` or `FAILED` and nothing else. `VERIFIED` is reachable only through the
reconciliation route, which is a person pressing a button after looking at a bank
statement.

This is the Phase 8 rule — a `MANUAL` invoice payment is always `UNVERIFIED` — stated once
and enforced twice, because one rule is easier to keep honest than two invented separately.
A provider saying "paid" is a claim, not a fact, and a system that treats a claim as cash
inherits the lie into every downstream report.

The interface assertion is a test, not a convention: if somebody adds `markPaid()` returning
`'VERIFIED'`, the structural test fails at the point of addition rather than one release
later once somebody writes the adapter.

### 3.22 Usage is counted, not cached (Phase 9)

`seatLimit` and `departmentLimit` were in `PLAN_DEFINITIONS` from Phase 4 and were only ever
**displayed** — nothing counted anything. Both are now enforced server-side, with a message
naming the limit and the current count, because "limit reached" tells a hospital
administrator nothing about what to do next. Both checks run before any write, so an
over-limit request creates no orphaned user record.

Usage started as a stored `UsageCounter` collection written on plan assignment and was
removed. A counter has to be updated on **every** path that changes what it counts — new
staff, deleted staff, a deactivated membership, a role change, a reactivation. Miss one and
the cache disagrees with reality, and the screen says "3 of 3 seats" while four people hold
seats. Two indexed `countDocuments` calls on one screen is not a performance problem; a
usage figure that can be wrong is worse than a slightly slow one, because it is presented
with the same confidence either way.

Enforcement is a check in the service, **not** an atomic database decrement. This differs
deliberately from the Phase 6 slot grid and the Phase 8 medicine stock, where two
simultaneous requests genuinely race for the same unit. Exceeding a seat limit by one seat
is a commercial overshoot, not a safety or financial event, and the alternative — a
`$gte` conditional decrement on a membership row — would make "deactivate a staff member"
and "free a seat" the same operation. The distinction is recorded here because the three
cases look identical until you ask what happens when both requests succeed.

## 4. Authorisation

### 4.1 Roles

`SUPER_ADMIN`, `HOSPITAL_ADMIN`, `DOCTOR`, `RECEPTIONIST`, `STAFF`, `PHARMACIST`,
`ACCOUNTANT`, `PATIENT`.

### 4.2 Permissions

`resource:action` strings declared as a TypeScript union, mapped to roles by
`ROLE_PERMISSIONS` in `packages/shared/src/types/role.ts`.

**Least-privilege properties, each covered by a test:**

- `SUPER_ADMIN` holds **only** `platform:*` permissions. A SaaS operator can approve and
  suspend tenants but has **no default access to patient clinical data**.
- `RECEPTIONIST` has no `consultation:read` or `prescription:read`.
- `ACCOUNTANT` has no `consultation:read` or `prescription:read`.
- `STAFF` defaults to attendance and notifications only.

### 4.3 Per-hospital grants

A hospital may grant a **subset** of a role's permissions to a membership.
`resolvePermissions(role, grants)` only ever *narrows* the role's ceiling: unknown permission
strings are ignored, and platform permissions can never be granted to a hospital role.

### 4.4 Where authorisation is enforced

The API is the authority. The web app imports the same matrix to decide what to *render*, so
UI and server cannot disagree — but hiding a control is never treated as access control.

Intra-tenant rules (care-team scope for doctors, field-level scoping for accountants) are
enforced by **role-specific response schemas**, never by the frontend hiding fields.

---

## 5. API conventions

- **Base path:** `/api/v1`. Probes live outside versioning at `/health` and `/health/ready`.
- **Versioning:** breaking changes require `/api/v2`; deprecated routes announce a
  `Deprecation` and `Sunset` header before removal.
- **Content type:** `application/json` in and out.

### 5.1 Response envelope

```jsonc
// success
{ "success": true, "data": { }, "meta": { "requestId": "…" } }

// error
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [ { "path": "email", "message": "Must be a valid email address" } ],
    "requestId": "…"
  }
}
```

The web client unwraps this envelope, so application code never handles envelopes directly.

### 5.2 Error codes

`VALIDATION_ERROR` (422), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`CONFLICT` (409), `TENANT_SCOPE_REQUIRED` (403), `RATE_LIMITED` (429), `ACCOUNT_LOCKED` (423),
`MFA_REQUIRED` (401), `PAYLOAD_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415),
`SERVICE_UNAVAILABLE` (503), `INTERNAL_ERROR` (500).

Clients branch on `code`, never on `message`.

### 5.3 Pagination

- **Cursor** (default for clinical and audit lists): `?cursor=&limit=`, `limit` ≤ 100.
- **Offset** (admin tables that genuinely need totals): `?page=&pageSize=`.

Opaque cursors are encoded and decoded by `utilities/pagination.ts`. A cursor is
base64url-encoded JSON, **not encrypted**, so it must never carry PHI — it is a
client-held token. A malformed or future-versioned cursor decodes to `null` (start from
the beginning) rather than raising a 500.

### 5.4 Errors never leak internals

`errorHandler` translates known error shapes (Zod, Mongoose `ValidationError`, `CastError`,
duplicate key `11000`, body-parser) into the envelope. Anything unrecognised becomes a generic
`INTERNAL_ERROR` with the message *"An unexpected error occurred"*. Stack traces and driver
messages are logged server-side, keyed by `requestId`, and never returned.

---

## 6. Data model (design)

| Collection | Purpose | Critical indexes |
| --- | --- | --- |
| `hospitals` | Tenant | `{ slug: 1 }` unique, `{ status: 1, createdAt: -1 }` |
| `users` | Global identity | `{ email: 1 }` unique (lowercased), `{ phone: 1 }` sparse unique |
| `memberships` | User ↔ Hospital ↔ Role | `{ hospitalId: 1, userId: 1 }` unique, `{ hospitalId: 1, role: 1, status: 1 }` |
| `refresh_sessions` | Token rotation and revocation | `{ userId: 1, revokedAt: 1 }`, `{ familyId: 1 }` |
| `password_resets` | Recovery | `{ tokenHash: 1 }` unique, TTL on `expiresAt` |
| `departments` | Clinical org | `{ hospitalId: 1, code: 1 }` unique |
| `doctor_profiles` | Doctor details | `{ hospitalId: 1, userId: 1 }` unique |
| `staff_profiles` | Staff details | `{ hospitalId: 1, userId: 1 }` unique |
| `patients` | Patient master | `{ hospitalId: 1, uhid: 1 }` unique, `{ hospitalId: 1, status: 1, createdAt: -1 }` |
| `appointments` | Scheduling | `{ hospitalId: 1, doctorId: 1, startAt: 1 }`, partial-unique to prevent double-booking |
| `consultations` | Clinical notes | `{ hospitalId: 1, patientId: 1, createdAt: -1 }` |
| `prescriptions` | Medication orders | `{ hospitalId: 1, consultationId: 1 }` |
| `attendance` | Staff attendance | `{ hospitalId: 1, userId: 1, date: 1 }` unique |
| `invoices` | Billing | `{ hospitalId: 1, number: 1 }` unique |
| `payments` | Receipts | `{ hospitalId: 1, invoiceId: 1, receivedAt: -1 }` |
| `notifications` | In-app | `{ hospitalId: 1, userId: 1, readAt: 1, createdAt: -1 }` |
| `audit_logs` | Append-only trail | `{ hospitalId: 1, createdAt: -1 }`, `{ actorUserId: 1, createdAt: -1 }` |

Every tenant-scoped collection leads with `hospitalId`. Indexes are created by an idempotent
migration runner in the background, never implicitly on boot.

### 6.1 Double-booking prevention

```js
{ hospitalId: 1, doctorId: 1, startAt: 1 },
{ unique: true, partialFilterExpression: { status: { $in: ['BOOKED', 'CHECKED_IN'] } } }
```

The database is the final authority; the API reports `409 CONFLICT`.

---

## 7. Frontend architecture

| Concern | Choice |
| --- | --- |
| Build | Vite 8 |
| UI | React 19 + Tailwind CSS 4 (CSS-first `@theme` tokens) |
| Routing | React Router 7 data router |
| Server state | TanStack Query 5 |
| HTTP | Typed `ApiClient` unwrapping the shared envelope |
| Styling | `cn()` (clsx + tailwind-merge), CVA variants |

**Tenant-keyed caching.** Every query key begins with the active `hospitalId`, so switching
tenants cannot surface cached data belonging to another hospital.

**Retry policy.** Client errors (4xx) are never retried — they will fail identically and, on a
rate-limited endpoint, retrying wastes quota.

**Mandatory UI states.** Every data view implements loading, empty, error-with-retry and
success. See `components/states/`.

**Accessibility.** Native elements throughout, visible focus rings, skip link, landmarks,
`aria-live` status regions, and `axe-core` assertions in tests.

---

## 8. Cross-cutting concerns

| Concern | Implementation |
| --- | --- |
| Validation | Zod schemas shared between client and server; `.strict()` rejects unknown keys. Enforced by `validation/validate.ts`, which also rejects MongoDB operators before parsing (`docs/SECURITY.md` R3, R10) |
| NoSQL injection | `sanitizeFilter`, `strictQuery`, `assertNoMongoOperators()` for free-form maps |
| Logging | Pino, JSON, mandatory header and field redaction (asserted by tests) |
| Correlation | `X-Request-Id` generated or sanitised-client-supplied, echoed on every response |
| Errors | Single `errorHandler`, operational vs bug distinction, no stack leakage |
| Rate limiting | `express-rate-limit`, per-route policies (auth much stricter than reads) |
| Security headers | `helmet` with an API-appropriate CSP, HSTS in production only |
| CORS | Explicit allowlist from environment; wildcard refused in production |
| Graceful shutdown | SIGTERM/SIGINT stop the listener, close Mongo, then exit |
| Configuration | Zod-validated environment that refuses unsafe production settings |

---

## 9. What is *not* implemented yet

Being explicit so nothing is mistaken for a working feature:

| Area | Status |
| --- | --- |
| Notifications (module A), pharmacy (module B) | Specifications written and awaiting approval — `docs/specs/`. **Not implemented** |
| Billing, payments, reports | Phase 8 — **implemented and tested** |
| Subscriptions, entitlements, plan limits | Phase 9 — **implemented and tested**. No payment gateway: `VERIFIED` is a human reconciliation, and no adapter can set it |
| Recurring subscription billing, proration, dunning | Deliberately out of scope. No provider is wired, and wiring one requires a security review (`docs/SECURITY.md` R16) |
| Automatic status sweep | `evaluate()` and its endpoint exist; **no scheduler runs them.** A status change happens when someone opens the console, not on a timer |
| Hospital-level audit browsing | Phase 8 — **not implemented**. The trail is written and readable at `/platform/audit` only; a hospital administrator cannot yet browse their own hospital's trail |
| Patient portal, ABDM/ABHA | Phase 12+ — **not implemented** |
| Clinical validity of the record models | **Not claimed.** Structurally sound and tested; not clinically validated, and no compliance claim is made anywhere in this repository |
| Email delivery (password reset, invitations) | Not implemented. Staff accounts set their own password on first sign-in |
| OpenAPI spec generation from Zod | Phase 1 (library choice to confirm) |
| Dockerfiles, deployment pipeline | Phase 11 |
| Backup and restore automation | Phase 11 |

Navigation entries for unimplemented modules render an explicit "not yet" placeholder
rather than a blank screen, and no menu item points at data the API cannot supply.