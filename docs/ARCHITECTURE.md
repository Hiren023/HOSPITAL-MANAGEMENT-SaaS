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
| Billing, payments, reports, notifications for hospitals | Phase 9–10 — **not implemented** |
| Hospital-level audit browsing | Phase 8 — **not implemented**. The trail is written and readable at `/platform/audit` only; a hospital administrator cannot yet browse their own hospital's trail |
| Patient portal, pharmacy, ABDM/ABHA | Phase 12+ — **not implemented** |
| Clinical validity of the record models | **Not claimed.** Structurally sound and tested; not clinically validated, and no compliance claim is made anywhere in this repository |
| Payment gateway, invoicing, proration, auto-suspension | Deliberately out of scope — plan assignment only |
| Email delivery (password reset, invitations) | Not implemented. Staff accounts set their own password on first sign-in |
| OpenAPI spec generation from Zod | Phase 1 (library choice to confirm) |
| Dockerfiles, deployment pipeline | Phase 11 |
| Backup and restore automation | Phase 11 |

Navigation entries for unimplemented modules render an explicit "not yet" placeholder
rather than a blank screen, and no menu item points at data the API cannot supply.