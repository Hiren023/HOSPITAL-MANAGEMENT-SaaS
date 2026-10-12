import { Types, type Model } from 'mongoose'
import type { Permission } from '@infinigrow/shared'

import { ApiError } from '../../infrastructure/api-error.js'
import { findManyViaAggregate } from '../../utilities/mongo-compat.js'
import { localDayBounds } from '../../utilities/hospital-time.js'

import { AUDIT_ACTIONS, type AuditAction } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'
import { AppointmentModel } from '../appointments/appointments.models.js'
import { UserModel } from '../identity/models.js'

import { AttendanceRecordModel } from '../attendance/attendance.models.js'
import { InvoiceModel, PaymentModel } from '../billing/billing.models.js'
import { loadSettings } from '../billing/billing.service.js'

/**
 * Reports.
 *
 * ── Financial figures are not operational figures ────────────────────────────
 *
 * `report:financial` and `report:read` are different permissions and a doctor has only the
 * second. Revenue, outstanding balances and per-doctor takings are restricted to whoever
 * holds `report:financial`; appointment counts and attendance are operational and are not.
 *
 * ── Unverified money is not revenue ───────────────────────────────────────────
 *
 * The central property of this module. A revenue report does NOT return one total. It
 * returns the amount by verification status, because these are three different facts:
 *
 * - `VERIFIED` — a provider settlement was reconciled by a named person.
 * - `PENDING` — a provider claims it, and nobody has confirmed it.
 * - `UNVERIFIED` — a human recorded it. Real cash, but asserted, not confirmed.
 *
 * Summing them into a single "revenue" figure would present an unreconciled provider claim
 * as money in hand, and a receivables report built on that would be wrong in the direction
 * that hides money. `manualTotalMinor` and `verifiedGatewayTotalMinor` are therefore
 * separate top-level fields, and `settledTotalMinor` is named for what it is rather than
 * being called "revenue".
 *
 * This MVP has no payment gateway integration. `PENDING` exists because the shape has to be
 * right before a gateway is connected — retrofitting the distinction afterwards means
 * retrofitting it into reports a hospital has already acted on.
 */

export interface ReportActor {
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

const paymentModel = () => PaymentModel as unknown as Model<Row>
const invoiceModel = () => InvoiceModel as unknown as Model<Row>
const appointmentModel = () => AppointmentModel as unknown as Model<Row>
const attendanceModel = () => AttendanceRecordModel as unknown as Model<Row>
const userModel = () => UserModel as unknown as Model<Row>

function findMany(model: Model<Row>, match: Row, limit = 5000): Promise<Row[]> {
  return findManyViaAggregate<Row>(model, match, limit)
}

function can(actor: ReportActor, permission: Permission): boolean {
  return actor.permissions.includes(permission)
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

async function audit(
  action: AuditAction,
  actor: ReportActor,
  meta: Meta,
  resourceId: string,
  extra: Row = {},
): Promise<void> {
  await recordAudit({
    hospitalId: actor.hospitalId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action,
    resourceType: 'Report',
    resourceId,
    outcome: 'SUCCESS',
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: extra,
  })
}

/**
 * Every local date key between two dates, inclusive.
 *
 * Generated rather than inferred from the data that came back, so a day with no takings is
 * still a row. A revenue chart with a missing day reads as "no data" when it should read
 * as "nothing taken", and the difference matters when someone is reconciling.
 */
function eachLocalDate(from: string, to: string): string[] {
  const dates: string[] = []
  const cursor = new Date(`${from}T00:00:00.000Z`)

  for (let guard = 0; guard < 1000; guard += 1) {
    const key = cursor.toISOString().slice(0, 10)
    if (key > to) break
    dates.push(key)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return dates
}

function monthKey(dateKey: string): string {
  return dateKey.slice(0, 7)
}

export async function revenueReport(
  actor: ReportActor,
  meta: Meta,
  query: { granularity: 'daily' | 'monthly' | 'range'; from: string; to: string; currency?: string },
): Promise<unknown> {
  // The financial gate. A doctor holds `report:read` but not `report:financial`, and must
  // not be able to derive a hospital's turnover from appointment data and arithmetic.
  if (!can(actor, 'report:financial')) {
    throw ApiError.forbidden('Revenue reporting needs report:financial')
  }

  const settings = await loadSettings(actor.hospitalId)
  const currency = query.currency ?? settings.currency

  const { start, end } = boundsFor(query.from, query.to, settings.timezone)

  const payments = await findMany(
    paymentModel(),
    { occurredAt: { $gte: start, $lte: end } },
    20_000,
  )

  const buckets = new Map<string, Row>()

  const bucketFor = (key: string): Row => {
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        key,
        manualTotalMinor: 0,
        verifiedGatewayTotalMinor: 0,
        pendingGatewayTotalMinor: 0,
        refundedMinor: 0,
        paymentCount: 0,
        refundCount: 0,
      }
      buckets.set(key, bucket)
    }
    return bucket
  }

  const keys =
    query.granularity === 'range'
      ? [`${query.from}..${query.to}`]
      : query.granularity === 'monthly'
        ? unique(eachLocalDate(query.from, query.to).map(monthKey))
        : eachLocalDate(query.from, query.to)

  for (const key of keys) bucketFor(key)

  for (const payment of payments) {
    // `occurredAt` is an instant; the bucket key is the hospital's LOCAL date, because a
    // hospital's books close on its own calendar. Bucketing by UTC would split one day's
    // takings across two dates for anyone not on UTC.
    const occurred = payment['occurredAt'] as Date
    const local = localDateOf(occurred, settings.timezone)

    const key =
      query.granularity === 'monthly'
        ? monthKey(local)
        : query.granularity === 'range'
          ? `${query.from}..${query.to}`
          : local

    const bucket = bucketFor(key)
    const amount = num(payment['amountMinor'])

    if (payment['kind'] === 'REFUND') {
      bucket['refundedMinor'] = Number(bucket['refundedMinor']) + amount
      bucket['refundCount'] = Number(bucket['refundCount']) + 1
      continue
    }

    bucket['paymentCount'] = Number(bucket['paymentCount']) + 1

    // The distinction this module exists to preserve.
    if (payment['source'] === 'GATEWAY') {
      if (payment['verification'] === 'VERIFIED') {
        bucket['verifiedGatewayTotalMinor'] =
          Number(bucket['verifiedGatewayTotalMinor']) + amount
      } else {
        bucket['pendingGatewayTotalMinor'] =
          Number(bucket['pendingGatewayTotalMinor']) + amount
      }
    } else {
      bucket['manualTotalMinor'] = Number(bucket['manualTotalMinor']) + amount
    }
  }

  const series = keys.map((key) => buckets.get(key) ?? bucketFor(key))

  const totals = series.reduce<Row>(
    (acc, bucket) => ({
      manualTotalMinor: num(acc['manualTotalMinor']) + num(bucket['manualTotalMinor']),
      verifiedGatewayTotalMinor:
        num(acc['verifiedGatewayTotalMinor']) + num(bucket['verifiedGatewayTotalMinor']),
      pendingGatewayTotalMinor:
        num(acc['pendingGatewayTotalMinor']) + num(bucket['pendingGatewayTotalMinor']),
      refundedMinor: num(acc['refundedMinor']) + num(bucket['refundedMinor']),
    }),
    {
      manualTotalMinor: 0,
      verifiedGatewayTotalMinor: 0,
      pendingGatewayTotalMinor: 0,
      refundedMinor: 0,
    },
  )

  await audit(AUDIT_ACTIONS.REPORT_VIEWED, actor, meta, 'revenue', {
    from: query.from,
    to: query.to,
    granularity: query.granularity,
  })

  return {
    granularity: query.granularity,
    from: query.from,
    to: query.to,
    currency,
    timezone: settings.timezone,
    series,
    totals: {
      ...totals,
      // Named for what it is. This is money that has been confirmed to have arrived, and
      // calling it "revenue" would invite someone to treat an unreconciled claim the same.
      settledTotalMinor:
        num(totals['manualTotalMinor']) +
        num(totals['verifiedGatewayTotalMinor']) -
        num(totals['refundedMinor']),
    },
    note: 'manualTotalMinor is asserted by a person, not confirmed by a system. pendingGatewayTotalMinor is a provider claim nobody has reconciled yet.',
  }
}

/**
 * Appointment activity over a range.
 *
 * Operational, not financial: `report:read` is enough. Deliberately carries no money.
 */
export async function appointmentReport(
  actor: ReportActor,
  meta: Meta,
  query: { from: string; to: string },
): Promise<unknown> {
  if (!can(actor, 'report:read')) {
    throw ApiError.forbidden('Appointment reporting needs report:read')
  }

  const settings = await loadSettings(actor.hospitalId)
  const { start, end } = boundsFor(query.from, query.to, settings.timezone)

  const appointments = await findMany(
    appointmentModel(),
    { startAt: { $gte: start, $lte: end } },
    20_000,
  )

  const byStatus: Row = {}
  let cancelled = 0
  let noShow = 0
  let completed = 0

  for (const appointment of appointments) {
    const status = String(appointment['status'] ?? 'UNKNOWN')
    byStatus[status] = num(byStatus[status]) + 1
    if (status === 'CANCELLED') cancelled += 1
    if (status === 'NO_SHOW') noShow += 1
    if (status === 'COMPLETED') completed += 1
  }

  const total = appointments.length
  const attended = completed

  await audit(AUDIT_ACTIONS.REPORT_VIEWED, actor, meta, 'appointments', {
    from: query.from,
    to: query.to,
  })

  return {
    from: query.from,
    to: query.to,
    timezone: settings.timezone,
    total,
    byStatus,
    completed,
    cancelled,
    noShow,
    // A rate over zero is not a rate; returning 0 would read as "nobody ever attends".
    attendanceRate: total === 0 ? null : Number(((attended / total) * 100).toFixed(2)),
    noShowRate: total === 0 ? null : Number(((noShow / total) * 100).toFixed(2)),
  }
}

/**
 * Attendance over a range, per person.
 *
 * Hours are computed from the record, never stored. Total hours are whole minutes summed,
 * then converted once, so fifteen people each with 7h59m do not become fifteen rounded 8h
 * days in a report that is supposed to add up.
 */
export async function attendanceReport(
  actor: ReportActor,
  meta: Meta,
  query: { from: string; to: string },
): Promise<unknown> {
  if (!can(actor, 'report:read')) {
    throw ApiError.forbidden('Attendance reporting needs report:read')
  }

  const settings = await loadSettings(actor.hospitalId)

  const records = await findMany(
    attendanceModel(),
    // `workDate` is a local calendar date, so a plain string comparison is correct. No
    // timezone conversion, and no boundary instants to get wrong.
    { workDate: { $gte: query.from, $lte: query.to } },
    20_000,
  )

  const byUser = new Map<string, Row>()

  for (const record of records) {
    const userId = String(record['userId'])
    let row = byUser.get(userId)
    if (!row) {
      row = {
        userId,
        userName: null,
        daysPresent: 0,
        minutesWorked: 0,
        openShifts: 0,
        correctedDays: 0,
      }
      byUser.set(userId, row)
    }

    row['daysPresent'] = Number(row['daysPresent']) + 1
    if (record['status'] === 'OPEN') row['openShifts'] = Number(row['openShifts']) + 1
    if (record['status'] === 'CORRECTED') row['correctedDays'] = Number(row['correctedDays']) + 1

    const checkInAt = record['checkInAt']
    const checkOutAt = record['checkOutAt']

    if (checkInAt instanceof Date && checkOutAt instanceof Date) {
      const minutes = Math.max(0, Math.floor((checkOutAt.getTime() - checkInAt.getTime()) / 60_000))
      row['minutesWorked'] = Number(row['minutesWorked']) + minutes
    }
  }

  const ids = [...byUser.keys()].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id))
  const users = ids.length ? await findMany(userModel(), { _id: { $in: ids } }, 500) : []

  const names = new Map(
    users.map((row) => [
      String(row['_id']),
      [row['firstName'], row['lastName']].filter(Boolean).join(' '),
    ]),
  )

  const people = ([...byUser.values()] as Row[]).map((row): Row => {
    const withName: Row = { ...row, userName: names.get(String(row['userId'])) ?? null }
    // Converted once, at the end. Rounding per person and then summing would not equal
    // rounding the sum, and a report that does not add up is not worth producing.
    withName['hoursWorked'] = Number((num(row['minutesWorked']) / 60).toFixed(2))
    return withName
  })

  people.sort((a, b) => num(b['hoursWorked']) - num(a['hoursWorked']))

  const totalMinutes = people.reduce((sum, person) => sum + Number(person['minutesWorked']), 0)

  await audit(AUDIT_ACTIONS.REPORT_VIEWED, actor, meta, 'attendance', {
    from: query.from,
    to: query.to,
  })

  return {
    from: query.from,
    to: query.to,
    timezone: settings.timezone,
    people,
    totals: {
      people: people.length,
      daysPresent: people.reduce((sum, person) => sum + Number(person['daysPresent']), 0),
      hoursWorked: Number((totalMinutes / 60).toFixed(2)),
    },
  }
}

// ───────────────────────────── CSV ─────────────────────────────

/**
 * Render rows as CSV.
 *
 * Hand-rolled rather than pulled in for a dependency this small, with the two things that
 * actually matter handled explicitly:
 *
 * - A leading `=`, `+`, `-` or `@` is prefixed with a tab. Without that, a patient name
 *   beginning with `=` is a formula, and a spreadsheet executes it when the file is opened.
 *   This is CSV injection, and it is how exports become an attack path.
 * - `,`, `"`, newlines and tabs inside a value are quoted, so a name with a comma does not
 *   shift every column after it.
 */
/**
 * Byte-order mark, so Excel opens the export as UTF-8.
 *
 * Without it a patient name containing a non-ASCII character comes out as mojibake in the
 * one spreadsheet most people use to read a CSV. Written as an escape rather than a literal
 * so it does not look like invisible junk in the source.
 */
const BOM = '\uFEFF'

export function toCsv(headers: string[], rows: Row[]): string {
  const escape = (value: unknown): string => {
    let text = value === null || value === undefined ? '' : String(value)

    if (/^[=+\-@\t\r]/.test(text)) {
      text = `\t${text}`
    }

    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  const lines = [headers.map(escape).join(',')]

  for (const row of rows) {
    lines.push(headers.map((header) => escape(row[header])).join(','))
  }

  // A leading BOM so Excel opens UTF-8 correctly; without it a name with a non-ASCII
  // character comes out as mojibake.
    return `${BOM}${lines.join('\r\n')}`
}

/** Send a CSV download. */
export function csvResponse(res: { setHeader(k: string, v: string): void; send(body: string): void }, fileName: string, body: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.send(body)
}

export async function revenueCsv(
  actor: ReportActor,
  meta: Meta,
  query: { granularity: 'daily' | 'monthly' | 'range'; from: string; to: string; currency?: string },
): Promise<{ fileName: string; body: string }> {
  const data = (await revenueReport(actor, meta, query)) as Row
  const series = (data['series'] ?? []) as Row[]

  const headers = [
    'period',
    'manual_total_minor',
    'verified_gateway_total_minor',
    'pending_gateway_total_minor',
    'refunded_minor',
    'payment_count',
    'refund_count',
    'currency',
  ]

  const rows = series.map((bucket) => ({
    period: bucket['key'],
    manual_total_minor: bucket['manualTotalMinor'],
    verified_gateway_total_minor: bucket['verifiedGatewayTotalMinor'],
    pending_gateway_total_minor: bucket['pendingGatewayTotalMinor'],
    refunded_minor: bucket['refundedMinor'],
    payment_count: bucket['paymentCount'],
    refund_count: bucket['refundCount'],
    currency: data['currency'],
  }))

  await audit(AUDIT_ACTIONS.REPORT_EXPORTED, actor, meta, 'revenue', { rows: rows.length })

  return { fileName: `revenue-${query.from}-to-${query.to}.csv`, body: toCsv(headers, rows) }
}

export async function attendanceCsv(
  actor: ReportActor,
  meta: Meta,
  query: { from: string; to: string },
): Promise<{ fileName: string; body: string }> {
  const data = (await attendanceReport(actor, meta, query)) as Row
  const people = (data['people'] ?? []) as Row[]

  const headers = [
    'user_id',
    'name',
    'days_present',
    'hours_worked',
    'open_shifts',
    'corrected_days',
  ]

  const rows = people.map((person) => ({
    user_id: person['userId'],
    name: person['userName'] ?? '',
    days_present: person['daysPresent'],
    hours_worked: person['hoursWorked'],
    open_shifts: person['openShifts'],
    corrected_days: person['correctedDays'],
  }))

  await audit(AUDIT_ACTIONS.REPORT_EXPORTED, actor, meta, 'attendance', { rows: rows.length })

  return { fileName: `attendance-${query.from}-to-${query.to}.csv`, body: toCsv(headers, rows) }
}

export async function appointmentCsv(
  actor: ReportActor,
  meta: Meta,
  query: { from: string; to: string },
): Promise<{ fileName: string; body: string }> {
  const data = (await appointmentReport(actor, meta, query)) as Row
  const byStatus = (data['byStatus'] ?? {}) as Row

  const headers = ['status', 'count']
  const rows = Object.entries(byStatus).map(([status, count]) => ({ status, count }))

  await audit(AUDIT_ACTIONS.REPORT_EXPORTED, actor, meta, 'appointments', { rows: rows.length })

  return { fileName: `appointments-${query.from}-to-${query.to}.csv`, body: toCsv(headers, rows) }
}

// ───────────────────────────── helpers ─────────────────────────────

function boundsFor(from: string, to: string, timezone: string): { start: Date; end: Date } {
  const { start } = localDayBounds(new Date(`${from}T00:00:00.000Z`), timezone)
  const last = localDayBounds(new Date(`${to}T00:00:00.000Z`), timezone)
  return { start, end: last.end }
}

function localDateOf(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export { invoiceModel }