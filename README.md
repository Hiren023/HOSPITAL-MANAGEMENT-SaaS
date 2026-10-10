# Infinigrow Hospital Cloud

**Ideas grow without limits.**

Cloud-based, multi-tenant Hospital Management SaaS for clinics, small hospitals and large
multispecialty hospitals. Built by **Infinigrow Softech**.

> **Status: Phase 0 (Foundation) complete.** Authentication, hospital onboarding and all
> clinical modules are **not yet implemented** — see the roadmap below.

---

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, Vite 8, TypeScript 5.9, Tailwind CSS 4 |
| Backend | Node.js 24, Express 5, TypeScript 5.9 |
| Database | MongoDB Atlas with Mongoose 9 |
| Validation | Zod 4 (shared between client and server) |
| Auth | Argon2id + short-lived access tokens + rotating refresh tokens *(Phase 1)* |
| Testing | Vitest, Supertest, React Testing Library, axe-core, `mongodb-memory-server` |
| CI/CD | GitHub Actions — lint, typecheck, test, build, audit, gitleaks, CodeQL |

Monorepo (npm workspaces): `packages/shared`, `apps/api`, `apps/web`.

---

## Quick start

```powershell
npm install
Copy-Item .env.example .env     # then set MONGODB_URI to your Atlas SRV string
npm run verify                  # path guard + lint + typecheck + tests
npm run dev                     # API on :4000, web on :5173
```

Requires **Node.js 24**. Docker is not required.

Open <http://localhost:5173>. The dev server proxies `/api` to the API, so no CORS setup is
required locally.

> **Never commit `.env`.** It is git-ignored, and CI runs a gitleaks secret scan to enforce
> that no credential or connection string is ever committed.

---

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run API and web together |
| `npm run dev:api` | Backend only → <http://localhost:4000> |
| `npm run dev:web` | Frontend only → <http://localhost:5173> |
| `npm run verify` | Path guard → lint → typecheck → tests |
| `npm test` | All tests |
| `npm run test:coverage` | Tests with enforced coverage thresholds |
| `npm run build` | Build shared → api → web |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run typecheck` | TypeScript, all workspaces |
| `npm run format` | Prettier |

### Run backend and frontend separately

```powershell
# Terminal 1 — backend
npm run dev:api

# Terminal 2 — frontend
npm run dev:web
```

The web dev server proxies `/api` to <http://localhost:4000>, so no CORS setup is
required for local development.

### First run — no accounts exist yet

A fresh database has no users at all, including no platform administrator. Public
registration creates hospitals, but a `SUPER_ADMIN` can only be created offline, by an
operator, because no public endpoint is permitted to mint a platform role.

```powershell
# 1. Generate an EdDSA key pair for JWT signing, then paste the output into .env
node scripts/generate-jwt-keys.mjs

# 2. Create the first platform administrator (development only)
npx tsx src/scripts/bootstrap-super-admin.ts `
  --email operator@example.test `
  --name "Platform Operator" `
  --password "a-long-passphrase-of-your-choosing" `
  --i-am-secure
```

The command refuses to run under `NODE_ENV=production`, refuses without `--i-am-secure`,
requires a password of at least 12 characters, and never overwrites an existing account.

### Verifying the stack is working

```powershell
node scripts/demo-flow.mjs            # registration → approval → sign-in, against a live API
node scripts/verify-proxy-auth.mjs    # the browser's own request path, through the dev proxy
```

Both talk to a running API. `demo-flow.mjs` is the quickest way to confirm tenant
approval works; `verify-proxy-auth.mjs` confirms the same-origin path the web client uses.

---

## Environment variables

Copy `.env.example` to `.env` and set values. The API validates configuration at startup
and **refuses to boot** on invalid input, listing every problem at once.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | — | `development` | `development` \| `test` \| `production` |
| `PORT` | — | `4000` | API port |
| `HOST` | — | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | — | `info` | `fatal`…`silent`. Production rejects `debug`/`trace` |
| `LOG_PRETTY` | — | `false` | Pretty console logs for local use |
| `CORS_ORIGINS` | Prod | `http://localhost:5173` | Comma-separated allowlist. Production rejects `*` and `localhost` |
| `REQUEST_BODY_LIMIT` | — | `1mb` | JSON body size cap |
| `TRUST_PROXY` | — | `false` | Only true behind a trusted proxy |
| `TRUST_PROXY_HOPS` | — | `0` | Must be > 0 when `TRUST_PROXY` is true |
| `MONGODB_URI` | **Yes** | `mongodb://127.0.0.1:27017` | Atlas SRV string. **Never commit** |
| `MONGODB_DB_NAME` | — | `infinigrow` | Logical database name |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | — | `10000` | Connect timeout |
| `MONGODB_AUTO_INDEX` | — | `false` | Leave false — indexes are built by the migration runner |
| `ENABLE_API_DOCS` | — | `true` | Production rejects `true` |

Web (Vite) reads only `VITE_*` variables: `VITE_API_BASE_URL` (default `/api/v1`) and
`VITE_DEV_API_PROXY` (default `http://localhost:4000`).

> `.env` is git-ignored and CI runs a gitleaks secret scan. Never place a credential,
> connection string or key in source code.

---

---

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/PROJECT_PROPOSAL.md`](docs/PROJECT_PROPOSAL.md) | Architecture, security model, roadmap |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Implemented decisions and layering rules |
| [`docs/SECURITY.md`](docs/SECURITY.md) | 21-item risk register with mitigations and verification |
| [`docs/API.md`](docs/API.md) | Conventions, error codes, current endpoints |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Operations, deployment, incident procedures |
| [`docs/AUTH.md`](docs/AUTH.md) | Session design, trade-offs, rejected alternatives |
| [`docs/FRONTEND.md`](docs/FRONTEND.md) | Web client architecture, design system, accessibility decisions |
| [`docs/COMPLIANCE-NOTES.md`](docs/COMPLIANCE-NOTES.md) | DPDP-oriented design notes — **not legal advice** |

---

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Foundation: monorepo, API bootstrap, RBAC matrix, tenant context, CI | ✅ Complete |
| 0b | Validation layer, cursor pagination, HTTP utilities | ✅ Complete |
| 1 | Tenant plugin, identity models, Argon2id, access tokens, isolation matrix | ✅ Complete |
| 2 | Authentication, registration, platform approval, audit trail, rate limiting | ✅ Complete |
| 3 | UI/UX foundation, design system, public site, role-aware dashboards | ✅ Complete |
| 4 | Hospital onboarding: departments, doctors, staff, permissions | ⏳ Next |
| 5 | Patients & appointments | Planned |
| 6 | Consultations, prescriptions, PDFs | Planned |
| 7 | Staff attendance | Planned |
| 8 | Billing & payments | Planned |
| 9 | Reports, notifications, audit UI | Planned |
| 10 | Hardening, deployment, backups, monitoring | Planned |
| 11+ | Pharmacy, patient portal, ABDM/ABHA | Planned |

---

## Privacy and compliance

The platform is **designed toward** the Digital Personal Data Protection Act, 2023 and its
2025 Rules, with least-privilege access, tenant isolation, encryption in transit and at
rest, and an append-only audit trail.

**This is not a legal opinion and not a certification.** Qualified legal and privacy review
is required before handling real patient data. See
[`docs/COMPLIANCE-NOTES.md`](docs/COMPLIANCE-NOTES.md).