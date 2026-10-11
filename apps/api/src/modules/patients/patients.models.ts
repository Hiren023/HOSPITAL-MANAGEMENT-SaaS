import mongoose, { Schema } from 'mongoose'

import { tenantScopedSchema } from '../../infrastructure/db/tenant-plugin.js'

/**
 * Patient records.
 *
 * ── What is deliberately NOT stored ────────────────────────────────────────────
 *
 * There is no allergies field, no notes field, no medical history and no diagnosis
 * anywhere on this schema, and that is a decision rather than an oversight.
 *
 * Data minimisation is only real if it happens at collection time. A free-text `notes`
 * field on a patient record becomes somewhere staff paste clinical detail within a week,
 * and once clinical content lives in a row that `ACCOUNTANT` can read through
 * `patient:read`, the permission model has quietly failed. Those belong to the
 * consultation module (Phase 7), where access is separately permissioned and separately
 * audited.
 *
 * What remains is demographics: who this person is and how to reach them. That is the
 * minimum a registration desk genuinely needs, and nothing more.
 *
 * These records are never returned by any platform route. A `SUPER_ADMIN` manages
 * tenants; it does not read patients (docs/SECURITY.md R14).
 */

/** Administrative gender. Clinically this is not always binary; see the note below. */
const GENDERS = ['FEMALE', 'MALE', 'TRANSGENDER', 'OTHER', 'UNDECLARED'] as const

/**
 * `PatientCounter` — the per-hospital patient number sequence.
 *
 * Separate from `Patient` because it is not a patient record: it holds no personal data
 * and must never be joined into one. The number is allocated by an atomic increment, so
 * two registrations running at the same moment cannot receive the same number — and the
 * unique index on `Patient` is the backstop if they somehow do.
 */
const patientCounterSchema = tenantScopedSchema(
  'PatientCounter',
  {
    /** The last number handed out. Starts at 0, so the first patient is 1. */
    seq: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// One counter per hospital. Unique, so an upsert cannot create two racing counters.
patientCounterSchema.index({ hospitalId: 1 }, { unique: true })

const patientSchema = tenantScopedSchema(
  'Patient',
  {
    /**
     * The hospital's own patient number, e.g. `PT-000042`.
     *
     * Scoped to the hospital, NOT unique globally: two hospitals will each hand out
     * `PT-000001`, and that is correct. A patient number is a local filing reference
     * meaningful only to the hospital that issued it, and forcing it to be globally
     * unique would leak the existence and size of one hospital's patient register to
     * every other tenant through a constraint violation.
     */
    patientNumber: { type: String, required: true, trim: true, uppercase: true },

    firstName: { type: String, required: true, trim: true, maxlength: 100 },
    lastName: { type: String, required: true, trim: true, maxlength: 100 },

    /**
     * Date of birth, stored as an instant at UTC midnight.
     *
     * UTC midnight, not the local midnight of the day they were born: a birth date is a
     * calendar date, not a moment, and pinning it to a zone makes it drift by a day for
     * anyone west of Greenwich. It is never rendered as a timestamp for the same reason.
     */
    dateOfBirth: { type: Schema.Types.Date, required: true },

    gender: { type: String, enum: GENDERS, default: 'UNDECLARED' },

    phone: { type: String, trim: true, maxlength: 20 },

    /**
     * `phone` reduced to digits, purely so a lookup can use an index.
     *
     * Someone arriving at a desk reads a number off a card, so `+91 90000 00000`,
     * `090000 00000` and `09000000000` must all find the same record. Matching a
     * normalised copy is the only way to do that with an INDEX: a `$expr` containing a
     * regex is correct in an aggregation but cannot use an index, so every phone lookup
     * would scan the whole patient register.
     *
     * Derived — never accepted from a client — and not selected by default, so it does
     * not travel to the browser. It exists only to be matched against.
     */
    phoneDigits: { type: String, select: false },

    email: { type: String, trim: true, lowercase: true, maxlength: 254 },

    address: {
      line1: { type: String, trim: true, maxlength: 160 },
      line2: { type: String, trim: true, maxlength: 160 },
      city: { type: String, trim: true, maxlength: 80 },
      state: { type: String, trim: true, maxlength: 80 },
      postalCode: { type: String, trim: true, maxlength: 20 },
      country: { type: String, trim: true, maxlength: 80 },
    },

    /**
     * Who to call if the patient cannot be reached. Distinct from the patient's own
     * contact details because it names a THIRD PARTY who has not chosen to be in this
     * system, so it is returned only to callers who may also see the patient's own
     * contact details.
     */
    emergencyContact: {
      name: { type: String, trim: true, maxlength: 120 },
      relationship: { type: String, trim: true, maxlength: 60 },
      phone: { type: String, trim: true, maxlength: 20 },
    },

    /** The account that registered this patient, for "who created this record". */
    registeredByUserId: { type: Schema.Types.ObjectId, ref: 'User' },

    /**
     * Deactivated rather than deleted.
     *
     * A patient record is referenced by appointments and will be referenced by
     * consultations. Deleting it would orphan those, and a record that must be retained
     * for clinical continuity cannot be removed just because someone asked.
     */
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// The hospital-scoped uniqueness guarantee, enforced by the database rather than by a
// check-then-insert that two concurrent registrations could both pass.
patientSchema.index({ hospitalId: 1, patientNumber: 1 }, { unique: true })

// Search is by surname and by patient number; both need the tenant leading so the query
// is answered from the index rather than by filtering after a scan of every patient.
patientSchema.index({ hospitalId: 1, lastName: 1, firstName: 1 })
patientSchema.index({ hospitalId: 1, phoneDigits: 1 })
patientSchema.index({ hospitalId: 1, dateOfBirth: 1 })
patientSchema.index({ hospitalId: 1, isActive: 1, createdAt: -1 })

export const GENDER_VALUES = GENDERS

export const PatientModel =
  (mongoose.models['Patient'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('Patient', patientSchema)

export const PatientCounterModel =
  (mongoose.models['PatientCounter'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('PatientCounter', patientCounterSchema)