# Specification — Module A: Notifications

**Status: awaiting approval. No code written.**
Phase 9, Change 2 of 3. Shipped **after** subscriptions, and **after** module B is scoped.

Built in isolation: its own module directory, its own permissions, its own router. Removing it
is deleting one directory and two route mounts.

---

## 1. Requirements

| # | Requirement |
| --- | --- |
| N1 | Email and SMS go through a **provider adapter**; swapping providers is one interface change. |
| N2 | Delivery status is tracked per attempt: `PENDING → SENT → DELIVERED / FAILED`, plus `BOUNCED` and `SUPPRESSED`. |
| N3 | Retries use **exponential backoff with a cap** and a maximum attempt count. A permanently failing message stops rather than retrying forever. |
| N4 | Consent and per-channel preferences are recorded and **enforced before sending**. |
| N5 | **No sensitive patient information in a notification preview.** No diagnosis, no test result, no medication, no consultation text — ever, in any channel. |
| N6 | A notification is never sent to a patient without a recorded consent for that channel. |
| N7 | Provider failure never loses the message; it is retained for retry and for audit. |
| N8 | Every send is auditable. |
| N9 | Rate limits are per-tenant, so one hospital cannot exhaust a shared provider quota. |

### Non-goals

No push notifications. No in-app chat. No inbound SMS handling. No marketing campaigns. No
delivery-receipt webhooks from a real provider — the default provider cannot send anything.

---

## 2. The preview rule, stated first because it is the hard constraint

**A notification body may contain only:** the recipient's own name, a date and time, a
location or department name, and a generic instruction.

**Never:** diagnosis, test results, medicines, dosages, consultation or prescription content,
clinical narrative, or a patient identifier in a channel a third party can read.

Concretely:

| Message | Preview |
| --- | --- |
| Appointment reminder | *"Your appointment is on 12 Oct at 10:30. Please arrive 10 minutes early."* |
| Consultation ready | *"A record is ready. Sign in to view it."* |
| Lab result ready | *"A report is available. Sign in to view it."* |
| Payment receipt | *"A receipt is available. Sign in to view it."* |

"Sign in to view it" is deliberate. The notification says **that** something exists; the
authorised application says **what**. An SMS is readable by whoever holds the phone, is stored
in the handset, and may pass through a gateway that logs it.

**Enforcement is a validator, not a convention.** `assertSafePreview()` rejects a body
matching clinical terms, a numeric result pattern, or an identifier, and a test asserts every
built-in template passes.

---

## 3. Schema

### `NotificationTemplate`
`{key, channel: EMAIL|SMS, locale, subject, body, previewSafe: true, active}`
One row per key per channel. Templates are **code-reviewed, not user-authored** — a
user-authored template is a way to leak a diagnosis into an SMS, so this MVP does not offer
one.

### `Notification` (tenant-scoped)
`{hospitalId, channel, templateKey, recipientRef, status, attempts, maxAttempts,
nextAttemptAt, providerMessageId, failureReason, createdAt, sentAt, deliveredAt}`

### `NotificationConsent`
`{hospitalId, recipientRef, channel, granted, grantedAt, revokedAt, source}`

### `NotificationPreference`
`{hospitalId, userId, channel, category, enabled}`

Indexes: `{hospitalId, status, nextAttemptAt}`, `{hospitalId, createdAt}`.

`recipientRef` is an opaque reference, **not** a phone number or email. Contact details are
looked up at send time from the patient or user record, so a wrong-number correction does not
require rewriting history.

---

## 4. API contract

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/notifications` | `notification:read` | List, filter by status |
| `GET` | `/notifications/:id` | `notification:read` | One, with attempts |
| `POST` | `/notifications` | `notification:send` | Enqueue. **Respects consent and preferences** |
| `POST` | `/notifications/:id/retry` | `notification:send` | Manual retry of a failed message |
| `GET` | `/notifications/preferences` | `notification:read` | My preferences |
| `PUT` | `/notifications/preferences` | `notification:read` | Update my preferences |
| `GET/PUT` | `/patients/:id/consents` | `patient:read` + `notification:send` | Consent record |
| `GET` | `/notifications/templates` | `notification:read` | Templates, for preview |

`POST /notifications` returns `202 Accepted` with `queued`, not `201 sent`. A queued
notification is not a delivered one, and the API should not imply otherwise.

---

## 5. Permissions

`notification:read` and `notification:send` **already exist** — no new permissions.

Granted to: HOSPITAL_ADMIN, DOCTOR, RECEPTIONIST, STAFF, PHARMACIST, ACCOUNTANT. Notably
**not** to SUPER_ADMIN, who has no hospital.

`notification:send` on a patient's behalf additionally requires `patient:read`. Reading a
notification is not consent to message that person.

---

## 6. Retry policy

| Attempt | Delay |
| --- | --- |
| 1 | immediate |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 (final) | give up → `FAILED` |

Capped at 6 attempts. A permanently invalid number fails fast (no retry) — retrying a
malformed address six times helps nobody and wastes provider quota.

Retries run on a sweep endpoint the platform invokes, **not** an in-process timer, because a
restarting server would silently drop the queue.

---

## 7. The provider adapter

```ts
interface NotificationProvider {
  readonly name: string
  readonly channel: 'EMAIL' | 'SMS'
  send(input: { to: string; subject?: string; body: string }): Promise<ProviderResult>
}
```

**`NullNotificationProvider`** is the default: returns `PENDING`, sends nothing, records
nothing externally. There is no code path in this MVP that reports `DELIVERED`, for the same
reason `PaymentProvider` cannot report `VERIFIED` — see `phase9-subscriptions.md` §7.

A real adapter is a separate change requiring a security review: it means credentials, PII
leaving the system, and vendor data-processing terms.

---

## 8. UI

- **In-app notification bell** — list, unread count, per-category preferences.
- **Consent capture** on the patient record, per channel, with a timestamp and source.
- **Delivery log** — status, attempts, failure reason, retry button.
- **Template preview** — shows exactly what would be sent, and the preview-safe assertion runs
  live in the form.

Consent is captured at registration and is revocable. Revocation stops future sends; it does
not delete history.

---

## 9. Tests (planned)

| Area | Cases |
| --- | --- |
| Preview safety | every built-in template passes; a template containing clinical terms is rejected; a numeric result pattern is rejected |
| Consent | send refused without consent; refused after revocation; granted consent permits |
| Preferences | disabled channel is not sent |
| Retry | backoff schedule; capped at 6; permanent failure stops; malformed address fails fast |
| Isolation | cross-tenant notification read is 404; consent of another tenant's patient is refused |
| Provider | `NullNotificationProvider` reports `PENDING`; **`DELIVERED` unreachable** |
| Audit | send, failure and retry all audited |
| PHI | assert no notification row contains a diagnosis, medicine name or patient identifier |

---

## 10. Decisions I want confirmed

1. **Category opt-out granularity.** Currently: channel (email/SMS) plus a category. Do you want patients to opt out of, say, *payment* messages while keeping *appointment* ones? I have assumed yes.
2. **Do appointment reminders require consent at all?** They are transactional, and many jurisdictions treat them differently from marketing. I have assumed **yes, consent required** — the strict reading — but this may be wrong and it is a legal question.
3. **Retention.** How long failed notifications are kept. I have assumed 90 days.
4. **Is an in-app-only mode acceptable for the MVP** — no SMS at all until a provider exists? I have assumed yes, since the default provider sends nothing anyway.
5. **Who may view delivery logs** — I have assumed `notification:read`, which includes a doctor. A delivery log can reveal *when a patient did or did not collect a message*, which is arguably sensitive.