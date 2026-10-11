import mongoose, { Schema } from 'mongoose'

import { HOSPITAL_DEFAULTS } from '@infinigrow/shared'

import { tenantScopedSchema } from '../../infrastructure/db/tenant-plugin.js'

/**
 * Hospital administration records — departments, doctor profiles and schedules.
 *
 * Kept in their own file because all three are tenant-scoped and share one rule the
 * identity models do not: **every unique identifier is scoped to the hospital**.
 *
 * A medical council registration number is unique within a council, not globally — the
 * same doctor may hold registrations in two states, and two different hospitals may each
 * have a doctor registered as "MMC/12345". The API rejects a duplicate within the
 * caller's hospital and nowhere else, so one hospital's records never block another's.
 *
 * These collections are NOT returned by any platform route. A `SUPER_ADMIN` manages
 * tenants; it does not read clinical organisation (docs/SECURITY.md R14).
 */

// ────────────────────────────── departments ──────────────────────────────

/**
 * A clinical or administrative department.
 *
 * `code` is the short form used on signage, rosters and claim forms, so it is required
 * and unique within the hospital — two departments sharing "CARD" would make a printed
 * schedule ambiguous.
 */
const departmentSchema = tenantScopedSchema(
  'Department',
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 20,
    },
    description: { type: String, trim: true, maxlength: 500 },
    /** The doctor who leads this department, if any. */
    headUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// Unique per hospital, not globally: "Cardiology" must be creatable by any tenant.
departmentSchema.index({ hospitalId: 1, code: 1 }, { unique: true })
departmentSchema.index({ hospitalId: 1, name: 1 }, { unique: true })
departmentSchema.index({ hospitalId: 1, isActive: 1, sortOrder: 1 })

export const DepartmentModel = mongoose.models['Department']
  ? (mongoose.models['Department'] as mongoose.Model<unknown>)
  : mongoose.model('Department', departmentSchema)

// ────────────────────────────── doctor profiles ──────────────────────────────

/**
 * A doctor's professional record, separate from their login account.
 *
 * Deliberately not fields on `User`: a person's identity (name, email, phone) is an
 * account concern that the platform can already see, while their registration number,
 * qualifications and fee are professional data belonging to one hospital. Splitting them
 * means a future staff-only screen cannot accidentally expose a licence number.
 *
 * `registrationNumber` is treated as sensitive throughout Phase 5 — the API masks it for
 * identities without `doctor:write`. See `modules/hospital-admin/staff.service.ts`.
 */
const doctorProfileSchema = tenantScopedSchema(
  'DoctorProfile',
  {
    /** The user this profile belongs to. Unique per hospital. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    departmentId: { type: Schema.Types.ObjectId, ref: 'Department' },

    /** Medical council registration. Unique per hospital, never globally. */
    registrationNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 60,
    },

    specialities: { type: [String], default: [] },
    qualifications: { type: [String], default: [] },
    yearsOfExperience: { type: Number, min: 0, max: 80, default: 0 },

    /** Stored in the hospital's configured minor units (paise, here). */
    consultationFeeInPaise: { type: Number, min: 0, default: 0 },

    bio: { type: String, trim: true, maxlength: 2_000 },
    isAcceptingNewPatients: { type: Boolean, default: true },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

doctorProfileSchema.index({ hospitalId: 1, userId: 1 }, { unique: true })
doctorProfileSchema.index({ hospitalId: 1, registrationNumber: 1 }, { unique: true })
doctorProfileSchema.index({ hospitalId: 1, departmentId: 1 })

export const DoctorProfileModel = mongoose.models['DoctorProfile']
  ? (mongoose.models['DoctorProfile'] as mongoose.Model<unknown>)
  : mongoose.model('DoctorProfile', doctorProfileSchema)

// ────────────────────────────── working schedules ──────────────────────────────

/**
 * One recurring working block for a doctor.
 *
 * Times are stored as MINUTES FROM MIDNIGHT rather than as `Date` or `HH:mm` strings.
 * A 24-hour time has no date, so it is not a `Date`; and a string would need parsing,
 * comparison and sorting as strings in three different places. Minutes are unambiguous,
 * sort correctly, and make "does this block end before it starts?" a single comparison.
 *
 * Uniqueness on `{hospitalId, doctorUserId, weekday}` means a doctor has at most one
 * block per day. Two overlapping blocks cannot therefore be created by accident, which
 * is the failure that would otherwise produce double-booked slots.
 */
const scheduleSchema = tenantScopedSchema(
  'Schedule',
  {
    doctorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /** 0 = Sunday … 6 = Saturday, matching `Date.prototype.getDay`. */
    weekday: { type: Number, required: true, min: 0, max: 6 },

    /** Minutes from midnight, inclusive. */
    startMinute: { type: Number, required: true, min: 0, max: 24 * 60 - 1 },

    /** Exclusive. Must be greater than `startMinute`. */
    endMinute: { type: Number, required: true, min: 1, max: 24 * 60 },

    slotDurationMinutes: { type: Number, default: 15, min: 5, max: 120 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

scheduleSchema.index({ hospitalId: 1, doctorUserId: 1, weekday: 1 }, { unique: true })
scheduleSchema.index({ hospitalId: 1, doctorUserId: 1 })

export const ScheduleModel = mongoose.models['Schedule']
  ? (mongoose.models['Schedule'] as mongoose.Model<unknown>)
  : mongoose.model('Schedule', scheduleSchema)

export type DepartmentDocument = mongoose.Document & Record<string, unknown>
export type DoctorProfileDocument = mongoose.Document & Record<string, unknown>
export type ScheduleDocument = mongoose.Document & Record<string, unknown>

/** Re-exported so the hospital-admin module can reuse the same defaults object. */
export { HOSPITAL_DEFAULTS }