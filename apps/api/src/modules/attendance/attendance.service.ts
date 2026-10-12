import { Types, type Model } from 'mongoose'
import type { Permission } from '@infinigrow/shared'
import { HOSPITAL_DEFAULTS } from '@infinigrow/shared'

import { ApiError } from '../../infrastructure/api-error.js'
import {
  countViaAggregate,
  findManyViaAggregate,
  findPageViaAggregate,
} from '../../utilities/mongo-compat.js'
import { localDateKey, parseInstant } from '../../utilities/hospital-time.js'

import { AUDIT_ACTIONS, type AuditAction } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'
import { HospitalModel, UserModel } from '../identity/models.js'

import { AttendanceRecordModel } from './attendance.models.js'

/**
 * Staff attendance.
 *
 * ── Why this is a workflow and not a form with an edit button ────────────────
 *
 * An attendance record is evidence of where a person was. If it could be edited freely it
 * would be worth nothing — anyone could make it agree with whatever they needed it to
 * agree with, and the record would still look authoritative.
 *
 * So the record is written once by the person themselves, at the moment it happened, and
 * anything after that is a REQUEST with a reason which a holder of `attendance:approve`
 * accepts or rejects. Both the original and the corrected value are kept, so the record
 * shows what was claimed and what was authorised.
 *
 * That is the same principle as amendments on a finalized clinical record: preserve what
 * was originally asserted, and make the change visible rather than silent.
 *
 * Scoping mirrors Phase 6: `attendance:read` / `attendance:write` are self-scoped; `:any`
 * reaches the whole team. Only a hospital administrator holds `:any` by default — a
 * hospital can grant it to front desk, but that should be a deliberate decision rather
 * than a default that quietly widens who can read a colleague's day.
 */

export interface AttendanceActor {
  userId: string
  role: string
  hospitalId: string
  permissions: Permission[]
}

export interface Meta {
  ip: string
  requestId: string
}

type Row = Record<string, unknown>

const attendanceModel = () => AttendanceRecordModel as unknown as Model<Row>
const userModel = () => UserModel as unknown as Model<Row>

/**
 * `findManyViaAggregate` takes POSITIONAL arguments — `(model, match, limit, project)`.
 * Passing it the options object `findPageViaAggregate` accepts compiles fine and matches
 * nothing at all, so the shape is wrapped once rather than restated at every call.
 */
function findMany(model: Model<Row>, match: Row, limit = 1000): Promise<Row[]> {
  return findManyViaAggregate<Row>(model, match, limit)
}

function can(actor: AttendanceActor, permission: Permission): boolean {
  return actor.permissions.includes(permission)
}

function safeId(value: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw ApiError.notFound()
  return new Types.ObjectId(value)
}

async function audit(
  action: AuditAction,
  actor: AttendanceActor,
  meta: Meta,
  resourceId: string,
): Promise<void> {
  await recordAudit({
    hospitalId: actor.hospitalId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action,
    resourceType: 'Attendance',
    resourceId,
    outcome: 'SUCCESS',
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: {},
  })
}

async function loadTimezone(hospitalId: string): Promise<string> {
  const hospital = await (
    HospitalModel as unknown as {
      findById(id: Types.ObjectId): { lean(): { exec(): Promise<Row | null> } }
    }
  )
    .findById(new Types.ObjectId(hospitalId))
    .lean()
    .exec()

  const settings = (hospital?.['settings'] ?? {}) as { timezone?: string }
  return settings.timezone ?? HOSPITAL_DEFAULTS.timezone
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000
}

// ──────────────────────────── check in / out ────────────────────────────

/**
 * Check in.
 *
 * The timestamp comes from the server clock, never from the caller. Accepting a
 * client-supplied check-in time would let anyone record an eight-hour shift by setting
 * their device back, which defeats the entire purpose of keeping the record. The
 * correction workflow exists for the cases where the server clock is not the truth.
 *
 * One record per person per day is enforced by a UNIQUE index rather than by a lookup
 * here — a check-then-insert has a race window, and two reception desks pressing the
 * button at the same moment is exactly the situation it would lose. The duplicate-key
 * error IS the answer.
 */
export async function checkIn(actor: AttendanceActor, meta: Meta): Promise<unknown> {
  const timezone = await loadTimezone(actor.hospitalId)
  const now = new Date()
  const workDate = localDateKey(now, timezone)

  let created: Row

  try {
    const record = await attendanceModel().create({
      // Tenant id from the session, never from the request.
      hospitalId: safeId(actor.hospitalId),
      userId: safeId(actor.userId),
      workDate,
      checkInAt: now,
      status: 'OPEN',
      recordedByUserId: safeId(actor.userId),
    })

    created = toRow(record)
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw ApiError.conflict(`You have already checked in on ${workDate}`)
    }
    throw error
  }

  await audit(AUDIT_ACTIONS.ATTENDANCE_CHECKED_IN, actor, meta, String(created['_id']))
  const [item] = await decorate([created])
  return item
}

export async function checkOut(actor: AttendanceActor, meta: Meta): Promise<unknown> {
  const timezone = await loadTimezone(actor.hospitalId)
  const workDate = localDateKey(new Date(), timezone)

  const existing = await loadOwnDay(actor, workDate)

  if (existing['status'] === 'CLOSED') {
    throw ApiError.conflict('You have already checked out today')
  }

  const checkInAt = existing['checkInAt'] as Date
  const checkOutAt = new Date()

  // A checkout before the check-in would produce a negative shift, which is nonsense and
  // would be indistinguishable from a data-entry error in every report downstream.
  if (checkOutAt.getTime() < checkInAt.getTime()) {
    throw ApiError.badRequest('Check-out cannot be before check-in')
  }

  // Compare-and-swap on the status we read, rather than an operator such as
  // `{ status: { $ne: 'CLOSED' } }`. Mongoose cannot cast an operator against an enum-typed
  // path and answers a CastError, which surfaces as a confusing 422 about a field the
  // caller never sent. Matching the exact value we checked keeps the same guarantee and
  // casts cleanly.
  await attendanceModel().updateOne(
    { _id: safeId(String(existing['_id'])), status: existing['status'] },
    { $set: { checkOutAt, status: 'CLOSED' } },
  )

  await audit(AUDIT_ACTIONS.ATTENDANCE_CHECKED_OUT, actor, meta, String(existing['_id']))

  const [row] = await findMany(attendanceModel(), { _id: safeId(String(existing['_id'])) }, 1)
  const [item] = await decorate([row ?? existing])
  return item
}

async function loadOwnDay(actor: AttendanceActor, workDate: string): Promise<Row> {
  const [row] = await findMany(
    attendanceModel(),
    { userId: safeId(actor.userId), workDate },
    1,
  )

  if (!row) throw ApiError.conflict('You have not checked in today')
  return row
}

// ────────────────────────────── reading ──────────────────────────────

/** My own attendance. Available to anyone who can record their own attendance. */
export async function listMyAttendance(
  actor: AttendanceActor,
  _meta: Meta,
  query: Row,
): Promise<unknown> {
  const page = Number(query['page'] ?? 1)
  const pageSize = Number(query['pageSize'] ?? 20)

  const match: Row = { userId: safeId(actor.userId) }
  if (query['workDate']) match['workDate'] = String(query['workDate'])

  const rows = await findPageViaAggregate<Row>(attendanceModel(), {
    match,
    sort: { workDate: -1 },
    skip: (page - 1) * pageSize,
    limit: pageSize,
  })
  const total = await countViaAggregate(attendanceModel(), match)

  return {
    items: await decorate(rows),
    page: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}

/**
 * The team view for a day.
 *
 * Requires `attendance:read:any`. Without it the route refuses rather than substituting the
 * caller's own records — a report that silently shows the wrong person is worse than one
 * that says no.
 */
export async function listAttendance(
  actor: AttendanceActor,
  _meta: Meta,
  query: Row,
): Promise<unknown> {
  if (!can(actor, 'attendance:read:any')) {
    throw ApiError.forbidden('Viewing the whole team needs attendance:read:any')
  }

  const page = Number(query['page'] ?? 1)
  const pageSize = Number(query['pageSize'] ?? 20)
  const timezone = await loadTimezone(actor.hospitalId)

  const workDate = query['workDate']
    ? String(query['workDate'])
    : localDateKey(new Date(), timezone)

  const match: Row = { workDate }
  if (query['userId']) match['userId'] = new Types.ObjectId(String(query['userId']))
  if (query['status']) match['status'] = String(query['status'])

  const rows = await findPageViaAggregate<Row>(attendanceModel(), {
    match,
    sort: { checkInAt: 1 },
    skip: (page - 1) * pageSize,
    limit: pageSize,
  })
  const total = await countViaAggregate(attendanceModel(), match)

  return {
    workDate,
    timezone,
    items: await decorate(rows),
    page: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}

// ────────────────────────────── corrections ──────────────────────────────

/**
 * Request a correction.
 *
 * The requester does not change the record. They record what they believe the time
 * should be and why, and the record is untouched until an approver accepts it.
 */
export async function requestCorrection(
  actor: AttendanceActor,
  meta: Meta,
  recordId: string,
  input: { field: 'checkInAt' | 'checkOutAt'; value: string; reason: string },
): Promise<unknown> {
  const record = await loadScoped(actor, recordId)

  const pending = correctionsOf(record).filter((entry) => entry['decision'] === undefined)
  if (pending.length > 0) {
    throw ApiError.conflict(
      'A correction is already pending on this record. Wait for it to be decided before asking for another.',
    )
  }

  const requestedValue = parseInstant(input.value)

  // A correction that would produce a negative shift is a correction with a typo in it.
  // Catching it here, with a message naming the problem, is kinder than letting it
  // through to surface in a report three weeks later.
  assertShiftStaysSane(record, input.field, requestedValue)

  await attendanceModel().updateOne(
    { _id: safeId(recordId) },
    {
      $push: {
        corrections: {
          field: input.field,
          previousValue: record[input.field] ?? null,
          requestedValue,
          reason: input.reason,
          requestedByUserId: safeId(actor.userId),
          requestedAt: new Date(),
        },
      },
    },
  )

  await audit(AUDIT_ACTIONS.ATTENDANCE_CORRECTION_REQUESTED, actor, meta, recordId)

  const [row] = await findMany(attendanceModel(), { _id: safeId(recordId) }, 1)
  const [item] = await decorate([row ?? record])
  return item
}

function assertShiftStaysSane(
  record: Row,
  field: 'checkInAt' | 'checkOutAt',
  value: Date,
): void {
  const other = field === 'checkInAt' ? 'checkOutAt' : 'checkInAt'
  const otherValue = record[other]

  // Nothing to be consistent with yet — an open shift can take any check-in.
  if (!(otherValue instanceof Date)) return

  // Express the rule in terms of the whole shift rather than per field, because the two
  // cases point in opposite directions and writing it per field inverts one of them:
  // check-in is the START, so it must remain before the end. Getting that backwards
  // accepts a check-in moved past the check-out and rejects a perfectly valid one.
  const correctedCheckIn = field === 'checkInAt' ? value : otherValue
  const correctedCheckOut = field === 'checkOutAt' ? value : otherValue

  if (correctedCheckIn.getTime() < correctedCheckOut.getTime()) return

  throw ApiError.badRequest(
    field === 'checkInAt'
      ? 'A corrected check-in cannot be at or after the check-out'
      : 'A corrected check-out cannot be at or before the check-in',
  )
}

/**
 * Approve or reject a pending correction.
 *
 * Requires `attendance:approve`. An approver cannot decide their own correction: that
 * would be self-approval of an audit record, which defeats the point of having a second
 * person at all.
 */
export async function decideCorrection(
  actor: AttendanceActor,
  meta: Meta,
  recordId: string,
  decision: 'APPROVED' | 'REJECTED',
  input: { note?: string },
): Promise<unknown> {
  if (!can(actor, 'attendance:approve')) {
    throw ApiError.forbidden('Approving an attendance correction needs attendance:approve')
  }

  const record = await loadScoped(actor, recordId)
  const corrections = correctionsOf(record)

  const pendingIndex = corrections.findIndex((entry) => entry['decision'] === undefined)
  if (pendingIndex === -1) {
    throw ApiError.conflict('There is no correction awaiting a decision on this record')
  }

  const pending = corrections[pendingIndex]
  if (!pending) {
    throw ApiError.conflict('There is no correction awaiting a decision on this record')
  }

  if (String(pending['requestedByUserId']) === actor.userId) {
    throw ApiError.forbidden('You cannot decide your own attendance correction')
  }

  const set: Row = {}

  if (decision === 'APPROVED') {
    // Only an APPROVED correction changes the record. A rejection must leave it exactly as
    // it was, including its status — marking a rejected record `CORRECTED` would claim a
    // change happened when none did, which is the precise thing this workflow exists to
    // make impossible.
    set['status'] = 'CORRECTED'

    // The ORIGINAL value stays inside the correction entry, so "corrected" means "changed,
    // and here is what it was before" rather than "changed, and the evidence is gone".
    set[pending['field'] as string] = pending['requestedValue']
  }

  await attendanceModel().updateOne(
    { _id: safeId(recordId) },
    {
      $set: {
        ...set,
        [`corrections.${pendingIndex}.decision`]: decision,
        [`corrections.${pendingIndex}.decidedByUserId`]: safeId(actor.userId),
        [`corrections.${pendingIndex}.decidedAt`]: new Date(),
        [`corrections.${pendingIndex}.decisionNote`]: input.note,
      },
    },
  )

  await audit(
    decision === 'APPROVED'
      ? AUDIT_ACTIONS.ATTENDANCE_CORRECTION_APPROVED
      : AUDIT_ACTIONS.ATTENDANCE_CORRECTION_REJECTED,
    actor,
    meta,
    recordId,
  )

  const [row] = await findMany(attendanceModel(), { _id: safeId(recordId) }, 1)
  const [item] = await decorate([row ?? record])
  return item
}

function correctionsOf(record: Row): Row[] {
  return Array.isArray(record['corrections']) ? (record['corrections'] as Row[]) : []
}

async function loadScoped(actor: AttendanceActor, recordId: string): Promise<Row> {
  const [row] = await findMany(attendanceModel(), { _id: safeId(recordId) }, 1)
  if (!row) throw ApiError.notFound()

  const own = String(row['userId']) === actor.userId
  if (!own && !can(actor, 'attendance:read:any')) throw ApiError.notFound()

  return row
}

// ────────────────────────────── decoration ──────────────────────────────

function toRow(doc: unknown): Row {
  return (doc as { toObject?: () => Row }).toObject?.() ?? (doc as Row)
}

async function decorate(rows: Row[]): Promise<Row[]> {
  const ids = uniqueUserIds(rows.map((row) => row['userId']))
  const users = ids.length ? await findMany(userModel(), { _id: { $in: ids } }, 500) : []

  const names = new Map(
    users.map((row) => [
      String(row['_id']),
      [row['firstName'], row['lastName']].filter(Boolean).join(' '),
    ]),
  )

  return rows.map((row) => {
    const checkInAt = row['checkInAt'] as Date
    const checkOutAt = row['checkOutAt'] instanceof Date ? (row['checkOutAt'] as Date) : null

    return {
      id: String(row['_id']),
      userId: String(row['userId']),
      userName: names.get(String(row['userId'])) ?? null,
      workDate: row['workDate'],
      checkInAt: checkInAt.toISOString(),
      checkOutAt: checkOutAt ? checkOutAt.toISOString() : null,
      status: row['status'],
      /** Hours worked, derived here rather than stored so it cannot drift. */
      hoursWorked:
        checkOutAt && checkOutAt.getTime() > checkInAt.getTime()
          ? Number(((checkOutAt.getTime() - checkInAt.getTime()) / 3_600_000).toFixed(2))
          : null,
      corrections: correctionsOf(row).map((entry) => ({
        field: entry['field'],
        previousValue:
          entry['previousValue'] instanceof Date
            ? (entry['previousValue'] as Date).toISOString()
            : null,
        requestedValue:
          entry['requestedValue'] instanceof Date
            ? (entry['requestedValue'] as Date).toISOString()
            : null,
        reason: entry['reason'],
        requestedByUserId: entry['requestedByUserId']
          ? String(entry['requestedByUserId'])
          : null,
        requestedAt:
          entry['requestedAt'] instanceof Date
            ? (entry['requestedAt'] as Date).toISOString()
            : null,
        decision: entry['decision'] ?? null,
        decisionNote: entry['decisionNote'] ?? null,
        decidedByUserId: entry['decidedByUserId'] ? String(entry['decidedByUserId']) : null,
        decidedAt:
          entry['decidedAt'] instanceof Date ? (entry['decidedAt'] as Date).toISOString() : null,
      })),
    }
  })
}

function uniqueUserIds(values: unknown[]): Types.ObjectId[] {
  const seen = new Set<string>()
  const ids: Types.ObjectId[] = []

  for (const value of values) {
    const id = String(value)
    if (id === 'null' || id === 'undefined' || seen.has(id)) continue
    if (!Types.ObjectId.isValid(id)) continue
    seen.add(id)
    ids.push(new Types.ObjectId(id))
  }

  return ids
}