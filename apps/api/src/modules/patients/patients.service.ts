import { HOSPITAL_DEFAULTS, type Permission } from '@infinigrow/shared'
import { Types, type Model } from 'mongoose'

import { ApiError } from '../../infrastructure/api-error.js'
import { buildPageMeta } from '../../utilities/pagination.js'
import { countViaAggregate, findPageViaAggregate } from '../../utilities/mongo-compat.js'
import { AUDIT_ACTIONS } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'
import { HospitalModel } from '../identity/models.js'

import { PatientCounterModel, PatientModel } from './patients.models.js'

/**
 * Patient services.
 *
 * ── The tenant rule ────────────────────────────────────────────────────────────
 *
 * **No function here accepts a `hospitalId` from the caller.** The tenant comes from
 * `actor.hospitalId`, which the middleware derived from the signed session. Another
 * hospital's patient id simply matches nothing and the response is 404 — which is also
 * the only safe answer, since confirming an id exists elsewhere is itself a disclosure.
 *
 * ── The data-minimisation rule ─────────────────────────────────────────────────
 *
 * Two mechanisms, both applied here rather than in the view layer:
 *
 * 1. **Collection.** The schema has no clinical fields at all (see `patients.models.ts`).
 * 2. **Disclosure.** Contact details — phone, email, address, and the emergency contact
 *    that names a third party — are returned only to callers holding `patient:write`.
 *    `patient:read` alone yields demographics.
 *
 * `patient:read` without `patient:write` is a real configuration: it is what `ACCOUNTANT`
 * holds, so an accountant can attach a charge to the right person from a list without
 * holding a register of who they live with and who to call in an emergency. That is the
 * whole point of splitting the permission.
 */

type Row = Record<string, unknown>

const patientModel = () => PatientModel as unknown as Model<Row>
const counterModel = () => PatientCounterModel as unknown as Model<Row>
const hospitalModel = () => HospitalModel as unknown as Model<Row>

export interface PatientActor {
  userId: string
  role: string
  hospitalId: string
  permissions: Permission[]
}

export interface PatientMeta {
  ip: string
  requestId: string
}

export interface PatientListQuery {
  page?: number
  pageSize?: number
  q?: string
  gender?: string
  isActive?: boolean
  patientNumber?: string
  phone?: string
}

/** True when the caller may see who this patient is and how to reach them. */
export function maySeeContactDetails(actor: PatientActor): boolean {
  return actor.permissions.includes('patient:write')
}

/** Escape a user-supplied string before it becomes part of a regex. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Reduce a phone number to its digits — the lookup key for `phoneDigits`.
 *
 * Deliberately simple: strip everything that is not a digit. A country code's `+` and the
 * spaces, dashes and brackets people actually write must not make the same person
 * un-findable at a reception desk.
 */
export function phoneDigits(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const digits = value.replace(/\D/g, '')
  return digits === '' ? undefined : digits
}

/**
 * Shape a patient row for the wire.
 *
 * The masking is decided by `maySeeContactDetails`, and the response says which case it is
 * in (`contactVisible`) so the interface can explain why a column is empty instead of
 * rendering a blank that looks like missing data.
 */
function toPatient(row: Row, actor: PatientActor) {
  const contactVisible = maySeeContactDetails(actor)

  return {
    id: String(row['_id']),
    patientNumber: row['patientNumber'],
    firstName: row['firstName'],
    lastName: row['lastName'],
    dateOfBirth: row['dateOfBirth'],
    gender: row['gender'] ?? 'UNDECLARED',
    isActive: Boolean(row['isActive']),

    contactVisible,
    phone: contactVisible ? (row['phone'] ?? null) : null,
    email: contactVisible ? (row['email'] ?? null) : null,
    address: contactVisible ? (row['address'] ?? null) : null,
    emergencyContact: contactVisible ? (row['emergencyContact'] ?? null) : null,

    registeredByUserId: row['registeredByUserId'] ? String(row['registeredByUserId']) : null,
    createdAt: row['createdAt'],
    updatedAt: row['updatedAt'],
  }
}

/**
 * Allocate the next patient number for this hospital.
 *
 * An atomic `$inc` on a counter row, then formatted with the hospital's configured prefix.
 * Two registrations arriving together therefore receive different numbers: the increment
 * is decided by the database, so there is no read-then-write window for both to pass.
 *
 * The unique index on `{ hospitalId, patientNumber }` remains the backstop. If the counter
 * were ever reset or restored from a backup, a collision surfaces as a 409 rather than as
 * two patients sharing a number in a filing system.
 */
async function nextPatientNumber(hospitalId: string): Promise<string> {
  const counter = await counterModel().findOneAndUpdate(
    { hospitalId: new Types.ObjectId(hospitalId) },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )

  if (!counter) {
    throw ApiError.internal(new Error('Patient number sequence could not be advanced'))
  }

  const hospital = await hospitalModel()
    .findById(new Types.ObjectId(hospitalId))
    .lean()
    .exec()

  const settings = (hospital?.['settings'] ?? {}) as Row
  const prefix = String(settings['patientNumberPrefix'] ?? HOSPITAL_DEFAULTS.patientNumberPrefix)

  const seq = Number(counter['seq'] ?? 1)
  return `${prefix}-${String(seq).padStart(6, '0')}`
}

/**
 * Register a patient.
 *
 * The number is allocated by the server and is never accepted from the caller: a client
 * that could choose its own patient number could choose another patient's, which is
 * exactly the confusion a filing system exists to prevent.
 */
export async function registerPatient(
  actor: PatientActor,
  input: Row,
  meta: PatientMeta,
) {
  const patientNumber = await nextPatientNumber(actor.hospitalId)

  const created = await patientModel().create({
    ...input,
    patientNumber,
    // Derived here, never taken from the client: this is a lookup index, and a
    // caller supplying their own would simply be able to make two records collide on it.
    phoneDigits: phoneDigits(input['phone']),
    hospitalId: new Types.ObjectId(actor.hospitalId),
    registeredByUserId: new Types.ObjectId(actor.userId),
  })

  await recordAudit({
    action: AUDIT_ACTIONS.PATIENT_REGISTERED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Patient',
    resourceId: String(created['_id']),
    ip: meta.ip,
    requestId: meta.requestId,
    // The number and the id only. Never the name, date of birth or contact details —
    // the audit log is readable by `audit:read` holders, who need not be clinical staff.
    metadata: { patientNumber },
  })

  return toPatient(created.toObject(), actor)
}

/**
 * Read one patient.
 *
 * Opening a record is audited, not only changing one. A patient register is a list of
 * identifiable people who never agreed to be in this system, so who looked at what is
 * part of the record of what happened.
 */
export async function readPatient(actor: PatientActor, patientId: string, meta: PatientMeta) {
  const row = await patientModel().findById(new Types.ObjectId(patientId)).lean().exec()
  if (!row) throw ApiError.notFound()

  await recordAudit({
    action: AUDIT_ACTIONS.PATIENT_VIEWED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Patient',
    resourceId: String(row['_id']),
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { patientNumber: row['patientNumber'] },
  })

  return toPatient(row, actor)
}


export async function updatePatient(
  actor: PatientActor,
  patientId: string,
  input: Row,
  meta: PatientMeta,
) {
  const before = await patientModel().findById(new Types.ObjectId(patientId)).lean().exec()
  if (!before) throw ApiError.notFound()

  // Which fields changed, by name only. The values stay out of the audit trail.
  const changed = Object.keys(input).filter(
    (field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(input[field] ?? null),
  )

  // Keep the derived lookup key in step with the phone number it mirrors. Without this, an
  // updated number is still matched by its OLD digits, so a patient stays findable at a
  // number they no longer have.
  const update: Row = { ...input }
  if ('phone' in input) update['phoneDigits'] = phoneDigits(input['phone'])

  const updated = await patientModel()
    .findOneAndUpdate(
      { _id: new Types.ObjectId(patientId) },
      { $set: update },
      { returnDocument: 'after' },
    )
    .lean()
    .exec()

  if (!updated) throw ApiError.notFound()

  await recordAudit({
    action: AUDIT_ACTIONS.PATIENT_UPDATED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Patient',
    resourceId: String(updated['_id']),
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { fields: changed, patientNumber: updated['patientNumber'] },
  })

  return toPatient(updated, actor)
}

/**
 * Search and list patients.
 *
 * Server-side paging and filtering, like every list in this API. A client that fetched
 * everything and filtered in the browser is wrong the moment a hospital passes one
 * hundred patients, and wrong silently.
 */
export async function listPatients(actor: PatientActor, query: PatientListQuery, meta: PatientMeta) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20

  const filter: Row = {}

  if (query.isActive !== undefined) filter['isActive'] = query.isActive
  if (query.gender) filter['gender'] = query.gender

  // Exact-match lookups for the two things a receptionist holds in their hand.
  if (query.patientNumber) {
    filter['patientNumber'] = query.patientNumber.trim().toUpperCase()
  }
  if (query.phone) {
    // Match the normalised digit form, which is indexed.
    //
    // The alternative � an $expr stripping punctuation inside the aggregation � is
    // correct but CANNOT use an index, so every phone lookup would scan the whole patient
    // register. It also depends on $regexReplace, which needs MongoDB 5.0+ and fails
    // loudly below that.
    filter['phoneDigits'] = phoneDigits(query.phone)
  }

  // Free-text across the names people actually know. NOT across phone, email or address:
  // a search box that silently matches on a phone number is how the wrong patient's record
  // gets opened at a busy desk.
  if (query.q) {
    const pattern = escapeRegex(query.q)
    filter['$or'] = [{ firstName: pattern }, { lastName: pattern }]
  }

  const [total, rows] = await Promise.all([
    countViaAggregate(patientModel(), filter),
    findPageViaAggregate<Row>(patientModel(), {
      match: filter,
      sort: { lastName: 1, firstName: 1 },
      skip: (page - 1) * pageSize,
      limit: pageSize,
    }),
  ])

  void meta

  return {
    items: rows.map((row) => toPatient(row, actor)),
    page: buildPageMeta({ requestId: meta.requestId, page, pageSize, total }),
  }
}

/**
 * Duplicate detection for registration.
 *
 * Deliberately conservative: it flags an exact match on name AND date of birth, and
 * says so as a WARNING to the person registering rather than refusing. Two siblings share
 * a name and a birthday, and refusing to register the second one because the first exists
 * is a worse failure than a duplicate record someone can merge.
 *
 * No `actor` parameter: the query is scoped by the request's tenant context, which the
 * isolation plugin applies. Passing a hospital in would be a second, worse way of saying
 * the same thing.
 */
export async function findPossibleDuplicate(input: Row) {
  const rows = await findPageViaAggregate<Row>(patientModel(), {
    match: {
      firstName: escapeRegex(String(input['firstName'] ?? '')),
      lastName: escapeRegex(String(input['lastName'] ?? '')),
      dateOfBirth: new Date(`${String(input['dateOfBirth'])}T00:00:00.000Z`),
    },
    sort: { createdAt: -1 },
    skip: 0,
    limit: 5,
  })

  return rows.map((row) => ({
    id: String(row['_id']),
    patientNumber: row['patientNumber'],
    firstName: row['firstName'],
    lastName: row['lastName'],
    dateOfBirth: row['dateOfBirth'],
  }))
}
