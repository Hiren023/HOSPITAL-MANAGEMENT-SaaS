# Compliance Notes

**Infinigrow Hospital Cloud** · Infinigrow Softech

---

> ## ⚠️ This is not legal advice and not a certification
>
> This document describes how the software is **designed** with respect to the Digital
> Personal Data Protection Act, 2023 and its 2025 Rules, and general healthcare data
> practice. It is written by engineers, not lawyers.
>
> **No claim of regulatory compliance is made or implied.** Before handling any real
> patient data, Infinigrow Softech must obtain:
>
> 1. A qualified **legal review** of data-protection obligations, including the
>    controller/processor split between Infinigrow and each hospital.
> 2. A qualified **privacy impact assessment** for the processing itself.
> 3. **Security testing** by an independent party before production.
> 4. Confirmation of **breach-notification** responsibilities and timelines.
>
> Hospital customers are, in most arrangements, the Data Fiduciary and Infinigrow the Data
> Processor. That determination is a legal conclusion, not an engineering one.

---

## 1. Applicable framework

| Instrument | Relevance |
| --- | --- |
| Digital Personal Data Protection Act, 2023 | Primary data-protection statute for digital personal data in India |
| DPDP Rules, 2025 | Operational rules including notice, consent and grievance handling |
| Applicable healthcare regulations | Facility-level obligations vary by state; hospitals are best placed to advise |
| Industry standards | ISO 27001 / SOC 2 are **not** claimed or certified at this stage |

---

## 2. Principle-by-principle design

### 2.1 Lawful processing and purpose limitation

Data is collected for patient care delivery and hospital administration only. The platform
provides no mechanism for secondary use, advertising, or data brokerage. Any future
analytics or research feature requires a separate lawful-basis assessment and consent flow
— it is not implied by the existing consent.

### 2.2 Notice and consent

- A patient privacy notice is displayed at registration, with a version recorded on the
  patient record so historic consent can be evidenced.
- Consent status and timestamp are stored per patient.
- ⚠️ **NOT YET IMPLEMENTED** — the notice text, version tracking and consent withdrawal
  flow land with the patient module in Phase 3.

### 2.3 Data minimisation

- Role-scoped API responses. A finance user requesting an invoice does not receive the
  clinical notes attached to that visit — the fields are never serialised, not merely
  hidden in the UI.
- Optional fields are genuinely optional; nothing is collected "just in case".
- The audit trail records **field names** of what changed, never PHI values.

### 2.4 Purpose-specific storage limitation and retention

- ⚠️ **NOT YET IMPLEMENTED** — configurable retention windows, a purge job with legal-hold
  capability, and documented retention schedules land in Phase 8.

**Action required before go-live:** agree a retention schedule per data category with each
customer (for example: consultation notes retained for the period required by applicable
state clinical-records rules).

### 2.5 Integrity and confidentiality (security safeguards)

Implemented and tested in Phase 0:

| Safeguard | Where | Verified by |
| --- | --- | --- |
| Argon2id password hashing | Phase 1 | — |
| Tenant isolation by construction | `tenant-context.ts`, Mongoose plugin (Phase 1) | Context tests; isolation matrix in Phase 1 |
| Least-privilege RBAC | `packages/shared/src/types/role.ts` | 19 tests |
| TLS in transit | Deployment (Phase 8) | — |
| Encryption at rest | Atlas (paid tier) | — |
| Credential and PHI redaction in logs | `infrastructure/logger.ts` | 8 tests |
| No stack-trace or driver-message leakage | `middleware/error-handler.ts` | 13 tests |
| Security headers and CORS allowlist | `app.ts` | 16 tests |
| Fail-fast configuration validation | `config/env.ts` | 25 tests |

### 2.6 Data subject rights

| Right | Status |
| --- | --- |
| Access to information | Patient portal (post-MVP); hospital-admin export planned |
| Correction | Hospital-admin edit path; self-service in the patient portal |
| Erasure | ⚠️ **NOT YET IMPLEMENTED** — constrained by medical record-retention duties; a legal-hold-aware purge job is required |
| Grievance redressal | ⚠️ **NOT YET IMPLEMENTED** — channel and named grievance officer to be published |
| Data portability | Hospital-initiated export; design considered |

### 2.7 Accountability

- Every PHI read and write produces an audit record with actor, role, action, resource,
  timestamp, IP and request id.
- `audit_logs` is **append-only**: no update or delete route exists at any layer.
- ⚠️ **NOT YET IMPLEMENTED** — audit persistence and the audit log UI land in Phase 1 and 7.

### 2.8 Breach notification

⚠️ **NOT YET IMPLEMENTED** — a documented detection-to-notification procedure is a
**release gate**. The engineering hooks exist (`requestId` correlation, audit trail,
`Security.md` incident procedures); the legal workflow, timelines and responsible parties
must be agreed with counsel before go-live.

---

## 3. Role separation: a deliberate choice

`SUPER_ADMIN` holds **only** `platform:*` permissions. A SaaS operator can approve, suspend
and manage tenants commercially, but has **no default access to patient clinical data**.

This is intentional. Centralised "support access" to medical records is a common and
serious privacy failure mode. If genuine support access is later required, it must be a
separate, audited, time-boxed break-glass feature with customer notification — not an
implicit capability of the administrator role.

---

## 4. Known gaps and residual risk

| Gap | Severity | Planned phase |
| --- | --- | --- |
| No Data Processing Agreement template provided | **High** — commercial/legal | Before first customer |
| No grievance officer or published redressal channel | **High** | Phase 8 |
| No retention/purge implementation | **High** | Phase 8 |
| No breach-notification procedure | **High** | Phase 8 |
| No independent security assessment | **High** | Phase 8 |
| No multi-factor authentication | **High** | Phase 1 |
| No field-level encryption of clinical free text | Medium | Phase 8 |
| No data residency guarantee beyond Atlas region selection | Medium | Deployment decision |
| M0 free tier lacks backup and PITR | **Critical if used in production** | Deployment gate — M10+ mandatory |
| `SUPER_ADMIN` bulk-operations export | Medium | Deliberately excluded for now |

---

## 5. Field-level encryption: an explicit trade-off

Clinical free-text (consultation notes) is intended to be encrypted at the application
layer with AES-256-GCM, keys held in a KMS-backed secret manager.

Structured demographic fields deliberately remain **queryable and unencrypted at the
application layer**, relying on Atlas encryption at rest, TLS in transit, RBAC and the audit
trail. Encrypting them would break search, duplicate detection and reporting.

This is a conscious trade-off, recorded here so it is not mistaken for an oversight.

---

## 6. Test data policy

- Development and test data is **100% fictional**.
- Seed records use an obvious synthetic marker so a leaked fixture is instantly
  identifiable.
- ⚠️ The seeder is not yet implemented. When it is, it must refuse to run unless
  `NODE_ENV=development` **and** an explicit `--i-am-in-dev` flag is supplied, with a CI
  test asserting that refusal.

---

## 7. Recommendations to the business

1. Appoint a data-protection owner and publish a grievance channel before go-live.
2. Execute a Data Processing Agreement with each hospital customer.
3. Commission an independent penetration test before production.
4. Consider ISO 27001 certification as the product matures — not claimed today.
5. Complete a DPDP impact assessment for the platform itself.
6. Establish an ABHA/ABDM integration roadmap; interoperability is anticipated in the
   patient identifier design but is out of MVP scope.