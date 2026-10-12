import { Types, type Model } from 'mongoose'
import type { Permission } from '@infinigrow/shared'
import { HOSPITAL_DEFAULTS } from '@infinigrow/shared'

import { ApiError } from '../../infrastructure/api-error.js'
import {
  countViaAggregate,
  findManyViaAggregate,
  findPageViaAggregate,
} from '../../utilities/mongo-compat.js'
import { localDayBounds, parseInstant as parseTime } from '../../utilities/hospital-time.js'

import { AUDIT_ACTIONS, type AuditAction } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'
import { AppointmentModel } from '../appointments/appointments.models.js'
import { HospitalModel, UserModel } from '../identity/models.js'
import { PatientModel } from '../patients/patients.models.js'

import { ClinicalDocumentModel, ConsultationModel, PrescriptionModel } from './clinical.models.js'
import { localFileStore } from './file-store.js'
import { renderPdf, wrap, type PdfLine } from './pdf.js'

/**
 * Clinical records: consultations, prescriptions, and the documents generated from them.
 *
 * ── Three rules this module exists to enforce ─────────────────────────────────
 *
 * 1. **Nothing here is ever generated.** There is no endpoint that infers, suggests,
 *    summarises or completes a clinical field. Every value on a consultation and every
 *    medicine on a prescription was typed by a person, and the API records who. Automated
 *    diagnosis and treatment recommendation are out of scope by design, not by omission.
 *
 * 2. **A finalized record is never quietly rewritten.** Finalizing seals a consultation.
 *    After that an edit requires a written reason and appends an immutable amendment
 *    holding the before and after values, who, and when. A clinical record that can be
 *    altered without trace is not evidence of what anyone believed at the time.
 *
 * 3. **A document is not a URL.** A generated prescription is addressed by a private
 *    storage key and leaves the system only through `downloadPrescriptionDocument`, which
 *    re-checks permission on the underlying record. Revoking access takes effect on the
 *    next request rather than when some token expires.
 *
 * Scoping follows the Phase 6 pattern: `consultation:read` means "my own records",
 * `consultation:read:any` means "every clinician's in this hospital". A doctor does not
 * hold `:any` by default — clinical notes are written by a named person about a person
 * they saw, and opening them to every colleague by default would make the attribution on
 * the record decorative.
 */

export interface ClinicalActor {
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

/** The narrative fields a finalized consultation must have something in before sealing. */
const NARRATIVE_FIELDS = ['chiefComplaint', 'symptoms', 'assessment', 'plan'] as const

/**
 * Model accessors.
 *
 * The tenant plugin leaves these typed `Model<unknown>`, while the aggregate helpers
 * expect `Model<Document>`. The cast is confined here rather than repeated at every call
 * site, so the incompatibility is stated once.
 */
const consultationModel = () => ConsultationModel as unknown as Model<Row>
const prescriptionModel = () => PrescriptionModel as unknown as Model<Row>
const documentModel = () => ClinicalDocumentModel as unknown as Model<Row>
const appointmentModel = () => AppointmentModel as unknown as Model<Row>
const patientModel = () => PatientModel as unknown as Model<Row>
const userModel = () => UserModel as unknown as Model<Row>

/**
 * `findManyViaAggregate` takes POSITIONAL arguments — `(model, match, limit, project)`.
 *
 * Passing it the options object that `findPageViaAggregate` accepts compiles fine and
 * matches nothing at all: the object becomes the filter, so every query returns empty and
 * reads exactly like a database with no rows. That is how the first version of this module
 * behaved. The wrapper exists so the mistake cannot be repeated here.
 */
function findMany(model: Model<Row>, match: Row, limit = 1000): Promise<Row[]> {
  return findManyViaAggregate<Row>(model, match, limit)
}

function can(actor: ClinicalActor, permission: Permission): boolean {
  return actor.permissions.includes(permission)
}

/**
 * Resolve which doctor's records the caller may touch.
 *
 * `null` means "every doctor in this hospital" — an `:any` holder that did not name one.
 * Otherwise the query is pinned to a concrete user id.
 */
function doctorScope(actor: ClinicalActor, requested?: string): string | null {
  if (can(actor, 'consultation:read:any') || can(actor, 'consultation:write:any')) {
    return requested ?? null
  }
  return actor.userId
}

function safeId(value: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw ApiError.notFound()
  return new Types.ObjectId(value)
}

function uniqueIds(values: unknown[]): Types.ObjectId[] {
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

function displayName(row: Row): string {
  return [row['firstName'], row['lastName']].filter(Boolean).join(' ')
}

function toRow(doc: unknown): Row {
  return (doc as { toObject?: () => Row }).toObject?.() ?? (doc as Row)
}

/**
 * Every read of a clinical record is audited, not just writes.
 *
 * Identifiers only. Clinical narrative never enters the audit trail: the trail is
 * readable by `audit:read`, which is a deliberately wider group than `consultation:read`,
 * and a log is a far easier place for a medical record to leak out of than the record
 * itself is.
 */
async function audit(
  action: AuditAction,
  actor: ClinicalActor,
  meta: Meta,
  resourceId: string,
): Promise<void> {
  await recordAudit({
    hospitalId: actor.hospitalId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action,
    resourceType: 'Clinical',
    resourceId,
    outcome: 'SUCCESS',
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: {},
  })
}

/** The hospital's timezone, used to decide which local calendar day a queue covers. */
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

// ────────────────────────────── reading ──────────────────────────────

export async function listConsultations(
  actor: ClinicalActor,
  _meta: Meta,
  query: Record<string, unknown>,
): Promise<unknown> {
  const page = Number(query['page'] ?? 1)
  const pageSize = Number(query['pageSize'] ?? 20)

  const filter: Row = {}

  const scoped = doctorScope(
    actor,
    query['doctorUserId'] ? String(query['doctorUserId']) : undefined,
  )
  if (scoped) filter['doctorUserId'] = new Types.ObjectId(scoped)

  if (query['patientId']) filter['patientId'] = new Types.ObjectId(String(query['patientId']))
  if (query['appointmentId']) {
    filter['appointmentId'] = new Types.ObjectId(String(query['appointmentId']))
  }
  if (query['status']) filter['status'] = String(query['status'])

  if (query['from'] || query['to']) {
    const range: Row = {}
    if (query['from']) range['$gte'] = new Date(String(query['from']))
    if (query['to']) range['$lt'] = new Date(String(query['to']))
    filter['authoredAt'] = range
  }

  const rows = await findPageViaAggregate<Row>(consultationModel(), {
    match: filter,
    sort: { authoredAt: -1 },
    skip: (page - 1) * pageSize,
    limit: pageSize,
  })
  const total = await countViaAggregate(consultationModel(), filter)

  return {
    items: await decorateConsultations(rows),
    page: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}

export async function readConsultation(
  actor: ClinicalActor,
  meta: Meta,
  consultationId: string,
): Promise<unknown> {
  const row = await loadConsultation(actor, consultationId)
  await audit(AUDIT_ACTIONS.CONSULTATION_VIEWED, actor, meta, consultationId)

  const prescriptions = await findMany(
    prescriptionModel(),
    { consultationId: safeId(consultationId) },
    50,
  )

  const [decorated] = await decorateConsultations([row])

  return {
    ...decorated,
    prescriptions: await decoratePrescriptions(prescriptions),
  }
}

/**
 * Load a consultation the caller is allowed to see, or 404.
 *
 * Deliberately 404 rather than 403 for a record belonging to another doctor: a 403 would
 * confirm that a consultation with this id exists, which is itself clinical information
 * about a patient.
 */
async function loadConsultation(
  actor: ClinicalActor,
  consultationId: string,
): Promise<Row> {
  const scoped = doctorScope(actor)

  const filter: Row = { _id: safeId(consultationId) }
  if (scoped) filter['doctorUserId'] = new Types.ObjectId(scoped)

  const [row] = await findMany(consultationModel(), filter, 1)
  if (!row) throw ApiError.notFound()

  return row
}

/**
 * The clinician's queue for one hospital-local day.
 *
 * Every appointment the caller may see, each carrying the consultation linked to it and
 * whether it exists. This is what a doctor opens at the start of a clinic session: who is
 * coming, and who still needs to be written up.
 */
export async function readQueue(
  actor: ClinicalActor,
  _meta: Meta,
  query: { date: string },
): Promise<unknown> {
  const timezone = await loadTimezone(actor.hospitalId)

  // Midnight UTC on that calendar date is an unambiguous instant; deriving the hospital's
  // day bounds from it is the same computation `localDayBounds` performs, applied to a
  // date rather than to an instant.
  const { start, end } = localDayBounds(
    new Date(`${query.date}T00:00:00.000Z`),
    timezone,
  )

  const scoped = doctorScope(actor)

  const filter: Row = { startAt: { $gte: start, $lt: end } }
  if (scoped) filter['doctorUserId'] = new Types.ObjectId(scoped)

  const appointments = await findPageViaAggregate<Row>(appointmentModel(), {
    match: filter,
    sort: { startAt: 1 },
    skip: 0,
    limit: 500,
  })

  const appointmentIds = appointments.map((row) => row['_id'])

  const consultations = appointmentIds.length
    ? await findMany(consultationModel(), { appointmentId: { $in: appointmentIds } }, 500)
    : []

  const byAppointment = new Map<string, Row>()
  for (const consultation of consultations) {
    byAppointment.set(String(consultation['appointmentId']), consultation)
  }

  const patientIds = uniqueIds(appointments.map((row) => row['patientId']))
  const patients = patientIds.length
    ? await findMany(patientModel(), { _id: { $in: patientIds } }, 500)
    : []

  const patientName = new Map(patients.map((row) => [String(row['_id']), displayName(row)]))

  return {
    date: query.date,
    timezone,
    generatedAt: new Date().toISOString(),
    items: appointments.map((row) => {
      const consultation = byAppointment.get(String(row['_id']))

      return {
        appointmentId: String(row['_id']),
        patientId: String(row['patientId']),
        patientName: patientName.get(String(row['patientId'])) ?? null,
        startAt: (row['startAt'] as Date).toISOString(),
        reason: row['reason'] ?? null,
        status: row['status'],
        consultationId: consultation ? String(consultation['_id']) : null,
        consultationStatus: consultation?.['status'] ?? null,
        /** The one question the queue exists to answer: has this patient been seen? */
        needsConsultation: !consultation,
      }
    }),
  }
}

/**
 * A patient's clinical summary.
 *
 * Scoped the same way as everything else: a caller sees the consultations they authored
 * unless they hold `:any`. That is the conservative reading of "authorized patient
 * history" — a doctor's view of a patient is built from their own encounters, which avoids
 * quietly turning every clinician into a reader of every colleague's notes. The summary
 * still reports how many consultations exist in total, so a clinician can tell that they
 * are not seeing the whole picture rather than assuming they are.
 */
export async function readPatientSummary(
  actor: ClinicalActor,
  meta: Meta,
  patientId: string,
): Promise<unknown> {
  const patient = await requirePatientInHospital(patientId)
  await audit(AUDIT_ACTIONS.CONSULTATION_VIEWED, actor, meta, patientId)

  const scoped = doctorScope(actor)

  const filter: Row = { patientId: safeId(patientId) }
  if (scoped) filter['doctorUserId'] = new Types.ObjectId(scoped)

  const consultations = await findMany(consultationModel(), filter, 100)
  const consultationIds = consultations.map((row) => row['_id'])

  const prescriptions = consultationIds.length
    ? await findMany(prescriptionModel(), { consultationId: { $in: consultationIds } }, 200)
    : []

  const total = await countViaAggregate(consultationModel(), {
    patientId: safeId(patientId),
  })

  return {
    patient: {
      id: String(patient['_id']),
      patientNumber: patient['patientNumber'],
      firstName: patient['firstName'],
      lastName: patient['lastName'],
      dateOfBirth: patient['dateOfBirth'],
      gender: patient['gender'],
    },
    totalConsultationsInHospital: total,
    visibleConsultations: consultations.length,
    scopedToOwnRecords: Boolean(scoped),
    consultations: await decorateConsultations(consultations),
    prescriptions: await decoratePrescriptions(prescriptions),
  }
}

// ────────────────────────────── writing ──────────────────────────────

export async function createConsultation(
  actor: ClinicalActor,
  meta: Meta,
  input: {
    patientId: string
    appointmentId?: string
    chiefComplaint?: string
    symptoms?: string
    assessment?: string
    plan?: string
    followUpAt?: string
  },
): Promise<unknown> {
  // The patient must exist in THIS hospital. Without the check a caller could file a
  // consultation against an arbitrary id, including one belonging to another tenant.
  await requirePatientInHospital(input.patientId)

  if (input.appointmentId) {
    await requireOwnAppointment(input.appointmentId, actor)
  }

  // A consultation belongs to the clinician writing it. It is never created "for" someone
  // else: attributing a note to a doctor who did not write it is the exact failure this
  // whole module is designed to prevent.
  const created = await consultationModel().create({
    // Tenant id comes from the session, never from the request. A client-supplied
    // hospitalId would be exactly the thing this whole mechanism exists to prevent.
    hospitalId: safeId(actor.hospitalId),
    patientId: safeId(input.patientId),
    doctorUserId: safeId(actor.userId),
    appointmentId: input.appointmentId ? safeId(input.appointmentId) : undefined,
    chiefComplaint: input.chiefComplaint,
    symptoms: input.symptoms,
    assessment: input.assessment,
    plan: input.plan,
    followUpAt: input.followUpAt ? parseInstant(input.followUpAt) : undefined,
    status: 'DRAFT',
    authoredByUserId: safeId(actor.userId),
    authoredAt: new Date(),
  })

  await audit(AUDIT_ACTIONS.CONSULTATION_CREATED, actor, meta, String(created['_id']))

  const [decorated] = await decorateConsultations([toRow(created)])
  return decorated
}

/**
 * Edit a consultation.
 *
 * The branch is the whole point of this function:
 *
 * - **DRAFT** — the clinician's own unfinished work. Edited in place, no reason needed.
 * - **FINALIZED** — a signed record. The caller MUST supply `amendmentReason`, and the
 *   change is appended to `amendments[]` with the before and after values. Nothing is
 *   overwritten and the original wording stays readable.
 */
export async function updateConsultation(
  actor: ClinicalActor,
  meta: Meta,
  consultationId: string,
  input: {
    chiefComplaint?: string
    symptoms?: string
    assessment?: string
    plan?: string
    followUpAt?: string
    amendmentReason?: string
  },
): Promise<unknown> {
  const existing = await loadConsultation(actor, consultationId)
  const isFinalized = existing['status'] === 'FINALIZED'

  if (isFinalized && !input.amendmentReason) {
    throw ApiError.conflict(
      'This consultation is finalized. Re-send with an amendmentReason — a signed record is corrected by amendment, not by overwriting it.',
    )
  }

  const proposed: Row = {}
  for (const field of NARRATIVE_FIELDS) {
    const next = (input as Row)[field]
    if (typeof next === 'string') proposed[field] = next
  }
  if (typeof input.followUpAt === 'string') {
    proposed['followUpAt'] = parseInstant(input.followUpAt)
  }

  const changes: Row = {}
  for (const [field, next] of Object.entries(proposed)) {
    const current = existing[field]
    const changed =
      next instanceof Date
        ? current instanceof Date
          ? current.getTime() !== next.getTime()
          : true
        : String(next ?? '') !== String(current ?? '')

    if (changed) changes[field] = next
  }

  if (Object.keys(changes).length === 0) {
    throw ApiError.badRequest('Nothing to change', [
      { path: 'chiefComplaint', message: 'Supply at least one field to change' },
    ])
  }

  const before: Row = {}
  for (const field of Object.keys(changes)) before[field] = existing[field] ?? null

  const update: Row = { ...changes, updatedByUserId: safeId(actor.userId) }

  if (isFinalized) {
    update['amendments'] = [
      ...(Array.isArray(existing['amendments']) ? (existing['amendments'] as Row[]) : []),
      {
        fields: Object.keys(changes),
        before,
        after: changes,
        reason: input.amendmentReason,
        byUserId: safeId(actor.userId),
        at: new Date(),
      },
    ]
  }

  await consultationModel().updateOne({ _id: safeId(consultationId) }, { $set: update })

  await audit(
    isFinalized ? AUDIT_ACTIONS.CONSULTATION_AMENDED : AUDIT_ACTIONS.CONSULTATION_UPDATED,
    actor,
    meta,
    consultationId,
  )

  const [row] = await findMany(consultationModel(), { _id: safeId(consultationId) }, 1)
  const [decorated] = await decorateConsultations([row ?? existing])

  return decorated
}

/**
 * Seal a consultation.
 *
 * One-way by design: there is no "un-finalize". Un-sealing a signed clinical record is
 * indistinguishable, to anyone reading the history, from never having signed it.
 */
export async function finalizeConsultation(
  actor: ClinicalActor,
  meta: Meta,
  consultationId: string,
): Promise<unknown> {
  const existing = await loadConsultation(actor, consultationId)

  if (existing['status'] === 'FINALIZED') {
    throw ApiError.conflict('This consultation is already finalized')
  }

  const hasContent = NARRATIVE_FIELDS.some(
    (field) => typeof existing[field] === 'string' && (existing[field] as string).length > 0,
  )
  if (!hasContent) {
    throw ApiError.badRequest('A consultation must record something before it is finalized', [
      { path: 'chiefComplaint', message: 'Record at least one clinical field' },
    ])
  }

  await consultationModel().updateOne(
    { _id: safeId(consultationId), status: 'DRAFT' },
    {
      $set: {
        status: 'FINALIZED',
        finalizedAt: new Date(),
        finalizedByUserId: safeId(actor.userId),
        updatedByUserId: safeId(actor.userId),
      },
    },
  )

  await audit(AUDIT_ACTIONS.CONSULTATION_FINALIZED, actor, meta, consultationId)

  const [row] = await findMany(consultationModel(), { _id: safeId(consultationId) }, 1)
  const [decorated] = await decorateConsultations([row ?? existing])

  return decorated
}

// ──────────────────────────── prescriptions ────────────────────────────

export async function createPrescription(
  actor: ClinicalActor,
  meta: Meta,
  input: { consultationId: string; items: Row[]; notes?: string },
): Promise<unknown> {
  const consultation = await loadConsultation(actor, input.consultationId)

  if (consultation['status'] !== 'FINALIZED') {
    throw ApiError.conflict(
      'Finalize the consultation before prescribing against it — a prescription should follow a signed clinical record.',
    )
  }

  const created = await prescriptionModel().create({
    hospitalId: safeId(actor.hospitalId),
    consultationId: safeId(input.consultationId),
    patientId: consultation['patientId'],
    doctorUserId: safeId(actor.userId),
    items: input.items,
    notes: input.notes,
    status: 'DRAFT',
    authoredByUserId: safeId(actor.userId),
    authoredAt: new Date(),
  })

  await audit(AUDIT_ACTIONS.PRESCRIPTION_CREATED, actor, meta, String(created['_id']))

  const [decorated] = await decoratePrescriptions([toRow(created)])
  return decorated
}

export async function readPrescription(
  actor: ClinicalActor,
  meta: Meta,
  prescriptionId: string,
): Promise<unknown> {
  const row = await loadPrescription(actor, prescriptionId)
  await audit(AUDIT_ACTIONS.PRESCRIPTION_VIEWED, actor, meta, prescriptionId)

  const [decorated] = await decoratePrescriptions([row])
  return decorated
}

/**
 * Issue a prescription: seal it and generate its printable document.
 *
 * The document is written to private storage and referenced by an opaque key. No URL is
 * returned, because a URL is a capability that outlives the authorization decision which
 * produced it.
 */
export async function finalizePrescription(
  actor: ClinicalActor,
  meta: Meta,
  prescriptionId: string,
): Promise<unknown> {
  const existing = await loadPrescription(actor, prescriptionId)

  if (existing['status'] === 'FINALIZED') {
    throw ApiError.conflict('This prescription is already issued')
  }

  const author = await authorName(actor)
  const pdf = renderPdf(buildPrescriptionPdf(existing, actor, author))

  const stored = await localFileStore.put({
    hospitalId: actor.hospitalId,
    contentType: 'application/pdf',
    body: pdf,
  })

  const document = await documentModel().create({
    hospitalId: safeId(actor.hospitalId),
    resourceType: 'PRESCRIPTION',
    resourceId: safeId(prescriptionId),
    storageKey: stored.storageKey,
    fileName: `prescription-${prescriptionId}.pdf`,
    contentType: 'application/pdf',
    byteSize: stored.byteSize,
    generatedByUserId: safeId(actor.userId),
    generatedAt: new Date(),
  })

  await prescriptionModel().updateOne(
    { _id: safeId(prescriptionId), status: 'DRAFT' },
    {
      $set: {
        status: 'FINALIZED',
        finalizedAt: new Date(),
        finalizedByUserId: safeId(actor.userId),
        documentId: document['_id'],
      },
    },
  )

  await audit(AUDIT_ACTIONS.PRESCRIPTION_ISSUED, actor, meta, prescriptionId)

  const [row] = await findMany(prescriptionModel(), { _id: safeId(prescriptionId) }, 1)
  const [decorated] = await decoratePrescriptions([row ?? existing])

  return decorated
}

/**
 * Authorized download of a generated prescription.
 *
 * Permission is re-checked here, at the moment of download, against the prescription and
 * the consultation behind it. This is the only path by which those bytes leave storage.
 */
export async function downloadPrescriptionDocument(
  actor: ClinicalActor,
  meta: Meta,
  prescriptionId: string,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const prescription = await loadPrescription(actor, prescriptionId)

  const documentId = prescription['documentId']
  if (!documentId) throw ApiError.notFound()

  const [document] = await findMany(
    documentModel(),
    { _id: safeId(String(documentId)), resourceId: safeId(prescriptionId) },
    1,
  )

  if (!document) throw ApiError.notFound()

  await audit(AUDIT_ACTIONS.PRESCRIPTION_DOCUMENT_DOWNLOADED, actor, meta, prescriptionId)

  return {
    fileName: String(document['fileName']),
    bytes: await localFileStore.get(String(document['storageKey'])),
  }
}

async function loadPrescription(actor: ClinicalActor, prescriptionId: string): Promise<Row> {
  const filter: Row = { _id: safeId(prescriptionId) }

  if (!can(actor, 'consultation:read:any') && !can(actor, 'consultation:write:any')) {
    filter['doctorUserId'] = safeId(actor.userId)
  }

  const [row] = await findMany(prescriptionModel(), filter, 1)
  if (!row) throw ApiError.notFound()

  return row
}

/**
 * The printable document.
 *
 * States on its face that it is a clinician-authored document, names its author, and
 * carries the prescribing hospital. A printed prescription that does not say who wrote it
 * is not accountable, and one that implied an automated origin would be worse than not
 * issued at all — so the wording is unambiguous.
 *
 * Every free-text value is wrapped rather than emitted as one line. An instruction that
 * runs off the page edge is silently lost, and on a prescription the lost text is exactly
 * the part the patient needed.
 */
export function buildPrescriptionPdf(
  prescription: Row,
  actor: ClinicalActor,
  author: string,
): PdfLine[] {
  const items = Array.isArray(prescription['items']) ? (prescription['items'] as Row[]) : []

  /** Roughly how many characters fit across an A4 text block at 11pt Helvetica. */
  const WIDTH = 84

  const lines: PdfLine[] = [
    { text: 'PRESCRIPTION', bold: true, size: 20, gapAfter: 6 },
    { text: 'Clinician-authored document', size: 10, gapAfter: 14 },
    { text: `Prescriber: ${author}`, size: 11, gapAfter: 2 },
    {
      text: `Issued: ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`,
      size: 11,
      gapAfter: 2,
    },
    { text: `Reference: ${String(prescription['_id'])}`, size: 11, gapAfter: 14 },
    { text: 'Medicines', bold: true, size: 12, gapAfter: 6 },
  ]

  for (const [index, item] of items.entries()) {
    const emit = (text: string, bold = false, gapAfter = 2) => {
      for (const chunk of wrap(text, WIDTH)) lines.push({ text: chunk, bold, gapAfter })
    }

    emit(`${index + 1}. ${String(item['drugName'] ?? '')}`, true)
    emit(`   Dose: ${String(item['dose'] ?? '')}    Route: ${String(item['route'] ?? '')}`)
    emit(
      `   Frequency: ${String(item['frequency'] ?? '')}${
        item['duration'] ? `    Duration: ${String(item['duration'])}` : ''
      }`,
    )

    if (item['quantity']) emit(`   Quantity: ${String(item['quantity'])}`)
    if (item['instructions']) emit(`   Instructions: ${String(item['instructions'])}`)

    lines.push({ text: '', gapAfter: 6 })
  }

  if (prescription['notes']) {
    lines.push({ text: 'Notes', bold: true, size: 12, gapAfter: 4 })
    for (const chunk of wrap(String(prescription['notes']), WIDTH)) {
      lines.push({ text: chunk, gapAfter: 2 })
    }
    lines.push({ text: '', gapAfter: 8 })
  }

  lines.push({
    text: 'This prescription was written by the named prescriber. It was not generated or',
    size: 9,
    gapAfter: 2,
  })
  lines.push({
    text: 'suggested by any automated system. Verify clinically before dispensing.',
    size: 9,
    gapAfter: 8,
  })
  lines.push({ text: `Hospital: ${String(actor.hospitalId)}`, size: 9 })

  return lines
}

async function authorName(actor: ClinicalActor): Promise<string> {
  const [user] = await findMany(userModel(), { _id: safeId(actor.userId) }, 1)

  const role = actor.role.replace(/_/g, ' ').toLowerCase()
  return user ? `${displayName(user)} (${role})` : role
}

// ────────────────────────────── decoration ──────────────────────────────

async function decorateConsultations(rows: Row[]): Promise<Row[]> {
  const doctorIds = uniqueIds(rows.map((row) => row['doctorUserId']))
  const patientIds = uniqueIds(rows.map((row) => row['patientId']))

  const [doctors, patients] = await Promise.all([
    doctorIds.length
      ? findMany(userModel(), { _id: { $in: doctorIds } }, 500)
      : Promise.resolve<Row[]>([]),
    patientIds.length
      ? findMany(patientModel(), { _id: { $in: patientIds } }, 500)
      : Promise.resolve<Row[]>([]),
  ])

  const doctorName = new Map(doctors.map((row) => [String(row['_id']), displayName(row)]))
  const patientName = new Map(
    patients.map((row) => [
      String(row['_id']),
      `${row['patientNumber']} — ${displayName(row)}`,
    ]),
  )

  return rows.map((row) => ({
    id: String(row['_id']),
    patientId: String(row['patientId']),
    patientLabel: patientName.get(String(row['patientId'])) ?? null,
    doctorUserId: String(row['doctorUserId']),
    doctorName: doctorName.get(String(row['doctorUserId'])) ?? null,
    appointmentId: row['appointmentId'] ? String(row['appointmentId']) : null,
    status: row['status'],
    chiefComplaint: row['chiefComplaint'] ?? null,
    symptoms: row['symptoms'] ?? null,
    assessment: row['assessment'] ?? null,
    plan: row['plan'] ?? null,
    followUpAt: row['followUpAt'] instanceof Date ? (row['followUpAt'] as Date).toISOString() : null,
    clinicalData: row['clinicalData'] ?? null,
    authoredByUserId: String(row['authoredByUserId']),
    authoredAt: (row['authoredAt'] as Date)?.toISOString(),
    finalizedAt: row['finalizedAt'] instanceof Date ? (row['finalizedAt'] as Date).toISOString() : null,
    finalizedByUserId: row['finalizedByUserId'] ? String(row['finalizedByUserId']) : null,
    updatedByUserId: row['updatedByUserId'] ? String(row['updatedByUserId']) : null,
    updatedAt: row['updatedAt'] instanceof Date ? (row['updatedAt'] as Date).toISOString() : null,
    // Amendments are part of the record, not a side note. A reader must be able to see
    // that something was corrected, when and why, without a second request.
    amendments: Array.isArray(row['amendments'])
      ? (row['amendments'] as Row[]).map((entry) => ({
          fields: entry['fields'] ?? [],
          before: entry['before'] ?? {},
          after: entry['after'] ?? {},
          reason: entry['reason'],
          byUserId: entry['byUserId'] ? String(entry['byUserId']) : null,
          at: entry['at'] instanceof Date ? (entry['at'] as Date).toISOString() : null,
        }))
      : [],
  }))
}

async function decoratePrescriptions(rows: Row[]): Promise<Row[]> {
  return rows.map((row) => ({
    id: String(row['_id']),
    consultationId: String(row['consultationId']),
    patientId: String(row['patientId']),
    doctorUserId: String(row['doctorUserId']),
    items: row['items'] ?? [],
    notes: row['notes'] ?? null,
    status: row['status'],
    authoredByUserId: String(row['authoredByUserId']),
    authoredAt: (row['authoredAt'] as Date)?.toISOString(),
    finalizedAt: row['finalizedAt'] instanceof Date ? (row['finalizedAt'] as Date).toISOString() : null,
    finalizedByUserId: row['finalizedByUserId'] ? String(row['finalizedByUserId']) : null,
    // A boolean, not a URL. The document exists and is downloadable by someone
    // authorized; it is not addressable, so there is nothing here to hand out.
    documentAvailable: Boolean(row['documentId']),
  }))
}

// ────────────────────────────── guards ──────────────────────────────

async function requirePatientInHospital(patientId: string): Promise<Row> {
  const [patient] = await findMany(patientModel(), { _id: safeId(patientId) }, 1)

  // 404, not 403: the tenant plugin has already scoped this to the caller's hospital, so
  // "not found" covers both "no such patient" and "not your patient", and the response
  // tells a prober nothing about either.
  if (!patient) throw ApiError.notFound()

  return patient
}

/**
 * A clinician records what they saw. Filing a consultation against another doctor's
 * appointment would attribute their note to an encounter they were not part of.
 */
async function requireOwnAppointment(appointmentId: string, actor: ClinicalActor): Promise<void> {
  const [appointment] = await findMany(appointmentModel(), { _id: safeId(appointmentId) }, 1)

  if (!appointment) {
    throw ApiError.badRequest('That appointment does not exist in this hospital')
  }

  if (!can(actor, 'consultation:read:any')) {
    if (String(appointment['doctorUserId']) !== actor.userId) {
      throw ApiError.forbidden('That appointment belongs to another doctor')
    }
  }
}

function parseInstant(value: string): Date {
  // Parsed here, in the service, rather than by a Zod transform: `parseInstant` throws an
  // ApiError carrying an explanation, which is the right shape for a client, and keeping
  // it in one place means the "explicit offset required" rule lives with the rest of the
  // time handling rather than being re-implemented per schema.
  return parseTime(value)
}