# Operations Runbook

**Infinigrow Hospital Cloud** · Infinigrow Softech

Operational procedures for running, deploying, recovering and monitoring the platform.

> Scope note: this runbook is written during **Phase 0**. Deployment, backup and alerting
> procedures are **designed here but not yet automated** — they are Phase 8 release gates,
> tracked in [`PROJECT_PROPOSAL.md`](./PROJECT_PROPOSAL.md) §15. Items marked
> ⚠️ **NOT YET IMPLEMENTED** must not be treated as available.

---

## 1. Local development

### Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 24.x LTS | `.nvmrc` pins 24 |
| npm | 11+ | Ships with Node 24 |
| MongoDB | Atlas cluster or local | Tests use an in-memory `mongod` automatically |

Docker is **not required** and is not installed on the development machine.

### Setup

```powershell
git clone <your-remote> infinigrow-hospital-cloud
cd infinigrow-hospital-cloud

npm install
Copy-Item .env.example .env
# Edit .env and set MONGODB_URI to your Atlas SRV string.
# Never commit .env — it is git-ignored and gitleaks scans for exactly this mistake.
```

### Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start API (4000) and web (5173) together |
| `npm run dev:api` | API only — **does not rebuild `@infinigrow/shared`, see below** |
| `npm run dev:web` | Web only |
| `npm run build:shared` | Rebuild `@infinigrow/shared` — run this after editing `packages/shared/src` |
| `npm run verify` | Path guard → lint → typecheck → test |
| `npm test` | All tests across all workspaces |
| `npm run test:coverage` | Coverage with thresholds enforced |
| `npm run build` | Build shared → api → web |
| `npm run demo:flow` | Registration → approval → sign-in against a running API |
| `npm run verify:proxy-auth` | The browser's own request path, through the dev proxy |
| `npm run verify:platform-console` | Phase 4 platform console, end to end against a running API |
| `npm run verify:hospital-admin` | Phase 5 hospital administration, end to end against a running API |
| `npm run keys:jwt` | Generate an EdDSA signing pair for `.env` |
| `npm run format` | Prettier write |
| `npm run check:workspace-path` | Warn about a path containing spaces |

### Stale `@infinigrow/shared` build

**Symptom.** The API crashes at boot with
`SyntaxError: The requested module '@infinigrow/shared' does not provide an export named 'X'`
— for a symbol you can see in `packages/shared/src`.

**Cause.** The API and web app consume `@infinigrow/shared` from its built `dist/`, not
from source. `npm run dev` rebuilds it through `predev`. **`npm run dev:api` does not.**
Editing a shared file therefore has no effect until the package is rebuilt, and the
running API restarts against the old `dist/` and fails.

**Fix.**

```powershell
npm run build:shared     # then the watcher restarts the API automatically
```

This is a build-ordering problem, not a code problem. Do not "fix" it by editing the
consuming module to work around a missing export.

### Database-backed tests skip, or `mongod` will not start

**Symptom.** Every database-backed test reports as *skipped* rather than failed, or the
run fails with `Data directory … not found` / `fassert() failure`.

**Cause.** The test harness runs a real `mongod` from `mongodb-memory-server` with its
data directory under the system temp folder. Each run's directory is roughly 150 MB, and
if an earlier run was killed — a truncated CI pipe, a cancelled run, an OOM kill — the
process exit handler never fires and the directory leaks. Enough of them fill the disk,
and `mongod` then aborts at startup. The suite reports "skipped", which reads as "nothing
to test" rather than "the environment is broken".

The harness now names its directory after the process id and sweeps directories left by
processes that no longer exist, so the footprint is bounded and self-healing. It should
not recur; if it does, the sweep is broken.

**Fix.**

```powershell
# Clear leaked directories and confirm free space
Get-ChildItem $env:TEMP -Directory -Filter 'igc-test-db-*' | Remove-Item -Recurse -Force
Get-PSDrive C | Select-Object @{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}}
```

A run needs a couple of gigabytes free. If a suite suddenly skips wholesale, check disk
space before looking at the code.

### First run

```powershell
npm run verify          # everything must pass before you start
npm run dev
```

Then open <http://localhost:5173>. The web dev server proxies `/api` to
<http://localhost:4000>, so no CORS configuration is needed in development.

---

## 2. Configuration

All configuration is environment-driven and validated at startup by
`apps/api/src/config/env.ts`. **The API refuses to boot** on invalid or unsafe production
configuration, reporting every problem at once rather than one per restart.

See [`.env.example`](../.env.example) for the annotated list of variables.

Production will refuse to start if:

- `MONGODB_URI` contains a placeholder value or is not a `mongodb://` / `mongodb+srv://` URI
- `CORS_ORIGINS` is `*` or references `localhost`
- `LOG_LEVEL` is `debug` or `trace`
- `ENABLE_API_DOCS` is `true`
- `TRUST_PROXY` is `true` while `TRUST_PROXY_HOPS` is `0`

---

## 3. Database

### Migrations

There is no migration runner. Indexes are built on boot by `ensureIndexes()`, and schema
changes that need data movement are one-off scripts in `scripts/`, run deliberately and
recorded here.

#### Phase 8 -> Phase 9 — backfill subscriptions ⚠️ REQUIRED BEFORE DEPLOYING

Phase 9 puts a subscription entitlement in front of every tenant route, and the gate
**fails closed**: a hospital with no subscription row is refused everything.

**Any hospital that existed before this release will therefore be locked out of its own
records the moment the API restarts.** Sign-in still succeeds; every screen returns `403`
with *"This hospital's subscription has expired"*. It reads as a broken product rather
than as a migration that has not been run.

Run this **before** deploying the API:

```
npx tsx scripts/backfill-subscriptions.ts            # dry run — lists what would change
npx tsx scripts/backfill-subscriptions.ts --apply    # writes
```

Idempotent — a hospital that already has a subscription is skipped, so it is safe to
re-run. A second invocation reports `Nothing to do`.

Hospitals whose recorded `plan` is not a known plan (rows written before Phase 4, which
introduced plans) are backfilled as **ENTERPRISE**, not as the strictest plan. Those
hospitals predate the plan concept and had every module before Phase 4, so backfilling them
to STARTER would silently remove capabilities they were using. Give a hospital more than it
should pay for and the cost is visible in the console; take billing away from a hospital
that had it and the cost is invisible. Override with `--plan=HOSPITAL` when the commercial
answer is known.

Automatic provisioning at boot was rejected deliberately: a gate that quietly creates the
thing it checks for is not a gate, and it would make "no subscription" unreachable — which
is precisely the state that proves the gate fails closed. New tenants are unaffected,
because `approveHospital` provisions a subscription at approval time.

**Verify after deploying:**

```
npx tsx scripts/backfill-subscriptions.ts    # must report: Missing: 0
```

### Development

A MongoDB Atlas **M0 (free tier)** cluster is adequate for development. ⚠️ **M0 must never
be used for staging or production** — it provides no continuous backup, no point-in-time
restore and no advanced security controls.

### Production requirements

- Atlas **M10 or higher**
- Continuous cloud backup enabled
- Point-in-time restore enabled
- Network access restricted to the application subnet (IP allowlist)
- Separate clusters (or at least separate databases) per environment

### Indexes

Indexes are created by an explicit, idempotent migration runner — **not** implicitly on
boot. `MONGODB_AUTO_INDEX` is `false` for this reason: a driver-managed index build on a
large collection can block traffic.

⚠️ **NOT YET IMPLEMENTED** — `ensure-indexes` and the migration runner land in Phase 1.

### Backup and restore drill

⚠️ **NOT YET IMPLEMENTED** — required before go-live (see [`SECURITY.md`](./SECURITY.md) R16).

Procedure to be implemented and rehearsed:

1. Confirm continuous backup and PITR are enabled on the cluster.
2. Restore to a scratch cluster.
3. Run `npm run verify` against the restored data plus an integrity script.
4. Record the date, duration and outcome in this runbook.

**A backup that has never been restored is not a backup.**

---

## 4. Deployment

⚠️ **NOT YET IMPLEMENTED** — Phase 8.

Planned approach:

| Component | Target |
| --- | --- |
| `apps/api` | Container service (non-root user, multi-stage build, distroless runtime) |
| `apps/web` | Static hosting behind a CDN |
| Database | MongoDB Atlas (managed, region-pinned in India) |
| Secrets | Platform secret manager — never in the image, repo or CI logs |
| TLS | Terminated at the edge; HSTS enabled |

### Release procedure

1. Merge to `main` only after CI is green.
2. Build an immutable image tagged with the release version and its commit SHA.
3. Deploy to staging, run smoke tests against `/health/ready`.
4. Obtain explicit human approval before any production deployment.
5. Deploy to production; verify `/health` and `/health/ready`.
6. Watch error rate and p95 latency for 15 minutes.

### Rollback

Redeploy the previous immutable image tag. Database migrations must be backward-compatible
for one release window — never drop a field in the same release that stops writing to it.

---

## 5. Monitoring

| Signal | Alert threshold | Action |
| --- | --- | --- |
| `/health/ready` failing | 2 consecutive minutes | Investigate database connectivity |
| 5xx rate | > 1% over 5 min | Check logs by `requestId` |
| p95 latency | > 800 ms over 10 min | Check slow queries and index usage |
| Login failure spike | Sudden 3× increase | Possible credential stuffing — see §6 |
| Tenant scope errors | Any occurrence | **Investigate immediately** — see §6 |
| Backup failure | Any occurrence | Treat as an incident |

⚠️ **NOT YET IMPLEMENTED** — alerting and dashboards are a Phase 8 gate.

---

## 6. Incident procedures

### Suspected cross-tenant data access

**Highest severity.** Any `TENANT_SCOPE_REQUIRED` error, or any report of a user seeing
another hospital's data:

1. Disable the affected account (set membership status to suspended) and revoke sessions.
2. Preserve all logs and the audit trail. **Do not restart or re-deploy** — you will lose
   in-memory context.
3. Determine the blast radius from the audit trail: actor, hospital, time window, records.
4. Record a timeline. DPDP breach-notification obligations may apply.
5. Fix the root cause and add a regression test **before** restoring access.

### Suspected credential compromise

1. Revoke all refresh sessions for the account (`refresh_sessions.revokeByUser`).
2. Force a password reset.
3. Require MFA re-enrolment if it was enabled.
4. Review the audit trail for the account's recent activity.

### Security disclosure

Report privately to the Infinigrow Softech security contact. Do not open a public issue
containing exploit details or patient data.

---

## 7. Repository path warning

`scripts/check-workspace-path.ts` runs on every install and **fails CI** in strict mode.

The development path `C:\HOSPITAL MANAGEMENT SaaS` contains spaces. Node, npm, Git, Vite,
Vitest and ESLint were all verified working in Phase 0. Docker bind mounts, some shell
scripts and certain CI path handling remain untested until Phase 8. Renaming to
`C:\dev\infinigrow-hospital-cloud` remains the recommended mitigation.