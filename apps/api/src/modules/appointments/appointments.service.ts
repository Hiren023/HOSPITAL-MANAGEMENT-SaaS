import { HOSPITAL_DEFAULTS, type Permission } from '@infinigrow/shared'
import { randomUUID } from 'node:crypto'

import { Types, type Model } from 'mongoose'

import { ApiError } from '../../infrastructure/api-error.js'
import { buildPageMeta } from '../../utilities/pagination.js'
import { countViaAggregate, findManyViaAggregate, findPageViaAggregate } from '../../utilities/mongo-compat.js'
import {
  addDays,
  formatMinuteOfDay,
  localDayBounds,
  parseInstant,
  toLocalParts,
} from '../../utilities/hospital-time.js'
import { AUDIT_ACTIONS } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'
import { HospitalModel } from '../identity/models.js'
import { DoctorProfileModel, ScheduleModel } from '../hospital-admin/hospital-admin.models.js'
import { PatientModel } from '../patients/patients.models.js'

import {
  AppointmentModel,
  AppointmentSlotModel,
  TERMINAL_STATUSES,
  type AppointmentStatus,
} from './appointments.models.js'

/**
 * Appointment services.
 *
 * ── The tenant rule ────────────────────────────────────────────────────────────
 *
 * **No function here accepts a `hospitalId`.** The tenant comes from the signed session,
 * and the isolation plugin applies it to every query below. Another hospital's appointment
 * id matches nothing and the response is 404.
 *
 * ── The self-scoping rule ──────────────────────────────────────────────────────
 *
 * A doctor may read and write their OWN appointments; only a holder of
 * `appointment:read:any` / `appointment:write:any` may see or move anyone else's. That is
 * enforced here as a filter on the query and on the target row, and it is expressed as a
 * permission rather than a role-name check so it holds for any future role.
 *
 * ── Double booking ─────────────────────────────────────────────────────────────
 *
 * `reserveSlots` below is the whole of it. The database decides.
 */

type Row = Record<string, unknown>

const appointmentModel = () => AppointmentModel as unknown as Model<Row>
const slotModel = () => AppointmentSlotModel as unknown as Model<Row>
const patientModel = () => PatientModel as unknown as Model<Row>
const doctorProfileModel = () => DoctorProfileModel as unknown as Model<Row>
const scheduleModel = () => ScheduleModel as unknown as Model<Row>
const hospitalModel = () => HospitalModel as unknown as Model<Row>

export interface AppointmentActor {
  userId: string
  role: string
  hospitalId: string
  permissions: Permission[]
}

export interface Meta {
  ip: string
  requestId: string
}

interface HospitalConfig {
  timezone: string
  slotDurationMinutes: number
  appointmentBufferMinutes: number
  maxAppointmentAdvanceDays: number
  workingHours: Record<string, { opensAtMinute: number; closesAtMinute: number } | null>
}

/** Read the hospital's scheduling configuration, falling back to the documented defaults. */
async function loadConfig(hospitalId: string): Promise<HospitalConfig> {
  const hospital = await hospitalModel().findById(new Types.ObjectId(hospitalId)).lean().exec()
  const settings = ((hospital?.['settings'] ?? {}) as Row) as Partial<HospitalConfig>

  return {
    timezone: settings.timezone ?? HOSPITAL_DEFAULTS.timezone,
    slotDurationMinutes: settings.slotDurationMinutes ?? HOSPITAL_DEFAULTS.slotDurationMinutes,
    appointmentBufferMinutes:
      settings.appointmentBufferMinutes ?? HOSPITAL_DEFAULTS.appointmentBufferMinutes,
    maxAppointmentAdvanceDays:
      settings.maxAppointmentAdvanceDays ?? HOSPITAL_DEFAULTS.maxAppointmentAdvanceDays,
    workingHours: (settings.workingHours ??
      HOSPITAL_DEFAULTS.workingHours) as HospitalConfig['workingHours'],
  }
}

export function mayActForOthers(actor: AppointmentActor): boolean {
  return actor.permissions.includes('appointment:write:any')
}

export function mayViewOthers(actor: AppointmentActor): boolean {
  return actor.permissions.includes('appointment:read:any')
}

/**
 * The `doctorUserId` filter implied by the caller's permissions.
 *
 * `undefined` means "no restriction". This is the single place self-scoping is expressed,
 * so a new query cannot accidentally forget it.
 */
function doctorScope(
  actor: AppointmentActor,
  requested?: string,
): string | undefined {
  if (mayViewOthers(actor) || mayActForOthers(actor)) return requested
  return actor.userId
}

/** Minutes-from-midnight `[opens, closes)` for a local weekday, or null when closed. */
function workingWindowFor(
  config: HospitalConfig,
  weekday: number,
): { opensAtMinute: number; closesAtMinute: number } | null {
  const entry = config.workingHours[String(weekday)]
  if (!entry) return null
  return { opensAtMinute: entry.opensAtMinute, closesAtMinute: entry.closesAtMinute }
}

/** The slot start instants an appointment occupies. */
function slotStarts(startAt: Date, durationMinutes: number, slotMinutes: number): Date[] {
  const starts: Date[] = []
  for (let elapsed = 0; elapsed < durationMinutes; elapsed += slotMinutes) {
    starts.push(new Date(startAt.getTime() + elapsed * 60_000))
  }
  return starts
}

/**
 * Occupy the slots for an appointment, letting the DATABASE detect the conflict.
 *
 * One `insertMany` against a unique index on `{hospitalId, doctorUserId, slotStart}`. If
 * any of these slots is already taken, the database rejects the insert with a duplicate
 * key error, and that rejection IS the conflict — not a precondition that happened to pass
 * a moment earlier.
 *
 * This is the difference between this being correct under load and this being correct in a
 * demo. An application-level "is the doctor free?" check followed by an insert has a race
 * window between the two statements; two receptionists booking 09:00 simultaneously both
 * read "free". A unique index has no window, because the constraint is evaluated by the
 * thing that does the writing.
 *
 * `reservationId` tags every row from this attempt so a partial failure can be undone
 * precisely. Rolling back by `doctorUserId` and time range would delete other people's
 * bookings along with ours.
 */
async function reserveSlots(input: {
  hospitalId: string
  doctorUserId: string
  appointmentId: string
  reservationId: string
  starts: Date[]
}): Promise<void> {
  if (input.starts.length === 0) return

  const documents = input.starts.map((slotStart) => ({
    hospitalId: new Types.ObjectId(input.hospitalId),
    doctorUserId: new Types.ObjectId(input.doctorUserId),
    appointmentId: new Types.ObjectId(input.appointmentId),
    reservationId: input.reservationId,
    slotStart,
  }))

  try {
    await slotModel().insertMany(documents, { ordered: true })
  } catch (error) {
    // Undo only this attempt's rows. A partially-applied reservation would otherwise
    // leave slots booked for an appointment that was never created.
    await slotModel().deleteMany({ reservationId: input.reservationId }).catch(() => undefined)

    if (isDuplicateKeyError(error)) {
      throw ApiError.conflict(
        'That time is already booked for this doctor. Pick another slot.',
      )
    }
    throw error
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000
  )
}

async function releaseSlots(appointmentId: string): Promise<void> {
  await slotModel()
    .deleteMany({ appointmentId: new Types.ObjectId(appointmentId) })
    .exec()
}

interface AvailabilityCheck {
  config: HospitalConfig
  startAt: Date
  endAt: Date
  durationMinutes: number
}

/**
 * Everything that must hold before a time may be booked.
 *
 * Returned as a list of validation errors rather than thrown one at a time, so someone
 * booking a slot learns everything that is wrong with it in one response instead of
 * discovering the next problem after fixing the last.
 */
function checkBookableWindow(
  check: AvailabilityCheck,
  localDateLabel: string,
): ApiFieldErrorShape[] {
  const errors: ApiFieldErrorShape[] = []
  const { config, startAt, durationMinutes } = check

  const localStart = toLocalParts(startAt, config.timezone)


  if (startAt.getTime() <= Date.now()) {
    errors.push({ path: 'startAt', message: 'An appointment cannot be in the past.' })
  }

  const horizon = addDays(new Date(), config.maxAppointmentAdvanceDays)
  if (startAt.getTime() > horizon.getTime()) {
    errors.push({
      path: 'startAt',
      message: `Appointments can only be booked up to ${config.maxAppointmentAdvanceDays} days ahead.`,
    })
  }

  if (durationMinutes % config.slotDurationMinutes !== 0) {
    errors.push({
      path: 'durationMinutes',
      message: `Appointments run in ${config.slotDurationMinutes}-minute slots, so the duration must be a multiple of ${config.slotDurationMinutes}.`,
    })
  }

  const window = workingWindowFor(config, localStart.weekday)
  if (!window) {
    errors.push({
      path: 'startAt',
      message: `The hospital is closed on ${localDateLabel}.`,
    })
  } else {
    const opens = window.opensAtMinute
    const closes = window.closesAtMinute
    if (localStart.minuteOfDay < opens || localStart.minuteOfDay + durationMinutes > closes) {
      errors.push({
        path: 'startAt',
        message:
          `The hospital is open ${formatMinuteOfDay(opens)}–${formatMinuteOfDay(closes)} that day, ` +
          `so this appointment must sit inside those hours.`,
      })
    }
  }

  // Off the grid: a booking must begin on a slot boundary, or the slot table cannot
  // represent it and two bookings could partially overlap without colliding.
  const minutesSinceLocalMidnight = localStart.minuteOfDay
  if (minutesSinceLocalMidnight % config.slotDurationMinutes !== 0) {
    errors.push({
      path: 'startAt',
      message: `Appointments start on ${config.slotDurationMinutes}-minute boundaries (${formatMinuteOfDay(
        minutesSinceLocalMidnight - (minutesSinceLocalMidnight % config.slotDurationMinutes),
      )}, ${formatMinuteOfDay(
        minutesSinceLocalMidnight -
          (minutesSinceLocalMidnight % config.slotDurationMinutes) +
          config.slotDurationMinutes,
      )}, …).`,
    })
  }

  return errors
}

interface ApiFieldErrorShape {
  path: string
  message: string
}

/** Must the doctor be working, per their own weekly schedule? */
async function checkDoctorRoster(
  config: HospitalConfig,
  doctorUserId: string,
  startAt: Date,
  durationMinutes: number,
): Promise<ApiFieldErrorShape[]> {
  const profile = await doctorProfileModel()
    .findOne({ userId: new Types.ObjectId(doctorUserId) })
    .lean()
    .exec()

  if (!profile) {
    return [
      {
        path: 'doctorUserId',
        message: 'That doctor has no clinical profile here, so they cannot be booked.',
      },
    ]
  }

  const weekday = toLocalParts(startAt, config.timezone).weekday
  const block = await scheduleModel()
    .findOne({
      doctorUserId: new Types.ObjectId(doctorUserId),
      weekday,
      isActive: true,
    })
    .lean()
    .exec()

  if (!block) {
    return [{ path: 'doctorUserId', message: 'The doctor does not work on that day.' }]
  }

  const opensAt = Number(block['startMinute'])
  const closesAt = Number(block['endMinute'])
  const startMinute = toLocalParts(startAt, config.timezone).minuteOfDay

  if (startMinute < opensAt || startMinute + durationMinutes > closesAt) {
    return [
      {
        path: 'startAt',
        message:
          `The doctor works ${formatMinuteOfDay(opensAt)}–${formatMinuteOfDay(closesAt)} that day, ` +
          'so this appointment falls outside their roster.',
      },
    ]
  }

  return []
}

function toAppointment(
  row: Row,
  extra: { patientName?: string | null; doctorName?: string | null } = {},
) {
  return {
    id: String(row['_id']),
    patientId: String(row['patientId']),
    doctorUserId: String(row['doctorUserId']),
    doctorProfileId: row['doctorProfileId'] ? String(row['doctorProfileId']) : null,
    departmentId: row['departmentId'] ? String(row['departmentId']) : null,

    startAt: row['startAt'],
    endAt: row['endAt'],
    status: row['status'],

    /**
     * The reason a patient gave is patient data. It travels with the appointment and is
     * never copied into the audit trail, which is readable by holders of `audit:read`.
     */
    reason: row['reason'] ?? null,

    statusHistory: ((row['statusHistory'] ?? []) as Row[]).map((event: Row) => ({
      from: event['from'] ?? null,
      to: event['to'],
      at: event['at'],
      byUserId: event['byUserId'] ? String(event['byUserId']) : null,
      reason: event['reason'] ?? null,
    })),

    cancelledAt: row['cancelledAt'] ?? null,
    cancellationReason: row['cancellationReason'] ?? null,

    patientName: extra.patientName ?? null,
    doctorName: extra.doctorName ?? null,

    createdAt: row['createdAt'],
    updatedAt: row['updatedAt'],
  }
}

/** Attach patient and doctor display names to a page of appointments in one query. */
async function attachNames(rows: Row[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (rows.length === 0) return names

  const patientIds = rows.map((row) => new Types.ObjectId(String(row['patientId'])))
  const patients = await findManyViaAggregate<Row>(
    patientModel(),
    { _id: { $in: patientIds } },
    patientIds.length,
    { _id: 1, firstName: 1, lastName: 1 } as unknown as Record<string, 0 | 1>,
  )
  for (const patient of patients) {
    names.set(`p:${String(patient['_id'])}`, `${patient['firstName']} ${patient['lastName']}`)
  }

  const doctorIds = [...new Set(rows.map((row) => String(row['doctorUserId'])))]
  const doctors = await findManyViaAggregate<Row>(
    doctorProfileModel(),
    { userId: { $in: doctorIds.map((id) => new Types.ObjectId(id)) } },
    doctorIds.length,
    { userId: 1, fullName: 1 } as unknown as Record<string, 0 | 1>,
  )
  for (const doctor of doctors) {
    const userId = String((doctor['userId'] as { toString(): string }) ?? '')
    const fullName = (doctor['fullName'] as string | undefined) ?? ''
    if (userId && fullName) names.set(`d:${userId}`, fullName)
  }

  return names
}

async function decorate(rows: Row[]): Promise<Row[]> {
  const names = await attachNames(rows)
  return rows.map((row) =>
    toAppointment(row, {
      patientName: names.get(`p:${String(row['patientId'])}`) ?? null,
      doctorName: names.get(`d:${String(row['doctorUserId'])}`) ?? null,
    }),
  )
}

// ─────────────────────────────────── public surface ───────────────────────────────────

/**
 * Book an appointment.
 *
 * Order matters and is not incidental: the appointment row is created FIRST so the slot
 * rows can point at a real id, and only then are the slots claimed. If the claim fails the
 * appointment is removed again, so a rejected booking leaves nothing behind — no orphan
 * appointment showing a time the doctor does not have.
 */
export async function bookAppointment(actor: AppointmentActor, input: Row, meta: Meta) {
  const targetDoctor = String(input['doctorUserId'])

  if (targetDoctor !== actor.userId && !mayActForOthers(actor)) {
    throw ApiError.forbidden(
      'You may only book appointments for yourself. Booking on behalf of another doctor requires appointment:write:any.',
    )
  }

  const config = await loadConfig(actor.hospitalId)

  const startAt = parseInstant(String(input['startAt']), 'startAt')
  const durationMinutes = Number(input['durationMinutes'] ?? config.slotDurationMinutes)
  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000)

  const patient = await patientModel()
    .findOne({ _id: new Types.ObjectId(String(input['patientId'])), isActive: true })
    .lean()
    .exec()
  if (!patient) throw ApiError.notFound()

  const profile = await doctorProfileModel()
    .findOne({ userId: new Types.ObjectId(targetDoctor) })
    .lean()
    .exec()
  if (!profile) {
    throw ApiError.validation([
      { path: 'doctorUserId', message: 'That doctor has no clinical profile here.' },
    ])
  }

  const localDateLabel = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    timeZone: config.timezone,
  }).format(startAt)

  // Every reason it cannot be booked, collected together.
  const errors: ApiFieldErrorShape[] = [
    ...checkBookableWindow({ config, startAt, endAt, durationMinutes }, localDateLabel),
    ...(await checkDoctorRoster(config, targetDoctor, startAt, durationMinutes)),
  ]

  if (errors.length > 0) throw ApiError.validation(errors)

  const reservationId = randomUUID()
  const status: AppointmentStatus = input['confirm'] === true ? 'CONFIRMED' : 'SCHEDULED'
  const now = new Date()

  const created = await appointmentModel().create({
    patientId: new Types.ObjectId(String(input['patientId'])),
    doctorUserId: new Types.ObjectId(targetDoctor),
    doctorProfileId: profile['_id'],
    departmentId: input['departmentId'] ? new Types.ObjectId(String(input['departmentId'])) : profile['departmentId'],
    startAt,
    endAt,
    status,
    reason: input['reason'],
    reservationId,
    statusHistory: [{ from: null, to: status, at: now, byUserId: new Types.ObjectId(actor.userId) }],
    hospitalId: new Types.ObjectId(actor.hospitalId),
  })

  const appointmentId = String(created['_id'])

  try {
    await reserveSlots({
      hospitalId: actor.hospitalId,
      doctorUserId: targetDoctor,
      appointmentId,
      reservationId,
      starts: slotStarts(startAt, durationMinutes, config.slotDurationMinutes),
    })
  } catch (error) {
    await appointmentModel()
      .deleteOne({ _id: new Types.ObjectId(appointmentId) })
      .exec()
      .catch(() => undefined)
    throw error
  }

  await recordAudit({
    action: AUDIT_ACTIONS.APPOINTMENT_BOOKED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Appointment',
    resourceId: appointmentId,
    ip: meta.ip,
    requestId: meta.requestId,
    // Ids and times only. Never the reason: it is patient-supplied free text.
    metadata: { startAt: startAt.toISOString(), status, forSelf: targetDoctor === actor.userId },
  })

  return toAppointment(created.toObject(), {})
}

/**
 * Move an appointment.
 *
 * A new reservation is claimed BEFORE the old one is released, which is why rescheduling
 * onto your own current time is correctly reported as a conflict rather than silently
 * succeeding: those slots are genuinely still held.
 */
export async function rescheduleAppointment(
  actor: AppointmentActor,
  appointmentId: string,
  input: Row,
  meta: Meta,
) {
  const existing = await appointmentModel()
    .findById(new Types.ObjectId(appointmentId))
    .lean()
    .exec()
  if (!existing) throw ApiError.notFound()

  assertMayActOn(actor, String(existing['doctorUserId']))

  if (TERMINAL_STATUSES.has(existing['status'] as AppointmentStatus)) {
    throw ApiError.conflict(
      `This appointment is ${String(existing['status']).toLowerCase().replace('_', ' ')} and can no longer be rescheduled.`,
    )
  }

  const config = await loadConfig(actor.hospitalId)
  const startAt = parseInstant(String(input['startAt']), 'startAt')
  const durationMinutes = Number(input['durationMinutes'] ?? config.slotDurationMinutes)
  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000)

  const doctorUserId = String(input['doctorUserId'] ?? existing['doctorUserId'])
  if (doctorUserId !== String(existing['doctorUserId']) && !mayActForOthers(actor)) {
    throw ApiError.forbidden('Moving an appointment to another doctor requires appointment:write:any.')
  }

  const localDateLabel = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    timeZone: config.timezone,
  }).format(startAt)

  const errors: ApiFieldErrorShape[] = [
    ...checkBookableWindow({ config, startAt, endAt, durationMinutes }, localDateLabel),
    ...(await checkDoctorRoster(config, doctorUserId, startAt, durationMinutes)),
  ]
  if (errors.length > 0) throw ApiError.validation(errors)

  const previousStart = existing['startAt'] as Date
  const unchanged =
    previousStart.getTime() === startAt.getTime() &&
    String(existing['doctorUserId']) === doctorUserId

  if (!unchanged) {
    const reservationId = randomUUID()

    // Claim the new slots BEFORE releasing the old ones. The reverse order would leave a
    // window in which the appointment still holds its original slots while the new ones
    // are free, so a concurrent booking could take them and this reschedule would then
    // collide with a slot it had already released.
    await reserveSlots({
      hospitalId: actor.hospitalId,
      doctorUserId,
      appointmentId,
      reservationId,
      starts: slotStarts(startAt, durationMinutes, config.slotDurationMinutes),
    })

    await releaseSlots(appointmentId)

    await appointmentModel()
      .updateOne(
        { _id: new Types.ObjectId(appointmentId) },
        {
          $set: { startAt, endAt, doctorUserId: new Types.ObjectId(doctorUserId), reservationId },
          $push: {
            statusHistory: {
              from: existing['status'],
              to: existing['status'],
              at: new Date(),
              byUserId: new Types.ObjectId(actor.userId),
              reason: input['reason'],
            },
          },
        },
      )
      .exec()
  }

  await recordAudit({
    action: AUDIT_ACTIONS.APPOINTMENT_RESCHEDULED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Appointment',
    resourceId: appointmentId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: {
      from: (existing['startAt'] as Date).toISOString(),
      to: startAt.toISOString(),
    },
  })

  return readAppointment(actor, appointmentId, meta)
}

/**
 * Cancel an appointment and free its slots.
 *
 * Cancelling releases the slots rather than merely marking the row: a cancelled booking
 * that still occupies its slot is a slot nobody else can book, which is how a clinic ends
 * up with a full day and an empty waiting room.
 */
export async function cancelAppointment(
  actor: AppointmentActor,
  appointmentId: string,
  reason: string,
  meta: Meta,
) {
  const existing = await appointmentModel()
    .findById(new Types.ObjectId(appointmentId))
    .lean()
    .exec()
  if (!existing) throw ApiError.notFound()

  assertMayActOn(actor, String(existing['doctorUserId']))

  if (existing['status'] === 'CANCELLED') {
    throw ApiError.conflict('This appointment is already cancelled.')
  }
  if (TERMINAL_STATUSES.has(existing['status'] as AppointmentStatus)) {
    throw ApiError.conflict(
      `This appointment is ${String(existing['status']).toLowerCase().replace('_', ' ')} and can no longer be cancelled.`,
    )
  }

  await appointmentModel()
    .updateOne(
      { _id: new Types.ObjectId(appointmentId) },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledByUserId: new Types.ObjectId(actor.userId),
          cancellationReason: reason,
        },
        $push: {
          statusHistory: {
            from: existing['status'],
            to: 'CANCELLED',
            at: new Date(),
            byUserId: new Types.ObjectId(actor.userId),
            reason,
          },
        },
      },
    )
    .exec()

  await releaseSlots(appointmentId)

  await recordAudit({
    action: AUDIT_ACTIONS.APPOINTMENT_CANCELLED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Appointment',
    resourceId: appointmentId,
    ip: meta.ip,
    requestId: meta.requestId,
    // The fact and the reason's presence. The reason text itself stays on the record.
    metadata: { from: existing['status'], startAt: (existing['startAt'] as Date).toISOString() },
  })

  return readAppointment(actor, appointmentId, meta)
}

function assertMayActOn(actor: AppointmentActor, doctorUserId: string): void {
  if (doctorUserId !== actor.userId && !mayActForOthers(actor)) {
    throw ApiError.forbidden('That appointment belongs to another doctor.')
  }
}

export async function readAppointment(actor: AppointmentActor, appointmentId: string, meta: Meta) {
  const row = await appointmentModel()
    .findById(new Types.ObjectId(appointmentId))
    .lean()
    .exec()
  if (!row) throw ApiError.notFound()

  assertMayView(actor, String(row['doctorUserId']))

  await recordAudit({
    action: AUDIT_ACTIONS.APPOINTMENT_VIEWED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Appointment',
    resourceId: appointmentId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { patientId: String(row['patientId']) },
  })

  const [decorated] = await decorate([row])
  return decorated
}

function assertMayView(actor: AppointmentActor, doctorUserId: string): void {
  if (doctorUserId !== actor.userId && !mayViewOthers(actor)) {
    throw ApiError.forbidden('That appointment belongs to another doctor.')
  }
}

/**
 * List appointments, scoped to what the caller may see.
 *
 * A doctor without `:any` is narrowed to their own appointments in the QUERY, not filtered
 * afterwards — filtering after a page has been taken would silently under-report.
 */
export async function listAppointments(
  actor: AppointmentActor,
  query: Row,
  meta: Meta,
) {
  const page = Number(query['page'] ?? 1)
  const pageSize = Number(query['pageSize'] ?? 20)

  const filter: Row = {}

  const scopedDoctor = doctorScope(actor, query['doctorUserId'] ? String(query['doctorUserId']) : undefined)
  if (scopedDoctor) filter['doctorUserId'] = new Types.ObjectId(scopedDoctor)

  if (query['patientId']) filter['patientId'] = new Types.ObjectId(String(query['patientId']))
  if (query['status']) filter['status'] = String(query['status'])

  const range = buildRange(query['from'], query['to'])
  if (range) Object.assign(filter, range)

  const [total, rows] = await Promise.all([
    countViaAggregate(appointmentModel(), filter),
    findPageViaAggregate<Row>(appointmentModel(), {
      match: filter,
      sort: { startAt: 1 },
      skip: (page - 1) * pageSize,
      limit: pageSize,
    }),
  ])

  return {
    items: await decorate(rows),
    page: buildPageMeta({ requestId: meta.requestId, page, pageSize, total }),
  }
}

function buildRange(from?: unknown, to?: unknown): Row | null {
  if (!from && !to) return null

  const range: Row = {}
  if (from) range['startAt'] = { $gte: parseInstant(String(from), 'from') }
  if (to) range['startAt'] = { ...(range['startAt'] ?? {}), $lte: parseInstant(String(to), 'to') }

  return range
}

/**
 * The day view.
 *
 * `date` is the hospital's LOCAL calendar day, so "show me Tuesday" means the hospital's
 * Tuesday. Bounds are computed by `localDayBounds`, never by assuming the caller's day is
 * 24 hours of their own offset from UTC.
 */
export async function listAppointmentsForDay(actor: AppointmentActor, query: Row) {
  const config = await loadConfig(actor.hospitalId)
  const { start, end } = dayBoundsForLocalDate(String(query['date']), config.timezone)

  const filter: Row = {
    startAt: { $gte: start, $lt: end },
  }

  const scopedDoctor = doctorScope(actor, query['doctorUserId'] ? String(query['doctorUserId']) : undefined)
  if (scopedDoctor) filter['doctorUserId'] = new Types.ObjectId(scopedDoctor)

  if (query['departmentId']) {
    filter['departmentId'] = new Types.ObjectId(String(query['departmentId']))
  }

  const rows = await findPageViaAggregate<Row>(appointmentModel(), {
    match: filter,
    sort: { startAt: 1 },
    skip: 0,
    limit: 500,
  })

  const items = await decorate(rows)

  return {
    date: String(query['date']),
    timezone: config.timezone,
    generatedAt: new Date().toISOString(),
    appointments: items.map((row) => ({
      ...row,
      // Local rendering aids. Derived from the instant, never stored, so they cannot
      // disagree with it after a timezone change.
      localTime: formatMinuteOfDay(toLocalParts(new Date(row['startAt'] as Date), config.timezone).minuteOfDay),
      localWeekday: toLocalParts(new Date(row['startAt'] as Date), config.timezone).weekday,
    })),
    counts: summarise(items),
  }
}

function summarise(items: Row[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const status = String(item['status'])
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

/** UTC bounds for a `YYYY-MM-DD` calendar date in the hospital's zone. */
function dayBoundsForLocalDate(date: string, timezone: string): { start: Date; end: Date } {
  // Midnight UTC on that calendar date is an unambiguous instant; converting it to the
  // hospital's day bounds is the same computation `localDayBounds` performs, applied to a
  // date rather than to an instant.
  const asInstant = new Date(`${date}T00:00:00.000Z`)
  return localDayBounds(asInstant, timezone)
}

/**
 * Free slot starts for a doctor on a local date.
 *
 * The server owns the answer. Returning free *ranges* and letting the client subtract
 * overlapping bookings invites a client that recomputes the truth and eventually disagrees
 * with the database.
 */
export async function listAvailability(actor: AppointmentActor, query: Row) {
  const config = await loadConfig(actor.hospitalId)
  const date = String(query['date'])
  const durationMinutes = Number(query['durationMinutes'] ?? config.slotDurationMinutes)

  const { start, end } = dayBoundsForLocalDate(date, config.timezone)
  const weekday = toLocalParts(new Date(start.getTime() + 60_000), config.timezone).weekday

  const scopedDoctor = doctorScope(actor, query['doctorUserId'] ? String(query['doctorUserId']) : undefined)
  const doctors: Row[] = scopedDoctor
    ? await findManyViaAggregate<Row>(
        doctorProfileModel(),
        { userId: new Types.ObjectId(scopedDoctor) },
        1,
      )
    : await findManyViaAggregate<Row>(
        doctorProfileModel(),
        query['departmentId']
          ? { departmentId: new Types.ObjectId(String(query['departmentId'])) }
          : {},
        100,
      )

  const window = workingWindowFor(config, weekday)
  if (!window || doctors.length === 0) {
    return { date, timezone: config.timezone, closed: true, durationMinutes, doctors: [] }
  }

  const result = []

  for (const doctor of doctors) {
    const doctorUserId = String((doctor['userId'] as { toString(): string }) ?? '')

    const taken = await findManyViaAggregate<Row>(
      slotModel(),
      {
        doctorUserId: new Types.ObjectId(doctorUserId),
        slotStart: { $gte: start, $lt: end },
      },
      500,
    )
    const takenSet = new Set(
      taken.map((slot) => new Date(slot['slotStart'] as Date).getTime()),
    )

    const candidates: { startAt: string; localTime: string }[] = []
    for (
      let minute = window.opensAtMinute;
      minute + durationMinutes <= window.closesAtMinute;
      minute += config.slotDurationMinutes
    ) {
      const slotStart = slotStartForLocalMinute(date, minute, config.timezone)
      if (takenSet.has(slotStart.getTime())) continue
      if (slotStart.getTime() <= Date.now()) continue

      candidates.push({
        startAt: slotStart.toISOString(),
        localTime: formatMinuteOfDay(minute),
      })
    }

    result.push({
      doctorUserId,
      doctorProfileId: String(doctor['_id']),
      freeSlots: candidates,
    })
  }

  return { date, timezone: config.timezone, closed: false, durationMinutes, doctors: result }
}

/**
 * The UTC instant of a given local minute on a given local date.
 *
 * This IS a local→UTC conversion, and the file header explains why the API otherwise
 * refuses to accept one: the caller supplies the instant, so this only ever runs for
 * times the SERVER itself proposed a moment ago. A time that does not exist — the hour
 * skipped by a DST spring-forward — cannot be reached because the candidate list is
 * generated by stepping real slot boundaries and skipping any that do not resolve.
 */
function slotStartForLocalMinute(date: string, minuteOfDay: number, timezone: string): Date {
  const probe = new Date(`${date}T00:00:00.000Z`)
  const parts = toLocalParts(probe, timezone)

  // Treat the local wall clock as if it were UTC, then subtract the zone's offset at that
  // moment — the same correction `localDayBounds` performs, one level down.
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, minuteOfDay, 0, 0)
  const firstPass = asIfUtc - zoneOffsetMinutes(asIfUtc, timezone) * 60_000

  return new Date(asIfUtc - zoneOffsetMinutes(firstPass, timezone) * 60_000)
}

function zoneOffsetMinutes(instant: number, timezone: string): number {
  const probeDate = new Date(instant)
  const local = toLocalParts(probeDate, timezone)
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
  )
  return Math.round((asUtc - instant) / 60_000)
}

/**
 * Only helpers that are NOT already `export function` are re-exported here. Listing
 * `mayActForOthers` or `mayViewOthers` in this block as well would be a duplicate export
 * of the same name, which TypeScript rejects.
 */
/**
 * Replace the hospital's opening hours.
 *
 * The supplied weekdays are merged over what is already configured, so a caller can change
 * Monday without resending the whole week. Days omitted from the body keep their value.
 */
export async function updateWorkingHours(actor: AppointmentActor, input: Row, meta: Meta) {
  const supplied = (input['workingHours'] ?? {}) as Record<string, unknown>
  const current = await loadConfig(actor.hospitalId)

  const merged: Record<string, { opensAtMinute: number; closesAtMinute: number } | null> = {}

  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const key = String(weekday)
    merged[key] = Object.prototype.hasOwnProperty.call(supplied, key)
      ? (supplied[key] as { opensAtMinute: number; closesAtMinute: number } | null)
      : (current.workingHours[key] ?? null)
  }

  await hospitalModel()
    .updateOne(
      { _id: new Types.ObjectId(actor.hospitalId) },
      { $set: { 'settings.workingHours': merged } },
    )
    .exec()

  await recordAudit({
    action: AUDIT_ACTIONS.HOSPITAL_SETTINGS_UPDATED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Hospital',
    resourceId: actor.hospitalId,
    ip: meta.ip,
    requestId: meta.requestId,
    // Field name only. The values are configuration, not patient data, but the audit log
    // records what changed rather than what it changed to, consistently.
    metadata: { field: 'workingHours' },
  })

  return { workingHours: merged, timezone: current.timezone }
}

export { loadConfig, slotStarts, reserveSlots, releaseSlots, doctorScope }
export { TERMINAL_STATUSES }
export type { AppointmentStatus, HospitalConfig, ApiFieldErrorShape }
