# Infinigrow Hospital Cloud — Architecture & Implementation Proposal

**Product:** Infinigrow Hospital Cloud (by Infinigrow Softech)
**Tagline:** *Ideas grow without limits*
**Document status:** PROPOSAL — nothing has been implemented yet. Awaiting approval.
**Date:** 2026-10-10
**Version:** 0.1

> This document proposes architecture, a security model, an implementation plan, and the
> initial folder structure. Per instruction, no source code has been written yet.
> **No feature described here has been implemented or tested.**

---

## 1. Repository inspection

| Check | Result |
| --- | --- |
| Workspace `C:\HOSPITAL MANAGEMENT SaaS` | **Completely empty** (0 entries) |
| Existing source code | None |
| Git repository | **Not initialised** (Git 2.54.0 is available) |
| `.env`, credentials, existing config | None |

The repository is a greenfield project. Nothing exists to preserve or migrate.

### 1.1 Local environment (verified)

| Tool | Status |
| --- | --- |
| Node.js | `v24.19.0` — LTS line, suitable |
| npm | `11.6.2` |
| Git | `2.54.0.windows.1` |
| Docker | **Not installed** |
| Local `mongod` | **Not installed** |

**Consequence:** local development cannot rely on `docker-compose` or a locally installed
MongoDB server. Two viable paths (decision required, see §17):

- **Atlas shared dev cluster** (free M0) over TLS — matches production topology. Recommended.
- **`mongodb-memory-server`** for automated tests (spawns an ephemeral `mongod`), and an
  Atlas free cluster only for manual dev runs.

**Constraint:** the workspace path contains spaces (`C:\HOSPITAL MANAGEMENT SaaS`). Most of
our toolchain handles this, but it is a known friction point for Docker bind mounts, some
shell scripts, and CI path handling. Renaming to `C:\dev\infinigrow-hospital-cloud` is
recommended (§17, Q2).

---

## 2. Assumptions (stated before implementation, per rule 18)

| # | Assumption | Risk if wrong |
| --- | --- | --- |
| A1 | Single MongoDB Atlas cluster, shared collections with a `hospitalId` discriminator (§6.3) | If a customer demands physical database separation, a database-per-tenant strategy is needed — architecturally supported, but schema and migration work changes |
| A2 | MVP targets clinics → large multispecialty hospitals, so scale + indexing design matters from day one | Low |
| A3 | Currency is INR; default timezone `Asia/Kolkata`; dates stored UTC, rendered tenant-local | Low |
| A4 | No lab, pharmacy inventory, insurance/TPA claims, or bed/IPD management in MVP | Low |
| A5 | Email is required for password reset and staff invitations in Phase 1 | Medium — blocks Phase 1 if no SMTP/transactional email provider is chosen |
| A6 | Patient portal (PATIENT role) is post-MVP, but the schema must not preclude it | Low |
| A7 | Password hashing uses **Argon2id** | Low |
| A8 | Deployment target is a managed container platform with managed MongoDB Atlas | Medium — affects CI/CD and secret management in Phase 8 |

---

## 3. Target architecture

```
                        ┌──────────────────────────────────────┐
   Browser / Desktop    │  apps/web  (React 19 + Vite + TS)    │
   ────────────────────▶│  Landing · Auth · Super Admin        │
                        │  Hospital Admin · Doctor · etc.      │
                        └───────────────┬──────────────────────┘
                                        │ HTTPS / JSON (Bearer access token)
                                        ▼
                        ┌──────────────────────────────────────┐
                        │  apps/api  (Express 5 + TS)          │
                        │                                      │
                        │  ┌────────────────────────────────┐  │
                        │  │ Middleware chain               │  │
                        │  │ helmet · cors · rate-limit    │  │
                        │  │ requestId · zod validation    │  │
                        │  │ authenticate → tenantScope    │  │
                        │  │ → authorize(permission)       │  │
                        │  └────────────────────────────────┘  │
                        │  ┌────────────────────────────────┐  │
                        │  │ Controllers → Services         │  │
                        │  │   (business logic, no req/res) │  │
                        │  └────────────────────────────────┘  │
                        │  ┌────────────────────────────────┐  │
                        │  │ Repositories (tenant-scoped)   │  │
                        │  │ Mongoose models + indexes      │  │
                        │  └────────────────────────────────┘  │
                        │  ┌────────────────────────────────┐  │
                        │  │ Adapters                       │  │
                        │  │ ObjectStorage · Email · PDF    │  │
                        │  │ Notification · Audit           │  │
                        │  └────────────────────────────────┘  │
                        └───────┬───────────────┬──────────────┘
                                │               │
                    ┌───────────▼──────┐  ┌─────▼──────────────┐
                    │ MongoDB Atlas    │  │ Private Object     │
                    │ TLS + encryption │  │ Storage (S3 / R2)  │
                    │ at rest + backups│  │ signed URLs only   │
                    └──────────────────┘  └────────────────────┘

   Cross-cutting: packages/shared (types + Zod schemas + RBAC matrix + API contract)
```

### 3.1 Layering rules (enforced by review + ESLint boundaries)

```
route/middleware  →  controller  →  service  →  repository  →  Mongoose model
```

- **Controllers** never touch `req`/`res` inside services; services receive validated,
  typed input plus a `RequestContext`. This makes services unit-testable and keeps
  authorisation concerns in one place.
- **Repositories** are the *only* place raw Mongoose queries are allowed. Controllers
  importing a Mongoose `Model` directly is an ESLint error.
- **Services** never read `hospitalId` from request input (see §6.2).

---

## 4. Repository / folder structure

npm workspaces monorepo. Rationale: a SaaS product's single largest recurring source of
bugs is *contract drift* between frontend and backend. Sharing types and validation schemas
from one package eliminates an entire bug class.

```
C:\dev\infinigrow-hospital-cloud\
│
├── package.json                     # workspaces, root scripts, engines
├── package-lock.json                # committed; reproducible installs
├── tsconfig.base.json               # strict compiler options
├── .editorconfig
├── .gitignore                       # includes .env, *.local, coverage
├── .env.example                     # committed template, NO real values
├── README.md
├── LICENSE
│
├── .github/workflows/
│   ├── ci.yml                       # lint · typecheck · test · build · scan
│   └── codeql.yml
│
├── docs/
│   ├── PROJECT_PROPOSAL.md          # this document
│   ├── ARCHITECTURE.md              # §3–§6 expanded in Phase 0
│   ├── SECURITY.md                  # risk register + threat model
│   ├── API.md                       # OpenAPI usage + versioning policy
│   ├── RUNBOOK.md                   # deploy, rollback, backup restore drill
│   └── COMPLIANCE-NOTES.md          # DPDP considerations, NOT a legal opinion
│
├── packages/
│   └── shared/
│       ├── package.json
│       └── src/
│           ├── index.ts
│           ├── types/               # branded Ids, Role, Permission unions
│           ├── schemas/             # Zod: request/response DTOs (single source)
│           ├── rbac/                # ROLE_PERMISSIONS matrix, can() helpers
│           ├── constants/           # enums, status values, limits
│           └── api/                 # envelope + error-code union + endpoint paths
│
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile               # multi-stage, non-root, distroless
│   │   └── src/
│   │       ├── index.ts             # bootstrap: config → db → app → listen
│   │       ├── app.ts               # express app assembly (no listen — testable)
│   │       ├── config/
│   │       │   ├── env.ts           # Zod-validated env, fail-fast on bad config
│   │       │   └── constants.ts
│   │       ├── infrastructure/
│   │       │   ├── db/
│   │       │   │   ├── connection.ts
│   │       │   │   ├── tenant-plugin.ts   # AsyncLocalStorage + auto-injection (§6.3)
│   │       │   │   └── ensure-indexes.ts  # idempotent, background, safe
│   │       │   ├── logger.ts        # pino + redaction (§11, R8)
│   │       │   ├── storage/         # ObjectStorage interface + s3 / local adapters
│   │       │   ├── mail/            # EmailSender interface + smtp adapter
│   │       │   └── pdf/             # pdfkit document builders
│   │       ├── middleware/
│   │       │   ├── request-id.ts
│   │       │   ├── authenticate.ts  # verifies access token + session liveness
│   │       │   ├── tenant-scope.ts  # builds RequestContext, rejects missing scope
│   │       │   ├── authorize.ts     # requirePermission(...)
│   │       │   ├── rate-limit.ts
│   │       │   ├── error-handler.ts # RFC 9457-style, no stack leakage
│   │       │   └── not-found.ts
│   │       ├── validation/         # request validation layer
│   │       │   ├── validate.ts      # Zod body/query/params middleware
│   │       │   ├── field-errors.ts  # normalised field-error shape
│   │       │   └── index.ts
│   │       ├── utilities/          # dependency-free helpers
│   │       │   ├── pagination.ts    # opaque cursor encode/decode + page meta
│   │       │   ├── http.ts          # asyncHandler, sendSuccess, throwNotFound
│   │       │   └── index.ts
│   │       ├── modules/             # one folder per domain
│   │       │   ├── auth/
│   │       │   ├── hospitals/
│   │       │   ├── users/
│   │       │   ├── departments/
│   │       │   ├── patients/
│   │       │   ├── appointments/
│   │       │   ├── consultations/
│   │       │   ├── prescriptions/
│   │       │   ├── attendance/
│   │       │   ├── billing/
│   │       │   ├── notifications/
│   │       │   └── audit/
│   │       │       └── (each: model · schema · repository · service · controller · routes · tests)
│   │       ├── seed/                # FICTIONAL data, dev-only, refuses to run in prod
│   │       ├── migrations/          # versioned, idempotent (indexes + backfills)
│   │       └── tests/               # vitest setup + mongodb-memory-server harness
│   │
│   └── web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx              # router definition
│           ├── styles/              # Tailwind 4 theme tokens, brand palette
│           ├── lib/                 # api client, queryClient, cn(), formatters
│           ├── components/
│           │   ├── ui/              # Button, Input, Dialog, Table, Badge, Toast…
│           │   ├── layout/          # AppShell, Sidebar, Topbar, TenantSwitcher
│           │   └── states/          # Loading, Empty, ErrorBoundary, Skeleton
│           ├── features/            # feature-sliced, mirrors API modules
│           │   ├── auth/  landing/  super-admin/  hospital-admin/
│           │   ├── patients/  appointments/  consultations/  billing/
│           │   ├── attendance/  reports/  settings/  audit/
│           ├── routes/              # route guards: <RequireAuth>, <RequirePermission>
│           ├── hooks/
│           └── test/                # vitest + RTL + MSW setup
│
├── infra/
│   ├── docker/
│   │   ├── api.Dockerfile
│   │   └── web.Dockerfile
│   ├── nginx/                       # SPA + security headers (if self-hosted)
│   └── scripts/
│       ├── seed-dev.ts
│       ├── ensure-indexes.ts
│       └── backup-restore-drill.ts
│
└── scripts/
    └── check-workspace-path.ts      # warns if the repo path contains spaces
```

---

## 5. Technology decisions

Versions below were **verified against the npm registry on 2026-10-10**. Exact versions
will be pinned in `package-lock.json` during Phase 0, not hard-coded here.

### 5.1 Frontend

| Package | Verified version | Notes |
| --- | --- | --- |
| react / react-dom | 19.3.0 | Current stable |
| vite | 8.3.4 | |
| typescript | see §5.5 | **Pinned to 5.9.3** for ecosystem stability |
| tailwindcss + @tailwindcss/vite | 4.3.3 | v4 CSS-first config via the Vite plugin |
| react-router-dom | 7.18.4 | Data router |
| @tanstack/react-query | 5.104.1 | Server state, cache keys namespaced by hospital |
| react-hook-form | 7.89.0 | |
| @hookform/resolvers | 5.9.1 | Zod resolvers |
| zustand | 5.0.15 | Auth + UI state only, never server data |
| radix-ui | 1.7.0 | Unstyled accessible primitives |
| lucide-react | 1.54.0 | Icons |
| clsx / tailwind-merge / class-variance-authority | 2.1.1 / 3.7.0 / 0.7.1 | `cn()` helper |

### 5.2 Backend

| Package | Verified version | Notes |
| --- | --- | --- |
| express | 5.3.0 | v5 — async error propagation built in |
| mongoose | 9.11.1 | Current stable |
| zod | 4.6.5 | All request/response validation |
| @node-rs/argon2 | 2.2.2 | **Argon2id via prebuilt N-API binaries — no node-gyp** (important: this is a Windows dev machine) |
| jose | 6.2.12 | JWT sign/verify (EdDSA or RS256, asymmetric) |
| pino / pino-http | 10.4.0 / 11.0.0 | Structured logging with redaction |
| helmet | 8.3.0 | Security headers + CSP |
| express-rate-limit | 8.7.1 | Per-route policies |
| pdfkit | 0.20.2 | Server-side PDF invoices/prescriptions (no headless browser) |
| nodemailer | 10.0.16 | SMTP adapter for the email port |
| @aws-sdk/client-s3 | 3.1148.0 | S3-compatible private object storage |
| tsx | 4.23.15 | Dev runner / type-stripping |
| swagger-ui-express | 5.0.1 | OpenAPI UI |
| supertest | 7.3.1 | API integration tests |

### 5.3 Testing

| Package | Verified version |
| --- | --- |
| vitest / @vitest/coverage-v8 | 5.0.3 |
| mongodb-memory-server | 11.3.0 |
| @testing-library/react + user-event | React 19-compatible latest |
| vitest-axe | 0.1.0 |
| MSW | latest |

### 5.4 Explicitly rejected options

| Rejected | Reason |
| --- | --- |
| `bcrypt` / `argon2` (node-gyp native builds) | Native compilation is fragile on Windows and in slim Docker images. `@node-rs/argon2` ships prebuilt binaries and is Argon2id. |
| Puppeteer for PDFs | ~300 MB Chromium dependency, slow cold start, larger attack surface. `pdfkit` is deterministic and lightweight. |
| Prisma / SQL | The brief specifies MongoDB Atlas + Mongoose. |
| Microservices | Gross over-engineering at MVP scale; hurts transaction simplicity and debugging. A modular monolith is the correct choice — module boundaries are enforced so extraction remains possible later. |
| Storing refresh tokens in `localStorage` | XSS-exfiltrable. Refresh token goes in an `HttpOnly; Secure; SameSite=Strict` cookie; access token stays in memory only. |
| `sanitize-html` on plain-text clinical fields | Prefer structured data + strict Zod schemas over free-text HTML. |

### 5.5 TypeScript version — resolved

`typescript@latest` is **7.0.2** (the native Go compiler). `typescript@6.0.3` and the mature
`typescript@5.9.3` line also exist.

**Decision: pinned to `5.9.3`** — the broadest compatibility with ESLint, Vitest and editor
tooling, and the lowest risk for a production system. TypeScript 7 can be evaluated once the
plugin ecosystem catches up.

> Correction: an earlier draft of this document named `5.9.25`. No such version exists —
> `5.9.3` is the verified latest 5.x release. The pin was corrected before any code was
> written.

---

## 6. Multi-tenancy & authorisation (the core security design)

### 6.1 Roles and permissions

Roles are code-level constants in `packages/shared/src/rbac`; permissions are a typed union
(`'patient:read' | 'patient:write' | 'appointment:read' | 'billing:read' | 'audit:read' | …`).
Each role maps to a fixed permission set; a hospital may **grant a subset** to a staff
membership (never escalate above the role's ceiling).

| Role | Scope | Summary of permissions |
| --- | --- | --- |
| `SUPER_ADMIN` | Platform | Manage hospitals, plans, platform settings. **No default access to clinical data.** |
| `HOSPITAL_ADMIN` | One hospital | Full admin of their tenant: users, departments, billing, settings, audit |
| `DOCTOR` | One hospital | Read patients in their departments/care team; own consultations & prescriptions |
| `RECEPTIONIST` | One hospital | Patient registration, appointment scheduling; **no clinical notes** |
| `STAFF` | One hospital | Only explicitly granted permissions (e.g. attendance, inventory) |
| `PHARMACIST` | One hospital | Pharmacy module (post-MVP) |
| `ACCOUNTANT` | One hospital | Billing, payments, finance reports; **no clinical notes** |
| `PATIENT` | Own data only | Patient portal (post-MVP) |

**Design stance:** a `SUPER_ADMIN` can suspend a tenant and manage commercial settings, but
does **not** silently browse patient records. Clinical data access requires a reason and is
audited. Support workflows that genuinely need data access should use a time-boxed,
logged "break-glass" read — designed for later, not built now.

### 6.2 Tenant context — the single most important rule

> **`hospitalId` is never read from the request body, query, or params. It is always derived
> server-side from the authenticated user's active membership.**

- A client-supplied `hospitalId` is **ignored** and recorded in the audit log.
- The only supported way to change tenant context is `POST /auth/switch-hospital`, which
  validates an **active membership** before issuing a new access token.
- `RequestContext` is constructed once, in middleware:

```ts
type RequestContext = {
  requestId: string
  userId: UserId
  membershipId: MembershipId
  role: Role
  hospitalId: HospitalId   // resolved from membership, never from input
  permissions: ReadonlySet<Permission>
  ip: string
  userAgent: string
}
```

### 6.3 Making cross-tenant access structurally impossible

A lint rule and code review can be bypassed. The design instead uses **three enforcing layers**:

1. **Storage layer (primary defence).** `AsyncLocalStorage` holds the active
   `RequestContext`. A Mongoose plugin registered on every tenant-scoped schema intercepts
   `find / findOne / findOneAndUpdate / updateOne / updateMany / deleteOne / deleteMany /
   aggregate / count / distinct` and:
   - **injects** `{ hospitalId: ctx.hospitalId }` into every filter, and
   - **throws** `TenantScopeError` if the operation runs with no tenant context.

   A developer writing `PatientModel.find({ name: 'x' })` gets a query silently scoped to
   their tenant. A developer writing it outside a request gets a hard failure, not a
   data leak. Platform-wide operations must explicitly opt in via a `PlatformScope` token,
   which is itself audit-logged.

2. **Repository layer.** Controllers cannot import a Mongoose `Model` (ESLint `no-restricted-imports`).
   Repositories always accept a `RequestContext` first argument.

3. **HTTP semantics.** Accessing a resource belonging to another tenant returns **`404`, not
   `403`**, so the API never confirms that an ID exists somewhere else.

### 6.4 Intra-tenant access control

Tenant isolation alone is insufficient. Two further checks:

- **Care-team scope (DOCTOR):** a doctor may read a patient's record only if the patient is
  in one of their departments or has an appointment/consultation assigned to them.
- **Field-level scoping (ACCOUNTANT/RECEPTIONIST):** billing responses never embed diagnosis
  or consultation text; registration responses never embed clinical notes. Enforced by
  **role-specific Zod response schemas**, not by frontend field hiding.

### 6.5 Database indexes (created idempotently at boot / by a migration job)

Every tenant collection opens with a compound index led by `hospitalId`.

| Collection | Key indexes |
| --- | --- |
| `users` | `{ email: 1 }` unique (lowercased), `{ phone: 1 }` sparse unique |
| `memberships` | `{ hospitalId: 1, userId: 1 }` unique, `{ hospitalId: 1, role: 1, status: 1 }` |
| `patients` | `{ hospitalId: 1, uhid: 1 }` unique, `{ hospitalId: 1, 'name.last': 1, 'name.first': 1 }`, `{ hospitalId: 1, status: 1, createdAt: -1 }`, text index on name/phone |
| `appointments` | `{ hospitalId: 1, doctorId: 1, startAt: 1 }`, `{ hospitalId: 1, patientId: 1, startAt: -1 }`, `{ hospitalId: 1, status: 1, startAt: 1 }` |
| `invoices` | `{ hospitalId: 1, number: 1 }` unique, `{ hospitalId: 1, patientId: 1, issuedAt: -1 }` |
| `audit_logs` | `{ hospitalId: 1, createdAt: -1 }`, `{ actorUserId: 1, createdAt: -1 }` |

All indexes are built **in the background** so they never block collection traffic, and are
verified by a `ensure-indexes` script that can run in CI against an ephemeral database.

### 6.6 Anti-double-booking

`appointments` carries a partial unique index:

```js
{ hospitalId: 1, doctorId: 1, startAt: 1 },
{ unique: true, partialFilterExpression: { status: { $in: ['BOOKED', 'CHECKED_IN'] } } }
```

The database — not application logic — is the final authority on conflicts. API returns
`409 CONFLICT`.

---

## 7. Data model (MVP)

| Collection | Purpose | Key fields |
| --- | --- | --- |
| `hospitals` | Tenant | `name`, `slug`, `registrationNo`, `contact`, `address`, `status: PENDING\|APPROVED\|SUSPENDED\|REJECTED`, `plan`, `settings{ currency, timezone, slotDurationMin, taxConfig, invoicePrefix }` |
| `users` | Global identity | `email`, `phone`, `passwordHash`, `firstName`, `lastName`, `status`, `mfa{ enabled, secretEnc, recoveryCodesHash }`, `failedLoginCount`, `lockedUntil` |
| `memberships` | User ↔ Hospital ↔ Role | `userId`, `hospitalId`, `role`, `grantedPermissions[]`, `status`, `invitedBy` |
| `refresh_sessions` | Token rotation + revocation | `userId`, `familyId`, `tokenHash`, `ip`, `userAgent`, `expiresAt`, `revokedAt`, `replacedBy` |
| `password_resets` | Recovery | `userId`, `tokenHash`, `expiresAt`, `usedAt` |
| `departments` | Clinical org | `name`, `code`, `headDoctorId`, `active` |
| `doctor_profiles` | Doctor details | `userId`, `departmentIds[]`, `nmcRegistrationNo`, `specialty`, `qualifications[]`, `consultationFee`, `slotDurationMin`, `availability[]` |
| `staff_profiles` | Staff details | `userId`, `designation`, `departmentId` |
| `patients` | Patient master | `uhid`, demographics, contact, address, `emergencyContact`, `allergies[]`, `tags[]`, `status`, `createdBy` |
| `appointments` | Scheduling | `patientId`, `doctorId`, `departmentId`, `startAt`, `endAt`, `status`, `reason`, `source`, `createdBy`, cancellation fields |
| `consultations` | Clinical note | `appointmentId`, `patientId`, `doctorId`, `chiefComplaint`, `history`, `examination`, `diagnosis[]`, `advice`, `vitals`, `status: DRAFT\|FINAL`, `signedAt` |
| `prescriptions` | Medication order | `consultationId`, `items[{ drug, dose, frequency, duration, route, notes }]`, `advice`, `followUpDate`, `pdfKey` |
| `attendance` | Staff attendance | `userId`, `date`, `checkInAt`, `checkOutAt`, `status`, `source`, `approvedBy` — unique `{hospitalId, userId, date}` |
| `billing_items` | Price list | `code`, `name`, `price`, `taxPercent`, `active` |
| `invoices` | Billing | `number` (unique per tenant), `patientId`, `items[]`, `subtotal`, `discount`, `tax`, `total`, `balance`, `status`, `issuedAt`, `dueAt`, `pdfKey` |
| `payments` | Receipts | `invoiceId`, `amount`, `method`, `reference`, `receiptNumber`, `receivedBy`, `receivedAt` |
| `notifications` | In-app | `userId`, `type`, `title`, `body`, `data`, `readAt` |
| `audit_logs` | Append-only trail | `hospitalId`, `actorUserId`, `actorRole`, `action`, `resourceType`, `resourceId`, `ip`, `userAgent`, `requestId`, `metadata` (redacted), `createdAt` |

**Audit log rules:** no `PUT`/`PATCH`/`DELETE` route ever exists for `audit_logs`. Records
store identifiers, action names and field *names* — never PHI *values*. Written inside the
same request lifecycle as the action it records.

---

## 8. API design

- **Base path:** `/api/v1` (versioned from day one; breaking changes require `/api/v2`).
- **Docs:** OpenAPI 3.1, served at `/api/docs` in development. The spec is **generated from
  the same Zod schemas used for runtime validation**, so documentation cannot drift from
  behaviour. *(Library to be confirmed in Phase 0 — Zod 4 support differs between
  `zod-openapi` and `@asteasolutions/zod-to-openapi`.)*

**Success**
```json
{ "success": true, "data": { }, "meta": { "requestId": "01J...", "page": 1, "pageSize": 20, "total": 137 } }
```

**Error** (RFC 9457-inspired, consistent envelope)
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [ { "path": "email", "message": "Invalid email" } ],
    "requestId": "01J..."
  }
}
```

**Error codes** (stable union in `packages/shared`): `VALIDATION_ERROR`,
`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `TENANT_SCOPE_REQUIRED`,
`RATE_LIMITED`, `ACCOUNT_LOCKED`, `MFA_REQUIRED`, `INTERNAL_ERROR`.

**Pagination:** cursor-based (`?cursor=&limit=`, max 100) for clinical and audit lists;
`page`/`pageSize` where a total count is genuinely needed (admin tables).

---

## 9. Frontend architecture

- **Routing & guards:** React Router data router. `<RequireAuth>` validates the session;
  `<RequirePermission>` enforces the permission matrix *for UX only* — the API is still the
  authority (defence in depth, never defence-in-one-layer).
- **Server state:** TanStack Query. **Every** query key begins with the active `hospitalId`,
  so switching tenants cannot surface cached data from another hospital.
- **Forms:** React Hook Form + Zod resolvers, sharing schemas from `packages/shared`.
  Server-side field errors map back onto the correct inputs.
- **UI system:** Tailwind 4 design tokens + Radix primitives. Brand identity:
  *"Ideas grow without limits"* — clinical, trustworthy base with a growth-green accent,
  WCAG AA contrast, full keyboard navigation and visible focus rings.
- **Mandatory UI states** for every data view: loading skeleton, empty state (with a real
  next action), error state with retry, and success feedback.
- **No dead controls.** A button is rendered only when its action is implemented and wired.
- **Accessibility:** semantic landmarks, labelled inputs, `vitest-axe` assertions, error
  messages announced via `aria-live`.

---

## 10. Security controls (baseline, all Phase 0–1)

| Area | Control |
| --- | --- |
| Passwords | Argon2id, memory-hard params, `m=19456, t=2, p=1` baseline, tuned per environment; breached-password screening |
| Account protection | Exponential backoff, temporary lockout, generic "invalid credentials" responses (no user enumeration) |
| MFA | TOTP (RFC 6238) required for `SUPER_ADMIN` and `HOSPITAL_ADMIN`; encrypted secret; single-use recovery codes |
| Sessions | 10-minute access JWT (asymmetric, minimal claims); opaque rotating refresh token (256-bit, SHA-256 hashed at rest, family-based reuse detection → full family revoke + security event) |
| Transport | HTTPS only; `Strict-Transport-Security`; `SameSite=Strict` cookies; CORS allowlist from env |
| Headers | `helmet` + CSP; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `frame-ancestors 'none'` |
| Input | Zod `.strict()` on every route; reject keys containing `$` or starting with `.`; `mongoose.set('sanitizeFilter', true)`, `strictQuery: true` |
| Output | Role-specific response schemas strip fields the role must not see (§6.4) |
| Logging | Pino with header/field redaction; PHI field blacklist; no request bodies on clinical routes; stack traces never returned to clients |
| Rate limiting | Separate policies: auth (strict), password reset (strict), API (moderate), public (lenient) |
| Uploads / files | Private bucket; short-lived pre-signed URLs (≤ 5 min); server-generated object keys; MIME + size + magic-byte validation; no static directory serving |
| Secrets | Environment variables only; `.env` git-ignored; CI secret scanning; startup fails fast on missing or placeholder secrets |
| Dependencies | Lockfile committed, Dependabot, `npm audit`/OSV in CI, minimal dependency surface |
| Audit | Append-only trail for every PHI read/write, auth event, permission change and tenant-context change |

---

## 11. Security risk register

Severity: **C**ritical / **H**igh / **M**edium / **L**ow.

| # | Risk | Sev | Mitigation |
| --- | --- | --- | --- |
| R1 | **Cross-tenant data access (IDOR)** — a doctor from Hospital A reads Hospital B's patients | **C** | §6.3 three-layer enforcement (storage-level auto-injection that throws without a tenant context), 404-not-403, mandatory isolation test matrix (§13) |
| R2 | **Client-supplied `hospitalId` / role trusted by the API** | **C** | §6.2 — tenant context derived only from the verified membership; client input ignored and audited |
| R3 | **NoSQL injection** — operator objects (`$ne`, `$gt`) bypassing filters | **H** | Zod strict parsing, reject `$`/`.` keys, `sanitizeFilter`, `strictQuery`, dedicated injection tests |
| R4 | **Stale authorisation** — a terminated/re-roled user keeps access until the token expires | **H** | Short-lived access tokens + DB membership re-check on every request (cached ≤ 60 s); session revocation list |
| R5 | **Weak password storage / credential stuffing** | **H** | Argon2id with hard parameters, lockout, MFA for privileged roles |
| R6 | **Token theft via XSS** | **H** | Access token in memory only, refresh token `HttpOnly`, strict CSP, no `dangerouslySetInnerHTML`, sanitised rich text only |
| R7 | **CSRF against cookie-authenticated routes** | **H** | `SameSite=Strict` + double-submit CSRF token on state-changing cookie routes |
| R8 | **PHI leaking into logs, errors, or analytics** | **H** | Pino redaction, PHI field blacklist, generic client errors, no body logging on clinical routes, CI test asserting redaction |
| R9 | **Over-broad clinical access** — any staff reading all patient records | **H** | Care-team scoping (§6.4) + permissions + mandatory audit on PHI reads |
| R10 | **Mass assignment** — spreading `req.body` into a model | **H** | Strict Zod allowlists; no object spreading into writes; review rule |
| R11 | **ID enumeration / existence disclosure** | **M** | Uniform 404s, identical timing/message for login and forgot-password, rate limits |
| R12 | **Rate limiting bypass across instances** | **M** | Shared rate-limit store (Redis or Mongo) for multi-instance deploys — *paid resource, approval required* |
| R13 | **Insecure file storage** — public buckets, path traversal, unbounded uploads | **H** | Private buckets, short-lived pre-signed URLs, server-generated keys, content validation, malware-scan hook |
| R14 | **PDF/document leakage or injection** | **M** | Authorisation checked before render, short-lived signed URLs, `pdfkit` text escaping, audit on generation |
| R15 | **Missing or mutable audit trail** | **H** | Append-only collection, no mutating endpoints, separate retention, integrity checks |
| R16 | **Data loss / unrecoverable backups** | **H** | Atlas continuous cloud backup + point-in-time restore (paid tier) + documented, rehearsed restore drill |
| R17 | **Supply-chain compromise of dependencies** | **M** | Lockfile, Dependabot, OSV/`npm audit` gate in CI, minimal deps, review of new additions |
| R18 | **Over-broad CORS / missing security headers** | **M** | Env-driven allowlist, `helmet` CSP, pre-production header audit |
| R19 | **Development seed data reaching production** | **M** | Seeder refuses to run unless `NODE_ENV=development` **and** an explicit `--i-am-in-dev` flag; CI test asserts the refusal |
| R20 | **Misconfiguration / weak defaults** | **L** | Zod-validated environment with fail-fast startup; documented secure defaults; secret rotation runbook |
| R21 | **Workspace path contains spaces** | **L** | Path guard warns on install and **fails CI** (`--strict`); verified working in Phase 0. Renaming remains recommended (§17, Q2) |

---

## 12. Healthcare data protection

Designed **toward** the Digital Personal Data Protection Act, 2023 and its 2025 Rules, but
**this is not a legal opinion and not a certification.** A qualified legal and privacy
review is required before handling real patient data.

| Principle | Implementation |
| --- | --- |
| Purpose limitation | Data collected for care delivery and hospital administration only; no secondary use |
| Data minimisation | Role-scoped responses; optional fields; no collection of unrelated data |
| Consent & notice | Patient consent status captured at registration; privacy notice versioned |
| Security safeguards | Argon2id, TLS in transit, Atlas encryption at rest, RBAC, audit trail |
| Accountability | Every PHI access produces an audit record with actor, time, IP and reason |
| Retention | Configurable retention windows; a documented purge job (legal-hold capable) — designed in Phase 8 |
| Breach response | Incident runbook in `docs/RUNBOOK.md`; DPDP breach-notification workflow defined before go-live |
| Grievance | Contact channel in `docs/COMPLIANCE-NOTES.md`; named grievance officer field |
| Patient rights | Data-access/correction flows in the patient portal (post-MVP); export capability designed for |

**Additional healthcare design decisions:**

- **Field-level encryption** (AES-256-GCM, keys from a KMS-backed secret) is applied to
  consultation free-text. Structured demographic fields stay queryable — encrypting them
  would break search, deduplication and reporting. This trade-off is explicit, not an oversight.
- **Future ABHA/ABDM interoperability** is considered in the patient identifier design, but
  integration is out of MVP scope.
- Atlas free (M0) tier does **not** provide encryption-at-rest options, point-in-time
  restore, or advanced security controls. **Production must be on a paid tier (M10+).**

---

## 13. Testing strategy

**Command contract:** `npm test` must be green and its output inspected before any claim of
success is made.

| Layer | Tool | Coverage |
| --- | --- | --- |
| Unit (API) | Vitest | Services, validators, RBAC matrix, money/date logic |
| Integration (API) | Supertest + `mongodb-memory-server` | Every route: happy path, validation failure, auth failure, authorisation failure |
| **Tenant isolation** | Supertest | **Mandatory:** for every tenant-scoped endpoint, a user of Hospital A requesting Hospital B's resource by ID must receive `404` and no data leak (body, timing, logs) |
| Security | Vitest | NoSQL injection payloads, mass-assignment attempts, privilege-escalation attempts, ID enumeration, rate-limit exhaustion, log-redaction assertions |
| Unit/Component (web) | Vitest + RTL + MSW | Components, hooks, form validation, role-gated rendering |
| Accessibility | `vitest-axe` | No serious/critical violations on core screens |
| E2E | Playwright (Phase 8) | Register → approve → onboard → book appointment → consultation → invoice |

**Coverage gates in CI:** ≥ 85 % lines/branches on `apps/api/src`, **100 %** on
`auth`, `tenant-scope`, and `rbac` modules. Below the gate, CI fails.

**Test data:** 100 % fictional. Seed names use an obvious synthetic marker so a leaked
fixture is instantly identifiable.

---

## 14. DevOps & CI/CD

**CI (GitHub Actions)** — `lint → typecheck → test → build → scan`, where scan = `npm audit`/OSV, dependency review, secret scan, container image scan (Trivy), CodeQL.

**Environments:** `development` (Atlas dev cluster) → `staging` (Atlas M10, synthetic data only) → `production` (Atlas M10+ with continuous backup + PITR).

**Secret management:** platform secret manager. Nothing sensitive in source, CI logs, or documentation.

**MongoDB migrations:** MongoDB is schemaless, so we implement a small versioned migration runner (`migrations/` + a `migrations` collection) for **index creation and data backfills**, applied idempotently and tracked. Background index builds to avoid blocking.

**Observability:** structured request logs with `requestId` correlation; health/readiness
probes (`/health`, `/ready`) for container orchestration; uptime monitoring; alert on error
rate, p95 latency, and failed backups.

**Rollback:** immutable images + tagged releases; documented rollback procedure in
`docs/RUNBOOK.md`.

---

## 15. Implementation phases

Each phase ends with: working code, passing tests I have actually run, and a summary of
changed files, commands run, test results, known issues, and the next phase.

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **0 — Foundation** | Monorepo, workspaces, TypeScript strict, ESLint/Prettier, Zod-validated env, pino logger with redaction, Express bootstrap, error envelope, health endpoints, index bootstrap, CI pipeline, OpenAPI skeleton, docs | `npm run dev` starts both apps; `npm test` and `npm run typecheck` green; CI green |
| **1 — Identity & Tenancy Core** | `users`, `hospitals`, `memberships`, tenant-scope plugin, RBAC, auth (register/verify/login/refresh/logout), password reset, MFA (TOTP), audit log, Super Admin approve/reject flow | **Tenant isolation test matrix passes**; no cross-tenant access possible |
| **2 — Hospital Onboarding** | Departments, doctor & staff profiles, staff invitations, role/permission management, hospital settings, branding | Hospital admin can fully onboard staff; permission changes effective immediately |
| **3 — Patients & Appointments** | Patient registration (UHID), search & dedupe, list/detail, appointment scheduling with availability, conflict handling, status lifecycle | Booking conflicts impossible; patients scoped to tenant |
| **4 — Clinical** | Consultation notes (draft/final/sign), prescriptions, PDF generation, patient history timeline | Doctor can complete a visit end-to-end; PDFs correct |
| **5 — Attendance** | Check-in/out, status, monthly views, approvals | Attendance unique per user/day; reports correct |
| **6 — Billing & Payments** | Price list, invoices, discounts, tax, payments, receipts, PDF invoice, balance tracking | Invoice math verified by unit tests; accountant cannot see clinical notes |
| **7 — Reports & Notifications** | Dashboard reports, in-app notifications, email notifications, audit log UI, hospital settings UI | Reports accurate against seeded data; audit log browsable and immutable |
| **8 — Hardening & Launch** | Security testing, performance/pagination review, accessibility pass, backups + restore drill, monitoring, deployment pipeline, runbooks, final docs | Release checklist signed off |
| **9+ — Post-MVP** | Pharmacy module, patient portal, ABDM/ABHA, multi-branch, database-per-tenant for enterprise tiers | — |

---

## 16. Initial setup steps (Phase 0 — to run after approval)

```powershell
# 0. Optional but recommended: relocate to a space-free path
#    Move-Item "C:\HOSPITAL MANAGEMENT SaaS" "C:\dev\infinigrow-hospital-cloud"

# 1. Initialise git (branching: main = production, develop = integration)
cd "C:\HOSPITAL MANAGEMENT SaaS"
git init
git checkout -b develop

# 2. Create workspace root + package.json (npm workspaces: apps/*, packages/*)

# 3. Install pinned dependencies
npm install

# 4. Create .env from template and fill with Atlas SRV string
Copy-Item .env.example .env

# 5. Verify environment validation fails fast on a bad value
npm run dev:api          # http://localhost:4000/health
npm run dev:web          # http://localhost:5173

# 6. Quality gates
npm run typecheck
npm run lint
npm test

# 7. First commit (no .env, ever)
git add .
git commit -m "chore: initialise Infinigrow Hospital Cloud monorepo (Phase 0)"
```

---

## 17. Decisions — answered 2026-10-10

Phase 0 was approved and completed. Answers to the questions raised during review:

| # | Question | Decision |
| --- | --- | --- |
| **Q1** | MongoDB Atlas tier? | **Free M0 for development.** Production is gated to M10+ (M0 has no backup, no PITR, no encryption options). Connection string goes in local `.env` only — never in chat or source. |
| **Q2** | Rename the workspace to a space-free path? | **Keep `C:\HOSPITAL MANAGEMENT SaaS`.** Node, npm, Git, Vite, Vitest and ESLint were all verified working. A path guard now warns on install and fails CI in strict mode; Docker/CI path handling stays unverified until Phase 8. |
| **Q3** | TypeScript version? | **Pinned to 5.9.3** (conservative, broadest tooling compatibility). |
| **Q4** | Deployment target and budget? | **Open** — needed before Phase 8. |
| **Q5** | Email provider for Phase 1? | **Open** — blocks password reset and staff invitations in Phase 1. |
| **Q6** | Object storage provider? | **Open** — needed before Phase 4. |
| **Q7** | GST/GSTIN fields on invoices from day one? | **Open** — decide before Phase 6; retrofitting tax compliance into issued invoices is painful. |
| **Q8** | Create the Git repository and commit? | **Yes, approved.** Repository initialised; work committed on `develop`. |
| **Q9** | MVP scope confirmation? | Assumed confirmed: no lab, pharmacy, insurance/TPA claims or IPD/beds in MVP. |
| **Q10** | Patient portal post-MVP acceptable? | Assumed confirmed. |

**Open items Q4–Q7 block later phases but not Phase 1** (except Q5, which blocks Phase 1
password reset).

---

## 18. Phase 0 outcome

Delivered and verified on 2026-10-10. See `README.md` and [`ARCHITECTURE.md`](./ARCHITECTURE.md).

- Monorepo (`packages/shared`, `apps/api`, `apps/web`) with 477 packages, **0 vulnerabilities**.
- **149 tests passing** — 19 shared, 82 API, 48 web. API coverage 91.5% lines; web 95.6%.
- Lint and typecheck clean across all workspaces; production build succeeds.
- Real `mongod` integration tests run via `mongodb-memory-server` — **verified executing, not skipped**.
- CI pipeline with lint → typecheck → test → build → audit → dependency review → gitleaks → CodeQL.

**Bugs caught by tests during Phase 0** (all fixed, each now has a regression test):

| Bug | Severity | Note |
| --- | --- | --- |
| `resolvePermissions` unioned grants with the role ceiling instead of intersecting | **Critical** | Would have silently granted a restricted staff member every permission of their role |
| Web API client threw `Invalid URL` for the default relative base URL `/api/v1` | High | The default browser path would have failed on every request |
| pino 10 ignores the `stream` option, so log output went to stdout | High | Redaction tests read an empty buffer and would have passed vacuously |
| Placeholder-secret detection was anchored, so `mongodb://changeme` passed production checks | High | A template secret would have shipped to production |
| `preinstall` used `tsx`, which does not exist before dependencies install | High | `npm install` would fail on any fresh clone |
| Zod 4 `.default('false')` on a transform coerced to the wrong type | Medium | Type error caught at build time |
| `middleware` imported Mongoose directly | Medium | Architecture leak; extracted to `infrastructure/mongo-error-mapper.ts` rather than weakening the lint rule |