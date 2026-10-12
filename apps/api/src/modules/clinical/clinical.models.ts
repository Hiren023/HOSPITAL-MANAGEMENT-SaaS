import mongoose, { Schema } from 'mongoose'

import { tenantScopedSchema } from '../../infrastructure/db/tenant-plugin.js'

/**
 * Clinical records — consultations, prescriptions and their generated documents.
 *
 * ── What this schema deliberately has no field for ────────────────────────────
 *
 * There is no `suggestedDiagnosis`, no `recommendedMedication`, no inference of any
 * kind. Automated diagnosis and treatment recommendation are outside this product's
 * scope, and a field shaped for them would be an invitation to fill them in later.
 * Every clinical value here is authored by a person and attributed to them.
 *
 * ── Clinical validation status ────────────────────────────────────────────────
 *
 * These models are structurally sound and covered by tests. They have **NOT** been
 * clinically validated, and nothing in this repository should be read as a claim of
 * regulatory compliance or clinical safety assurance. Anyone deploying this for real
 * clinical use needs independent clinical and regulatory review, which is outside what
 * code and tests can establish.
 *
 * ── Extensibility ────────────────────────────────────────────────────────────
 *
 * The model is shaped to extend: a `clinicalData` Mixed field exists for structured
 * findings this schema has not anticipated, so a later phase can add capture without a
 * migration. It is Mixed precisely so its contents cannot be assumed safe to index or
 * query — anything structured enough to matter gets its own typed field.
 *
 * These records are never returned by any platform route (docs/SECURITY.md R14).
 */

export const CONSULTATION_STATUSES = ['DRAFT', 'FINALIZED'] as const
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number]

/**
 * One immutable entry in a consultation's amendment history.
 *
 * A FINALIZED consultation is never edited in place. Correcting a signed clinical record
 * appends here, keeping what the record said before, who changed it, when, and why. That
 * is the whole point: a clinical record that can be quietly rewritten is not evidence of
 * what was thought at the time.
 */
const amendmentSchema = new Schema(
  {
    /** Fields whose value changed, by name. */
    fields: { type: [String], default: [] },
    /** What each changed field said before. Never the new value alone. */
    before: { type: Schema.Types.Mixed, default: {} },
    after: { type: Schema.Types.Mixed, default: {} },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    byUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
)

const consultationSchema = tenantScopedSchema(
  'Consultation',
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    /** The clinician responsible for this record. */
    doctorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /**
     * The appointment this consultation arose from, when there was one.
     *
     * Optional on purpose: a walk-in patient is a real patient, and forcing an
     * appointment to exist would mean inventing clinical encounters to satisfy a foreign
     * key. That a consultation is unattached is itself information.
     */
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },

    status: { type: String, enum: CONSULTATION_STATUSES, default: 'DRAFT' },

    /**
     * The clinical narrative. All free text, all human-authored.
     *
     * Every one of these is in the logger's redaction list (or added to it), so none of it
     * can reach a log line. A consultation is the most sensitive record in the product and
     * it must not leak into a log file that is shipped somewhere less protected.
     */
    chiefComplaint: { type: String, trim: true, maxlength: 2000 },
    symptoms: { type: String, trim: true, maxlength: 4000 },
    assessment: { type: String, trim: true, maxlength: 8000 },
    plan: { type: String, trim: true, maxlength: 8000 },
    followUpAt: { type: Date },

    /** Structured findings not anticipated by this schema. See the note in the header. */
    clinicalData: { type: Schema.Types.Mixed, default: undefined },

    /** Who created the record, and when. Never inferred from the session. */
    authoredByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authoredAt: { type: Date, required: true, default: () => new Date() },

    /** Set once, when the record is finalized. The seal. */
    finalizedAt: { type: Date },
    finalizedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },

    /** Who last touched it, and when. */
    updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedAt: { type: Date, default: () => new Date() },

    amendments: { type: [amendmentSchema], default: [] },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// A doctor's queue: "my consultations, newest first", and a patient's history.
consultationSchema.index({ hospitalId: 1, doctorUserId: 1, authoredAt: -1 })
consultationSchema.index({ hospitalId: 1, patientId: 1, authoredAt: -1 })
consultationSchema.index({ hospitalId: 1, status: 1, authoredAt: -1 })

// ────────────────────────────── prescriptions ─────────────────────────────────

/**
 * One prescribed item.
 *
 * Validated strictly by the request schema. In particular `dose`, `route` and
 * `frequency` are REQUIRED and non-empty: a prescription that names a drug without a
 * dose or a route is not a prescription, and the API will not accept one. This is
 * validation of completeness, not of appropriateness — only a clinician can judge the
 * latter, which is why nothing here is ever generated automatically.
 */
const prescriptionItemSchema = new Schema(
  {
    drugName: { type: String, required: true, trim: true, maxlength: 200 },
    /** e.g. "500 mg". Required. */
    dose: { type: String, required: true, trim: true, maxlength: 100 },
    /** e.g. "oral", "topical". Required. */
    route: { type: String, required: true, trim: true, maxlength: 100 },
    /** e.g. "twice daily". Required. */
    frequency: { type: String, required: true, trim: true, maxlength: 100 },
    duration: { type: String, trim: true, maxlength: 100 },
    quantity: { type: String, trim: true, maxlength: 60 },
    instructions: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
)

const prescriptionSchema = tenantScopedSchema(
  'Prescription',
  {
    consultationId: { type: Schema.Types.ObjectId, ref: 'Consultation', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    doctorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    items: {
      type: [prescriptionItemSchema],
      required: true,
      validate: {
        validator: (value: unknown[]) => Array.isArray(value) && value.length > 0 && value.length <= 50,
        message: 'A prescription must have between 1 and 50 items',
      },
    },

    notes: { type: String, trim: true, maxlength: 2000 },

    status: { type: String, enum: ['DRAFT', 'FINALIZED'], default: 'DRAFT' },

    /**
     * Who wrote it.
     *
     * Not optional and not derived from the session at render time: a prescription is a
     * clinician-authored document, and the author is part of what it asserts. The PDF
     * carries this name on its face.
     */
    authoredByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authoredAt: { type: Date, required: true, default: () => new Date() },

    finalizedAt: { type: Date },
    finalizedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },

    /**
     * The generated document, if one exists.
     *
     * A STORAGE KEY, not a URL. Nothing here is ever addressable without passing the
     * authorization check on the download route. A file in a public bucket, or a
     * "unguessable" public path, is one leaked URL away from being in the world.
     */
    documentId: { type: Schema.Types.ObjectId, ref: 'ClinicalDocument' },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

prescriptionSchema.index({ hospitalId: 1, consultationId: 1, authoredAt: -1 })
prescriptionSchema.index({ hospitalId: 1, patientId: 1, authoredAt: -1 })

// ─────────────────────── generated documents (private) ───────────────────────

/**
 * A generated document — a prescription, or an invoice.
 *
 * Holds `storageKey` and never a public URL. Download is always through an authorized
 * route that re-checks the caller's permission on the underlying record, so revoking
 * access takes effect immediately rather than "when the link expires".
 */
const clinicalDocumentSchema = tenantScopedSchema(
  'ClinicalDocument',
  {
    /** Which record this documents, and of what kind. */
    resourceType: { type: String, enum: ['PRESCRIPTION', 'INVOICE'], required: true },
    resourceId: { type: Schema.Types.ObjectId, required: true },

    /** Opaque key into private storage. Never exposed to a client. */
    storageKey: { type: String, required: true },
    fileName: { type: String, required: true },
    contentType: { type: String, required: true, default: 'application/pdf' },
    byteSize: { type: Number, required: true, min: 0 },

    generatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    generatedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

clinicalDocumentSchema.index({ hospitalId: 1, resourceType: 1, resourceId: 1 })
clinicalDocumentSchema.index({ storageKey: 1 }, { unique: true })

export const ConsultationModel =
  (mongoose.models['Consultation'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('Consultation', consultationSchema)

export const PrescriptionModel =
  (mongoose.models['Prescription'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('Prescription', prescriptionSchema)

export const ClinicalDocumentModel =
  (mongoose.models['ClinicalDocument'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('ClinicalDocument', clinicalDocumentSchema)