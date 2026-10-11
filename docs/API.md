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

## Planned surface (Phase 1+)

Listed for planning only — **not implemented**:
`/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`,
`/auth/reset-password`, `/auth/switch-hospital`, `/hospitals`, `/users`, `/departments`.

---

## Versioning policy

- Additive changes (new optional fields, new endpoints) ship within the current version.
- Breaking changes require `/api/v2`; the previous version runs in parallel for a stated
  window.
- Deprecated endpoints announce `Deprecation` and `Sunset` headers before removal.