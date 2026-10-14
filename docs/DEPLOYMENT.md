# Deployment, Operations and Release

**Status: guidance only. Nothing here has been executed. No infrastructure has been
provisioned, no environment built, and no production data exists.**

Read `docs/PRODUCTION-READINESS.md` first. Four findings block production; this document
assumes they have been closed.

Every item marked ⚠️ **APPROVAL REQUIRED** may involve a paid service, a DNS change, or
production data. **Do not proceed on any of them without explicit approval.**

---

## 1. Environments

Three environments, three configurations, no shared credentials between them.

| | Development | Staging | Production |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | `staging` | `production` |
| `MONGODB_DB_NAME` | `infinigrow_dev` | `infinigrow_staging` | `infinigrow_prod` |
| `ENABLE_API_DOCS` | `true` | `true` | **`false`** |
| `LOG_LEVEL` | `debug` | `info` | `warn` |
| `CORS_ORIGINS` | `http://localhost:5173` | staging origin | production origin |
| `TRUST_PROXY` | `false` | `true` | `true` |
| HSTS | disabled | enabled | enabled |
| Data | Fictional only | Synthetic, never copied from prod | Real |
| Backups | none | none (ephemeral) | **PITR + continuous** |

**Staging must never contain production data.** Copying real patient records into staging is
the most common way a staging environment becomes a compliance incident. Generate synthetic
data instead.

`apps/api/src/config/env.ts` **refuses to boot** in production with a placeholder secret or a
wildcard CORS origin, and reports every problem at once rather than one per restart.

---

## 2. Configuration files

### 2.1 `.env` — never committed

`.env` is git-ignored, `!.env.example` is tracked. Confirm before any commit:

```bash
git check-ignore -v .env           # must be ignored
git ls-files --error-unmatch .env  # must error
```

### 2.2 Required production variables

```dotenv
NODE_ENV=production
PORT=4000
HOST=0.0.0.0

# Full replica-set URI with credentials. MUST NOT be the dev localhost URI.
MONGODB_URI=mongodb+srv://APPUSER:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=infinigrow_prod
MONGODB_AUTO_INDEX=false

# Ed25519. Generate per environment; never reuse across environments.
#   node scripts/generate-jwt-keys.mjs
JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
JWT_ISSUER=https://api.example.com
JWT_AUDIENCE=infinigrow-web

# Exact origins. Never a wildcard in production.
CORS_ORIGINS=https://app.example.com

LOG_LEVEL=warn
ENABLE_API_DOCS=false
TRUST_PROXY=true
```

**Rotate the JWT key pair per environment.** A shared key means a staging compromise forges
production tokens. Key rotation invalidates every session; rotate during a low-traffic
window and expect users to sign in again.

### 2.3 Secrets management ⚠️ APPROVAL REQUIRED

The container must receive secrets without them entering the image, the build log or the
filesystem in plain text.

| Platform | Mechanism |
| --- | --- |
| AWS ECS | Secrets Manager → task definition `secrets` |
| AWS EKS | External Secrets Operator → Kubernetes Secret |
| GCP Cloud Run | Secret Manager → mounted env |
| Azure App Service | Key Vault references |
| Docker Compose (staging) | `env_file` with a file mode of `0600` |

**Never bake secrets into a `Dockerfile` with `ENV` or `ARG`.** `ARG` values persist in
image history even if the layer is later deleted.

### 2.4 Per-environment generation

```bash
node scripts/generate-jwt-keys.mjs     # JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
```

Generate a distinct pair for staging and production. Reuse is not a shortcut; it is a
cross-environment trust path.

---

## 3. Backend deployment

### 3.1 Build

```bash
npm ci                                  # from the lockfile, not `npm install`
NODE_OPTIONS=--max-old-space-size=3072 npm run build
```

The API project requires roughly **645 MB** for `tsc`. The default Node heap was
insufficient and caused an unrecoverable OOM — see `PRODUCTION-READINESS.md` F-01.

```bash
NODE_OPTIONS=--max-old-space-size=3072 npm run typecheck   # gate in CI
```

### 3.2 What ships

```
apps/api/dist/         368 files — compiled JS, type declarations, source maps
apps/web/dist/         static assets — serve from a CDN or reverse proxy
packages/shared/dist/  shared package consumed by both
```

### 3.3 Run

```bash
NODE_ENV=production node apps/api/dist/index.js
```

**Process manager:** systemd, or a container platform with restart policy. Do not run the
Node process directly under a shell in production; a restart on crash is a requirement, not
a nicety.

`systemd` sketch:

```ini
[Service]
Type=simple
User=infinigrow
WorkingDirectory=/srv/infinigrow
EnvironmentFile=/etc/infinigrow/api.env
ExecStart=/usr/bin/node apps/api/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/infinigrow
```

`ProtectSystem=strict` matters: the API should have no reason to write anywhere except its
document storage root.

### 3.4 Startup and health

`GET /health` is the liveness probe. Confirm it reports the DB connection state before
pointing a load balancer at the instance.

**Readiness:** the API calls `ensureIndexes()` on boot. During that window it is up but not
ready; hold traffic until `/health` is green rather than letting the first request through.

**Mongoose buffering:** `bufferCommands` is not disabled. If the DB is unreachable at
startup, queries buffer until the connection timeout. For a production deployment set a
short `serverSelectionTimeoutMS` (e.g. 5000) so the failure is fast and loud rather than a
30-second hang per request.

---

## 4. Frontend deployment

### 4.1 Build

```bash
npm run build --workspace @infinigrow/web
```

Produces a static SPA in `apps/web/dist/`.

### 4.2 ⚠️ Before building for production — two fixes

**Disable the production source map.** `apps/web/vite.config.ts:33` currently sets
`sourcemap: true` unconditionally, publishing a 3.3 MB map (F-06):

```ts
export default defineConfig(({ mode }) => ({
  build: { sourcemap: mode !== 'production' },
}))
```

If the map is wanted for error monitoring, upload it to the monitoring service at build
time and **do not** serve it. A published source map is a permanent disclosure.

### 4.3 Serve

The SPA needs a history fallback: any unknown path must return `index.html`, or a refresh
on `/patients/123` returns a 404.

```nginx
server {
  listen 443 ssl http2;
  server_name app.example.com;

  root /srv/infinigrow/apps/web/dist;
  index index.html;

  # History fallback for client-side routing.
  location / {
    try_files $uri $uri/ /index.html;
  }

  # Hashed assets are immutable; index.html must never be cached.
  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  location = /index.html {
    add_header Cache-Control "no-store";
  }

  # See PRODUCTION-READINESS.md F-02 for the full header set.
  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'" always;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Permissions-Policy "geolocation=(), camera=(), microphone=(), payment=()" always;
}
```

⚠️ `'unsafe-inline'` for `style-src` is likely required by Tailwind. Remove it if a nonce or
hash-based policy can be made to work.

### 4.4 Topology — ⚠️ DECISION REQUIRED before building

The CSRF posture depends on this. See `PRODUCTION-READINESS.md` §4.1.

**Recommended — same origin.** One hostname, reverse proxy:

```
https://app.example.com/        → static web build
https://app.example.com/api/*    → API on :4000
```

The browser sees one origin, CORS never applies, and the `HttpOnly, SameSite=Strict`
refresh cookie remains correct. The Vite dev proxy already mirrors this shape.

**Alternative — separate origins.** `app.` and `api.` on different hosts. Then the refresh
cookie is cross-site: `SameSite=Strict` stops it being sent at all, and relaxing it to
`None` removes CSRF protection. If you choose this, you must add an explicit CSRF defence
(custom header requirement, or double-submit token) **and** set `connect-src` in the web CSP
to the API origin.

**Do not deploy without answering this.**

---

## 5. Data stores

### 5.1 MongoDB ⚠️ APPROVAL REQUIRED — paid service

Atlas **M10 or higher**. **M0 (free tier) must never be used for staging or production** —
it has no continuous backup, no point-in-time restore and no advanced security controls.

Required configuration:

| Setting | Value |
| --- | --- |
| Tier | M10+ |
| Continuous cloud backup | **Enabled** |
| Point-in-time restore | **Enabled** |
| Retention | Per the agreed RPO |
| Network access | IP allowlist — application subnet only, never `0.0.0.0/0` |
| Authentication | Database-native (SCRAM) with a dedicated least-privilege app user |
| Encryption at rest | Atlas default, on |
| Multi-AZ | Required for availability |

The application user must **not** be the atlasAdmin user. Grant it read/write on the
application database only.

**Self-managed MongoDB** requires you to provide backups, TLS, authentication, replication
and monitoring yourself. It is not a supported production path for this project as
delivered.

### 5.2 Private object storage ⚠️ APPROVAL REQUIRED — paid service

Clinical PDFs and invoices are written by `apps/api/src/modules/clinical/file-store.ts`,
which currently writes to local disk. For production, point it at private object storage.

| Requirement | Value |
| --- | --- |
| Bucket ACL | **Private. No public access, ever.** |
| Public access block | Enabled at account level |
| Versioning | Enabled |
| Encryption | SSE-KMS with a customer-managed key |
| Access | Instance role / workload identity — **no long-lived access keys** |
| Lifecycle | Per the agreed retention policy |
| Logging | Access logs to a separate bucket |

**The local-disk adapter is not a production store.** It has no redundancy, no versioning
and no backup. It is a development adapter.

Download authorization already exists and is correct: files are served through an authorized
route with `private, no-store` and `nosniff`, never from a public URL.

### 5.3 File uploads — not currently possible

**There is no upload endpoint.** The application only writes server-generated PDFs. That is
why no malware scanning exists today, and it is the correct state rather than a gap to fill
in.

**Before any upload is added, all of these are required:**

1. Allow-list by MIME type **and** magic-byte inspection — never trust the client-declared
   type or extension.
2. Size limit enforced while streaming, not after buffering.
3. Filename discarded; a server-generated UUID is the stored name.
4. Written to quarantine, not directly to the readable bucket.
5. **Antivirus scan** (ClamAV, or a cloud scanner) before release.
6. Strip or neutralise active content (EXIF, macros, embedded scripts in PDFs).
7. Serve from a separate origin, or `Content-Disposition: attachment` with `nosniff`, so
   an uploaded HTML or SVG can never execute on the app origin.
8. Retention and deletion policy, so a patient can have their uploads removed.

### 5.4 Uploads and scans in CI

`npm audit` and gitleaks cover dependencies and secrets. They do **not** cover application
logic. CodeQL runs on JavaScript/TypeScript.

---

## 6. Backup and disaster recovery

**No backup has been taken. No restore has been attempted or verified. This section is a
procedure to execute, not a record of one.**

### 6.1 Objectives — must be agreed in writing

| | Definition |
| --- | --- |
| **RPO** | Maximum acceptable data loss. 24 h is a hospital losing a day's bookings; 1 h is losing surgeries. |
| **RTO** | Maximum acceptable downtime. |

**Neither is currently defined**, which means the backup configuration below cannot be
finalised. Agree these before enabling backups.

### 6.2 Checklist

**Database**

- [ ] Continuous backup enabled
- [ ] Point-in-time restore enabled
- [ ] Retention ≥ agreed RPO
- [ ] Backup bucket in a **separate project/account** from the primary — ransomware that
      reaches the primary must not reach the backup
- [ ] Backups encrypted with a key held separately from the database credentials
- [ ] Backup key **escrowed**; an unescrowed key makes encrypted backups unreadable exactly
      when they are needed

**Object storage**

- [ ] Versioning enabled
- [ ] Lifecycle rules configured for retention
- [ ] Versioning or a copy to a second bucket/region

**Configuration**

- [ ] `.env` for each environment escrowed (password manager, not a file on the server)
- [ ] DNS records recorded
- [ ] TLS certificate or its ACME account, if manually issued
- [ ] Infrastructure-as-code committed, if used

### 6.3 Restore rehearsal — BLOCKING

An untested backup is a hypothesis.

- [ ] Restore to a **scratch** cluster, never to production
- [ ] Time it end to end and record the figure
- [ ] Verify row counts against a pre-restore snapshot
- [ ] Verify a tenant can sign in and read its own records
- [ ] Verify **tenant isolation still holds after restore** — a restore that mixes tenants
      is worse than an outage
- [ ] Run the full test suite against the restored database
- [ ] **Repeat quarterly.** A restore procedure never rehearsed is a procedure nobody
      remembers

### 6.4 Documented failure modes

| Scenario | Response |
| --- | --- |
| Single API instance lost | Redeploy; database unaffected |
| Database primary lost | Atlas automatic failover; confirm the app reconnects |
| Region unavailable | Atlas cross-region restore; RTO is the restore time |
| Bad deploy | Rollback (§8) |
| Corrupt data | PITR to a point before the corruption |
| Ransomware | Restore to a clean environment; rotate **all** credentials; audit log is the evidence |
| Credential leak | Revoke and rotate; invalidate sessions; audit log shows who used the key |

---

## 7. Monitoring and alerting ⚠️ APPROVAL REQUIRED for third-party services

**No monitoring service is configured. The list below is a recommendation.**

### 7.1 Availability

| Signal | Threshold |
| --- | --- |
| `/health` failing | 2 consecutive failures → page |
| API p95 latency | > 500 ms for 5 min |
| API error rate (5xx) | > 1% for 5 min → page |
| Web page load | fail from 3 regions |

### 7.2 Data and correctness — the ones that catch silent damage

| Signal | Why it matters |
| --- | --- |
| **Audit log collection size** | Unbounded growth (F-05). Alert on growth rate, not just size |
| **Disk usage, any volume** | A full disk stops writes, not just logs |
| **MongoDB replication lag** | Silent read staleness |
| **Duplicate-key rate** | A spike means unique-index pressure — often a bot or a broken client |
| **Login failure rate** | Credential stuffing, or a user locked out by the rate limiter |
| **Refresh-token reuse detected** | Refresh reuse is treated as theft and revokes the family; alert on it |
| **Notification sweep not called** | Messages silently stop sending |
| **Tenant context errors** | Any `Tenant context is required` is a real defect and should page |

### 7.3 Privacy

| Signal | Why |
|---|---|
| **Audit log export** | Bulk export is the easiest data exfiltration path |
| **Platform-scope usage** | A platform operator reading across tenants should be rare and visible |
| **Log volume spike** | Can indicate a client logging something it should not |

### 7.4 Logging

Pino writes structured JSON with redaction at the serializer level, so sensitive values are
scrubbed even if a developer logs a raw object.

- Ship to a log aggregator with retention and **immutable** storage — the audit trail must
  be readable by operators but not editable by them.
- Never log patient names, diagnoses, tokens or contact details outside the redacted paths.
- Set `LOG_LEVEL=warn` in production; `info` is a cost and a data-exposure risk.

### 7.5 Uptime monitoring

An external heartbeat against `/health` from at least two regions. An in-process check
cannot detect a dead instance, which is the only case that matters.

---

## 8. Rollback plan

### 8.1 What can be rolled back, and what cannot

| Change | Rollback |
| --- | --- |
| Static web assets | **Yes, instantly** — previous files on disk or CDN |
| API code | **Yes** — previous image/tag |
| Environment variables | **Yes**, if recorded |
| Database schema (additive, indexed) | **Yes** — old code ignores new fields |
| Database schema (destructive) | **No** — needs a forward fix |
| Data written by the new version | **No** — must be reconciled |
| Secrets rotation | **No** — rotating out invalidates sessions by design |

**Any release containing a destructive migration needs a rehearsed forward-fix, not a
rollback.** That is a release blocker, not a rollback plan.

### 8.2 Rolling back

```bash
# 1. Identify the last known-good release.
git log --oneline -5

# 2. Redeploy the previous tag.
docker run ... registry.example.com/infinigrow-api:b511c47

# 3. Web: restore the previous build output.
rsync -a --delete releases/<previous>/ apps/web/dist/

# 4. Verify.
curl -fsS https://app.example.com/api/v1/health
curl -fsSI https://app.example.com/ | head -1
```

Blue/green or a rolling deployment makes step 3 a traffic switch rather than a rebuild.

### 8.3 Rollback triggers

Roll back if **any** of these hold:

- Error rate > 1% for 5 minutes
- p95 latency > 1 s for 10 minutes
- Any 5xx on sign-in
- **Any suspected tenant-isolation breach** — roll back first, investigate after. A leaked
  record cannot be un-leaked
- Data loss or corruption suspected
- Login success rate falls below baseline

For an isolation breach, **also** preserve the audit log before any remediation that might
overwrite it.

---

## 9. Release checklist

### Before

- [ ] `npm run verify` green: lint, typecheck, **1,052 tests**, build
- [ ] `npm audit` clean
- [ ] No secrets in the diff: `gitleaks detect --no-git`
- [ ] Migrations reviewed for **destructiveness** — if any is destructive, a rollback is not
      available and a forward fix must be rehearsed
- [ ] Backup taken and **restore verified** (F-04)
- [ ] Rollback rehearsed, not just written
- [ ] Release notes state every schema change and every behaviour change
- [ ] Support and on-call notified

### Deploy

- [ ] Deploy API, confirm `/health` including DB state
- [ ] Deploy web assets
- [ ] Confirm security headers present (F-02)
- [ ] Confirm no production source map served (F-06)
- [ ] Smoke test **per role** — admin, doctor, reception, accountant, super admin
- [ ] Verify tenant isolation with two tenants
- [ ] Verify a PDF download end to end
- [ ] Verify sign-in, refresh and sign-out

### After

- [ ] Error rate and latency normal
- [ ] Audit log growing
- [ ] No unexpected 4xx spike
- [ ] Notification sweep running (if scheduled)
- [ ] Rollback window agreed (e.g. 24 h)
- [ ] Release notes archived

### Never deploy

- With a destructive migration and no rehearsed forward fix
- With an unverified backup
- With a red `npm run verify`
- With a known open Critical or High finding from `PRODUCTION-READINESS.md`
- With real patient data in staging

---

## 10. Approval required

Nothing in this document has been executed. Before any of it is:

| # | Action | Approval |
| --- | --- | --- |
| 1 | Provision MongoDB Atlas M10+ (paid) | **Required** |
| 2 | Provision private object storage (paid) | **Required** |
| 3 | Register production domain, change DNS | **Required** |
| 4 | Issue/obtain TLS certificate | **Required** |
| 5 | Provision error monitoring (third party, receives app data) | **Required** |
| 6 | Provision uptime monitoring | Recommended |
| 7 | Redis for shared rate limiting (only if multi-instance) | Required if multi-instance |
| 8 | CDN/WAF in front of the static build (paid) | Recommended |
| 9 | **Create any production data** | **Required — after F-04** |

**Until these are approved and a restore has been rehearsed, this system stays in
development.**