import { Types, type Model } from 'mongoose'
import type { NotificationCategory, NotificationChannel, NotificationStatus } from '@infinigrow/shared'
import { MAX_ATTEMPTS, nextAttemptAt as computeNextAttempt } from '@infinigrow/shared'

import { ApiError } from '../../infrastructure/api-error.js'
import { withPlatformScope } from '../../infrastructure/db/tenant-plugin.js'
import {
  countViaAggregate,
  findManyViaAggregate,
  findPageViaAggregate,
} from '../../utilities/mongo-compat.js'
import { buildPageMeta } from '../../utilities/pagination.js'
import { AUDIT_ACTIONS } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'

import {
  NotificationConsentModel,
  NotificationModel,
  NotificationPreferenceModel,
} from './notification.models.js'
import { providerFor } from './notification-provider.js'
import { renderTemplate, templateByKey } from './notification.templates.js'

/**
 * Notifications.
 *
 * ── The three properties this module exists to guarantee ───────────────────────
 *
 * 1. **Nothing clinical reaches a message.** Templates are code with five substitutable
 *    values, the body is re-checked after substitution (because a patient's *name* is
 *    attacker-influenced and could itself contain a clinical term), and a refused body
 *    never enters the queue.
 *
 * 2. **Nothing is sent without consent.** Checked at enqueue *and* re-checked at send,
 *    because consent can be revoked in the minutes between the two, and a queue that only
 *    checks once will happily send a message to someone who withdrew consent after it was
 *    queued.
 *
 * 3. **A refusal is recorded, not hidden.** A suppressed notification is a row with a
 *    reason. "We did not message this patient" has to be answerable, because the question
 *    is asked after an incident and "no row" is indistinguishable from "we forgot".
 */

export interface NotificationActor {
  userId: string
  role: string
  hospitalId: string
  permissions: string[]
}

export interface Meta {
  ip: string
  requestId: string
}

type Row = Record<string, unknown>

const notifications = () => NotificationModel as unknown as Model<Row>
const consents = () => NotificationConsentModel as unknown as Model<Row>
const preferences = () => NotificationPreferenceModel as unknown as Model<Row>

function safeId(value: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw ApiError.notFound()
  return new Types.ObjectId(value)
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value
  // An ObjectId is what `recipientRef` actually holds. A `typeof value === 'string'` check
  // alone silently drops it to `null`, so the delivery log could not say WHICH recipient a
  // message was for — which is the first thing anybody reading it wants to know.
  if (value instanceof Types.ObjectId) return value.toHexString()
  if (value !== null && value !== undefined && typeof value === 'object' && '_id' in value) {
    return str((value as { _id: unknown })._id)
  }
  return null
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null
}

// ─────────────────────────── contact resolution ───────────────────────────

interface Contact {
  to: string | null
  displayName: string | null
  departmentName: string | null
  /** True when the address cannot possibly work, so it is not worth retrying. */
  malformed: boolean
}

const MISSING: Contact = { to: null, displayName: null, departmentName: null, malformed: false }

/**
 * Resolve a recipient to a contact point **now**.
 *
 * Lookup happens at send time rather than being stored, so correcting a wrong number fixes
 * the whole queue at once instead of leaving historical rows pointing at a number the
 * patient gave up using.
 *
 * An address that cannot work is reported as `malformed` so the caller can give up
 * immediately. Retrying a syntactically impossible number six times wastes provider quota
 * and delays the real failure someone needs to see.
 */
async function resolveContact(
  hospitalId: string,
  recipientKind: string,
  recipientRef: string,
): Promise<Contact> {
  const ref = safeId(recipientRef)

  if (recipientKind === 'USER') {
    const { UserModel } = await import('../identity/models.js')
    const user = await (
      UserModel as unknown as {
        aggregate<T>(stages: unknown[]): { exec(): Promise<T[]> }
      }
    )
      .aggregate<Row>([{ $match: { _id: ref } }, { $project: { firstName: 1, lastName: 1, email: 1 } }])
      .exec()

    const row = user[0]
    if (!row) return MISSING

    const email = str(row['email'])
    // A deliberately shallow check: a malformed address is a provider-level concern and
    // guessing at RFC 5322 here would reject addresses providers accept.
    const malformed = email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

    return {
      to: email,
      displayName: [str(row['firstName']), str(row['lastName'])].filter(Boolean).join(' ') || null,
      departmentName: null,
      malformed,
    }
  }

  const { PatientModel } = await import('../patients/patients.models.js')
  const patients = await (
    PatientModel as unknown as {
      aggregate<T>(stages: unknown[]): { exec(): Promise<T[]> }
    }
  )
    .aggregate<Row>([
      { $match: { _id: ref, hospitalId: safeId(hospitalId) } },
      { $project: { firstName: 1, lastName: 1, phone: 1, email: 1, departmentId: 1 } },
    ])
    .exec()

  const row = patients[0]
  if (!row) return MISSING

  const phone = str(row['phone'])
  const email = str(row['email'])

  // A phone is preferred over an email, so "will this address work" is a question about
  // the phone whenever there is one. E.164-ish: a leading `+` and 8-15 digits. Anything
  // else is refused by every carrier, so there is no point spending six attempts
  // discovering that.
  //
  // Note the shape: malformed means "we are going to use a phone, and it cannot work".
  // A patient with a bad phone AND a good email is contacted by email and is NOT malformed —
  // otherwise fixing the number would not be enough to stop wasting attempts.
  const usesPhone = phone !== null
  const phoneIsUsable = usesPhone && /^\+\d{8,15}$/.test(phone.replace(/[\s()\-.]/g, ''))

  let departmentName: string | null = null
  const departmentId = str(row['departmentId'])
  if (departmentId) {
    const { DepartmentModel } = await import('../hospital-admin/hospital-admin.models.js')
    const departments = await (
      DepartmentModel as unknown as {
        aggregate<T>(stages: unknown[]): { exec(): Promise<T[]> }
      }
    )
      .aggregate<Row>([{ $match: { _id: safeId(departmentId) } }, { $project: { name: 1 } }])
      .exec()
    departmentName = str(departments[0]?.['name'])
  }

  return {
    to: phone ?? email,
    displayName:
      [str(row['firstName']), str(row['lastName'])].filter(Boolean).join(' ') || null,
    departmentName,
    malformed: usesPhone && !phoneIsUsable,
  }
}

// ─────────────────────────── consent ───────────────────────────

/**
 * May we message this recipient on this channel right now?
 *
 * Re-checked at send time, not only at enqueue. Consent revoked a minute after a message
 * was queued must still stop it, and the only way to know that is to look again at the
 * moment of sending.
 */
async function consentAllows(
  hospitalId: string,
  recipientRef: string,
  channel: NotificationChannel,
): Promise<{ allowed: boolean; reason: 'NO_CONSENT' | 'CONSENT_REVOKED' | null }> {
  const rows = await findManyViaAggregate<Row>(
    consents() as unknown as Model<Row>,
    { hospitalId: safeId(hospitalId), recipientRef: safeId(recipientRef), channel },
    1,
  )

  const record = rows[0]
  if (!record) return { allowed: false, reason: 'NO_CONSENT' }
  if (record['granted'] === true && record['revokedAt'] == null) {
    return { allowed: true, reason: null }
  }
  return { allowed: false, reason: 'CONSENT_REVOKED' }
}

/** A staff member's own preference for this channel and category. Default is enabled. */
async function preferenceAllows(
  hospitalId: string,
  userId: string,
  channel: NotificationChannel,
  category: NotificationCategory,
): Promise<boolean> {
  const rows = await findManyViaAggregate<Row>(
    preferences() as unknown as Model<Row>,
    { hospitalId: safeId(hospitalId), userId: safeId(userId), channel, category },
    1,
  )

  const record = rows[0]
  // Absent means "no preference recorded", which is enabled. A staff member who never
  // opened the settings page should not silently receive nothing.
  return record === undefined || record['enabled'] !== false
}

// ─────────────────────────── enqueue ───────────────────────────

export interface EnqueueInput {
  templateKey: string
  recipientKind: 'PATIENT' | 'USER'
  recipientRef: string
  substitutions?: {
    recipientName?: string
    dateLabel?: string
    timeLabel?: string
    departmentName?: string
    locationName?: string
  }
}

export async function enqueueNotification(
  actor: NotificationActor,
  meta: Meta,
  input: EnqueueInput,
): Promise<unknown> {
  const definition = templateByKey(input.templateKey)
  if (!definition) {
    throw ApiError.badRequest('That is not a notification this system can send.')
  }
  if (!definition.active) {
    throw ApiError.badRequest('That notification is not currently available.')
  }

  const now = new Date()
  const contact = await resolveContact(
    actor.hospitalId,
    input.recipientKind,
    input.recipientRef,
  )

  const substitutions = { ...input.substitutions }
  if (substitutions.recipientName === undefined) {
    substitutions.recipientName = contact.displayName ?? undefined
  }

  // ── Render and refuse before anything is written ─────────────────────────────
  //
  // The check happens on the rendered text, not the template, because a substituted value
  // comes from a patient record and a patient can choose a name. Rendering first and
  // validating second means a clinical term typed as a name is caught here rather than in
  // a carrier's logs.
  // The result is deliberately discarded. Rendering exists here to be VALIDATED; the body
  // is re-derived from the template and the stored substitutions at send time, and is
  // never persisted. Storing it would put message text — which after substitution carries a
  // patient-supplied name — into the most exportable table in the system, and the preview
  // rule is not worth that for the convenience of not recomputing five strings.
  try {
    renderTemplate(definition, substitutions)
  } catch {
    throw ApiError.badRequest(
      'That message could not be composed safely. No clinical detail may appear in a notification.',
    )
  }

  // ── Consent for patients, preference for staff ──────────────────────────────────
  //
  // These are different relationships and conflating them produces nonsense. Consent is
  // something a patient gives; it defaults to ABSENT, because sending a message to
  // somebody who never agreed is the harm.
  //
  // A preference is a staff member's own choice about their own channel; it defaults to
  // ENABLED, because a receptionist who has never opened a settings page must still
  // receive their appointment reminders. Asking a doctor to consent to email before
  // emailing them is the same mistake in the other direction.
  let suppressionReason: string | null = null

  if (input.recipientKind === 'PATIENT') {
    const consent = await consentAllows(
      actor.hospitalId,
      input.recipientRef,
      definition.channel,
    )
    if (!consent.allowed) suppressionReason = consent.reason
  } else {
    const allowed = await preferenceAllows(
      actor.hospitalId,
      input.recipientRef,
      definition.channel,
      definition.category,
    )
    if (!allowed) suppressionReason = 'PREFERENCE_DISABLED'
  }

  if (suppressionReason === null && !contact.to) suppressionReason = 'NO_CONTACT_DETAILS'

  // The row is written EITHER WAY. A suppressed notification is a record that somebody
  // tried and was stopped, which is the only way to answer "did we contact this patient?"
  // after the fact.
  const status: NotificationStatus = suppressionReason ? 'SUPPRESSED' : 'PENDING'

  const created = await notifications().create({
    hospitalId: safeId(actor.hospitalId),
    channel: definition.channel,
    templateKey: definition.key,
    recipientKind: input.recipientKind,
    recipientRef: safeId(input.recipientRef),
    category: definition.category,
    status,
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    nextAttemptAt: status === 'PENDING' ? computeNextAttempt(0, now) : null,
    suppressionReason,
    substitutions,
    enqueuedByUserId: safeId(actor.userId),
    attemptsLog: [],
  })

  await recordAudit({
    action: AUDIT_ACTIONS.NOTIFICATION_ENQUEUED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Notification',
    resourceId: String(created['_id']),
    ip: meta.ip,
    requestId: meta.requestId,
    // Deliberately not the rendered body. The audit trail is the most widely readable log
    // in the system; a copy of the message there would undo the preview rule.
    metadata: {
      templateKey: definition.key,
      channel: definition.channel,
      status,
      suppressionReason: suppressionReason ?? null,
    },
  })

  return presentNotification(created.toObject() as Row)
}

// ─────────────────────────── the queue ───────────────────────────

/**
 * Attempt one delivery.
 *
 * Separated from the sweep so a single message can be retried on demand and so both paths
 * share exactly one implementation — two code paths for "did it go out?" is how the two
 * start disagreeing.
 */
export async function attemptDelivery(notificationId: string): Promise<unknown> {
  const rows = await findManyViaAggregate<Row>(
    notifications() as unknown as Model<Row>,
    { _id: safeId(notificationId) },
    1,
  )
  const row = rows[0]
  if (!row) throw ApiError.notFound()

  const status = String(row['status']) as NotificationStatus
  if (status !== 'PENDING') {
    // Retrying a delivered, failed or suppressed message is not a no-op to guess at.
    throw ApiError.conflict(`This notification is ${status.toLowerCase()} and cannot be sent.`)
  }

  const attempts = Number(row['attempts'] ?? 0)
  const now = new Date()

  const contact = await resolveContact(
    String(row['hospitalId']),
    String(row['recipientKind']),
    String(row['recipientRef']),
  )

  // Consent is checked AGAIN here, not only at enqueue. Revocation can land between the
  // two, and a queue that checked once would send to someone who withdrew consent after it
  // was queued. Staff recipients are gated on preference, which is the same relationship
  // with a different default.
  const isPatient = String(row['recipientKind']) === 'PATIENT'
  const refusal = isPatient
    ? await consentAllows(
        String(row['hospitalId']),
        String(row['recipientRef']),
        row['channel'] as NotificationChannel,
      )
    : await preferenceAllows(
        String(row['hospitalId']),
        String(row['recipientRef']),
        row['channel'] as NotificationChannel,
        row['category'] as NotificationCategory,
      ).then((allowed) => ({
        allowed,
        reason: allowed ? null : ('PREFERENCE_DISABLED' as const),
      }))

  const definition = templateByKey(String(row['templateKey']))
  if (!definition) {
    return await finishAttempt(row, attempts, 'PERMANENT', 'Template no longer exists.', now)
  }

  if (!refusal.allowed) {
    // `reason` is nullable on the refusal union; reaching this branch means it is not.
    return await finishAttempt(
      row,
      attempts,
      'PERMANENT',
      refusal.reason ?? 'Refused before sending.',
      now,
    )
  }

  if (!contact.to) {
    return await finishAttempt(row, attempts, 'PERMANENT', 'NO_CONTACT_DETAILS', now)
  }

  if (contact.malformed) {
    // No retry. Six attempts at a syntactically impossible address spends provider quota
    // and delays the failure someone needs to act on.
    return await finishAttempt(row, attempts, 'PERMANENT', 'Address is not deliverable', now)
  }

  let rendered: { subject: string | null; body: string }
  try {
    rendered = renderTemplate(definition, (row['substitutions'] ?? {}) as never)
  } catch {
    return await finishAttempt(row, attempts, 'PERMANENT', 'UNSAFE_PREVIEW', now)
  }

  const reference = String(row['_id'])
  const outcome = await providerFor(definition.channel).send({
    to: contact.to,
    subject: rendered.subject ?? undefined,
    body: rendered.body,
    reference,
  })

  if (outcome.outcome === 'PERMANENT') {
    return await finishAttempt(row, attempts, 'PERMANENT', outcome.reason, now)
  }

  if (outcome.outcome === 'TRANSIENT') {
    return await finishAttempt(row, attempts, 'TRANSIENT', outcome.reason, now)
  }

  // ACCEPTED. Stored as SENT with the provider's reference. NOT `DELIVERED` — the provider
  // accepted it for delivery and that is the entire extent of what anybody knows.
  await notifications().updateOne(
    { _id: row['_id'] },
    {
      $set: {
        status: 'SENT',
        attempts: attempts + 1,
        nextAttemptAt: null,
        providerMessageId: outcome.providerMessageId,
        sentAt: now,
      },
      $push: {
        attemptsLog: {
          attempt: attempts + 1,
          at: now,
          outcome: 'ACCEPTED',
          providerMessageId: outcome.providerMessageId,
        },
      },
    },
  )

  const after = await findManyViaAggregate<Row>(
    notifications() as unknown as Model<Row>,
    { _id: row['_id'] },
    1,
  )
  return presentNotification(after[0] ?? row)
}

/** Record a non-successful attempt and decide whether another one is scheduled. */
async function finishAttempt(
  row: Row,
  attempts: number,
  kind: 'PERMANENT' | 'TRANSIENT',
  reason: string,
  now: Date,
): Promise<unknown> {
  const usedAttempts = attempts + 1
  const exhausted = usedAttempts >= Number(row['maxAttempts'] ?? MAX_ATTEMPTS)

  // A permanent failure never retries, regardless of how many attempts remain.
  const willRetry = kind === 'TRANSIENT' && !exhausted
  const scheduled = willRetry ? computeNextAttempt(usedAttempts, now) : null

  await notifications().updateOne(
    { _id: row['_id'] },
    {
      $set: {
        status: willRetry ? 'PENDING' : 'FAILED',
        attempts: usedAttempts,
        nextAttemptAt: scheduled,
        failureReason: reason,
      },
      $push: {
        attemptsLog: { attempt: usedAttempts, at: now, outcome: kind, reason },
      },
    },
  )

  const after = await findManyViaAggregate<Row>(
    notifications() as unknown as Model<Row>,
    { _id: row['_id'] },
    1,
  )
  return presentNotification(after[0] ?? row)
}

/**
 * Process everything due.
 *
 * A sweep endpoint the platform invokes, **not** an in-process timer. A timer dies with
 * the process, so a restart silently drops the queue with nothing to notice; an endpoint
 * the platform calls has a retry and a log line.
 *
 * `limit` exists because an unbounded sweep against a large queue is a request that never
 * returns, which is its own outage.
 */
export async function sweepNotifications(
  meta: Meta,
  options: { limit?: number; now?: Date } = {},
): Promise<{ examined: number; sent: number; failed: number }> {
  const now = options.now ?? new Date()
  const limit = Math.max(1, Math.min(200, options.limit ?? 50))

  // Lifted deliberately. A sweep runs on the platform's behalf across every tenant, and
  // the tenant plugin throws rather than defaulting to "all tenants" — which is the right
  // behaviour for an accidental cross-tenant read and the wrong one for an audited sweep.
  return withPlatformScope(async () => {
    const due = await findManyViaAggregate<Row>(
      notifications() as unknown as Model<Row>,
      { status: 'PENDING', nextAttemptAt: { $lte: now } },
      limit,
    )

    let sent = 0
    let failed = 0

    for (const row of due) {
      try {
        const result = (await attemptDelivery(String(row['_id']))) as Row | null
        const status = result === null ? 'FAILED' : String(result['status'])
        if (status === 'SENT') sent += 1
        else failed += 1
      } catch {
        // One poisoned message must not stop the sweep. The row keeps its `PENDING` status
        // and will be retried, which is the correct outcome for an unexpected error.
        failed += 1
      }
    }

    await recordAudit({
      action: AUDIT_ACTIONS.NOTIFICATION_SWEEP,
      actorUserId: '',
      actorRole: 'SYSTEM',
      resourceType: 'Notification',
      resourceId: 'sweep',
      ip: meta.ip,
      requestId: meta.requestId,
      metadata: { examined: due.length, sent, failed },
    })

    return { examined: due.length, sent, failed }
  })
}

/** Manual retry of a message that failed. Resets the schedule but not the counter's cap. */
export async function retryNotification(
  actor: NotificationActor,
  meta: Meta,
  notificationId: string,
): Promise<unknown> {
  const rows = await findManyViaAggregate<Row>(
    notifications() as unknown as Model<Row>,
    { _id: safeId(notificationId) },
    1,
  )
  const row = rows[0]
  if (!row) throw ApiError.notFound()

  const status = String(row['status'])
  if (status !== 'FAILED') {
    throw ApiError.conflict(`Only a failed notification can be retried; this one is ${status}.`)
  }

  const attempts = Number(row['attempts'] ?? 0)
  if (attempts >= Number(row['maxAttempts'] ?? MAX_ATTEMPTS)) {
    throw ApiError.conflict(
      'This notification has used every attempt. Enqueue a new one rather than resetting the limit.',
    )
  }

  await notifications().updateOne(
    { _id: row['_id'] },
    { $set: { status: 'PENDING', nextAttemptAt: computeNextAttempt(attempts, new Date()) } },
  )

  await recordAudit({
    action: AUDIT_ACTIONS.NOTIFICATION_RETRIED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Notification',
    resourceId: notificationId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { templateKey: row['templateKey'], previousStatus: status },
  })

  return attemptDelivery(notificationId)
}

// ─────────────────────────── reads ───────────────────────────

export async function listNotifications(
  actor: NotificationActor,
  meta: Meta,
  query: { page?: number; pageSize?: number; status?: NotificationStatus },
): Promise<unknown> {
  const page = Math.max(1, query.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20))

  const match: Row = { hospitalId: safeId(actor.hospitalId) }
  if (query.status) match['status'] = query.status

  // `findPageViaAggregate` returns the ROWS, not an envelope — it takes an options object
  // and resolves to `T[]`. Reading `.rows`/`.total` off it yields `undefined` for both,
  // which renders as "nothing has been queued yet" forever while rows exist. The helper's
  // own comment calls this failure out: it is indistinguishable from a filter that matched
  // nothing. The total is a separate count, as every other list in this codebase does it.
  const rows = await findPageViaAggregate<Row>(
    notifications() as unknown as Model<Row>,
    {
      match,
      sort: { createdAt: -1 },
      skip: (page - 1) * pageSize,
      limit: pageSize,
    },
  )
  const total = await countViaAggregate(notifications() as unknown as Model<Row>, match)

  // An OBJECT, not positional arguments. `buildPageMeta` destructures its input, so passing
  // positionally returns an envelope of `undefined` — a `totalPages: 0` that makes a
  // populated list look empty. The same mistake as `findPageViaAggregate` above, from the
  // same habit of guessing a helper's shape instead of reading it.
  return {
    items: rows.map(presentNotification),
    meta: buildPageMeta({ requestId: meta.requestId, page, pageSize, total }),
  }
}

export async function readNotification(actor: NotificationActor, id: string): Promise<unknown> {
  const rows = await findManyViaAggregate<Row>(
    notifications() as unknown as Model<Row>,
    { _id: safeId(id), hospitalId: safeId(actor.hospitalId) },
    1,
  )
  if (!rows[0]) throw ApiError.notFound()
  return presentNotification(rows[0])
}

// ─────────────────────────── consent and preferences ───────────────────────────

export async function readConsents(
  actor: NotificationActor,
  recipientKind: 'PATIENT' | 'USER',
  recipientRef: string,
): Promise<unknown> {
  const rows = await findManyViaAggregate<Row>(
    consents() as unknown as Model<Row>,
    { hospitalId: safeId(actor.hospitalId), recipientRef: safeId(recipientRef) },
    50,
  )

  return {
    recipientKind,
    recipientRef,
    consents: rows.map((row) => ({
      channel: row['channel'],
      granted: row['granted'] === true,
      grantedAt: iso(row['grantedAt']),
      revokedAt: iso(row['revokedAt']),
      source: row['source'] ?? null,
    })),
  }
}

/**
 * Record a consent decision.
 *
 * Upsert rather than append, because "revoke" must be able to flip the one row that
 * decides the answer. An append-only consent log is cleaner history and a worse control:
 * a naive read finds the first record and revocation silently does nothing.
 */
export async function recordConsent(
  actor: NotificationActor,
  meta: Meta,
  input: {
    recipientKind: 'PATIENT' | 'USER'
    recipientRef: string
    channel: NotificationChannel
    granted: boolean
    source?: string
  },
): Promise<unknown> {
  const now = new Date()
  const existingRows = await findManyViaAggregate<Row>(
    consents() as unknown as Model<Row>,
    { hospitalId: safeId(actor.hospitalId), recipientRef: safeId(input.recipientRef), channel: input.channel },
    1,
  )

  // ── `grantedAt` is never cleared ──────────────────────────────────────────────
  //
  // Revoking flips `granted` and stamps `revokedAt`; it does not erase when consent was
  // first given. "When did this patient withdraw consent" is a question with a legal
  // answer attached, and it is only answerable if the original date survives the
  // withdrawal.
  //
  // Nulling `grantedAt` on revoke — which is what this did first — loses exactly the
  // history the spec says a revocation must preserve, and it made the UI read a withdrawn
  // consent as "not granted", collapsing two different facts into one.
  const previous = existingRows[0]
  const grantedAt = input.granted
    ? now
    : ((previous?.['grantedAt'] as Date | undefined) ?? null)

  await consents().updateOne(
    {
      hospitalId: safeId(actor.hospitalId),
      recipientRef: safeId(input.recipientRef),
      channel: input.channel,
    },
    {
      $set: {
        granted: input.granted,
        grantedAt,
        revokedAt: input.granted ? null : now,
        source: input.source ?? null,
        recordedByUserId: safeId(actor.userId),
        recipientKind: input.recipientKind,
      },
    },
    { upsert: true },
  )

  await recordAudit({
    action: input.granted
      ? AUDIT_ACTIONS.NOTIFICATION_CONSENT_GRANTED
      : AUDIT_ACTIONS.NOTIFICATION_CONSENT_REVOKED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'NotificationConsent',
    resourceId: input.recipientRef,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { channel: input.channel, source: input.source ?? null },
  })

  return readConsents(actor, input.recipientKind, input.recipientRef)
}

export async function readMyPreferences(actor: NotificationActor): Promise<unknown> {
  const rows = await findManyViaAggregate<Row>(
    preferences() as unknown as Model<Row>,
    { hospitalId: safeId(actor.hospitalId), userId: safeId(actor.userId) },
    50,
  )

  return {
    items: rows.map((row) => ({
      channel: row['channel'],
      category: row['category'],
      enabled: row['enabled'] !== false,
    })),
  }
}

export async function updateMyPreference(
  actor: NotificationActor,
  input: { channel: NotificationChannel; category: NotificationCategory; enabled: boolean },
): Promise<unknown> {
  await preferences().updateOne(
    {
      hospitalId: safeId(actor.hospitalId),
      userId: safeId(actor.userId),
      channel: input.channel,
      category: input.category,
    },
    { $set: { enabled: input.enabled } },
    { upsert: true },
  )

  return readMyPreferences(actor)
}

// ─────────────────────────── presentation ───────────────────────────

/**
 * Shape a notification for the API.
 *
 * The rendered body is **not** included. A delivery-log screen needs to know what was
 * attempted and what happened, not to reprint the message — and every surface that can
 * show a body is another surface through which clinical text could escape. The template
 * key and the recipient reference are enough to look it up in the templates screen, which
 * is where a human would want it.
 */
function presentNotification(row: Row): Row {
  return {
    id: String(row['_id']),
    channel: row['channel'],
    templateKey: row['templateKey'],
    recipientKind: row['recipientKind'],
    recipientRef: str(row['recipientRef']),
    category: row['category'],
    status: row['status'],
    attempts: Number(row['attempts'] ?? 0),
    maxAttempts: Number(row['maxAttempts'] ?? MAX_ATTEMPTS),
    nextAttemptAt: iso(row['nextAttemptAt']),
    providerMessageId: str(row['providerMessageId']),
    failureReason: str(row['failureReason']),
    suppressionReason: str(row['suppressionReason']),
    sentAt: iso(row['sentAt']),
    deliveredAt: iso(row['deliveredAt']),
    createdAt: iso(row['createdAt']),
    attemptsLog: Array.isArray(row['attemptsLog'])
      ? (row['attemptsLog'] as Row[]).map((entry) => ({
          attempt: entry['attempt'] ?? null,
          at: iso(entry['at']),
          outcome: entry['outcome'] ?? null,
          reason: str(entry['reason']),
        }))
      : [],
  }
}