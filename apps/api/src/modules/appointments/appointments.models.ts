import mongoose, { Schema } from 'mongoose'

import { tenantScopedSchema } from '../../infrastructure/db/tenant-plugin.js'

/**
 * Appointments.
 *
 * ── Times ──────────────────────────────────────────────────────────────────────
 *
 * `startAt` and `endAt` are UTC instants. Meaning is derived, never stored twice: the
 * hospital-local weekday and time-of-day are computed from the instant at read time using
 * the hospital's configured zone (see `utilities/hospital-time.ts`). Storing a redundant
 * local copy would be a second source of truth that drifts the first time a hospital
 * changes timezone or a DST rule is updated.
 *
 * ── The double-booking guarantee ───────────────────────────────────────────────
 *
 * MongoDB has no time-range exclusion constraint, so "this doctor is free at 09:00" cannot
 * be expressed as an index over a start and end range. What it *can* express is
 * uniqueness on a tuple.
 *
 * So occupied time is materialised as one `AppointmentSlot` row per booked slot, with a
 * unique index on `{ hospitalId, doctorUserId, slotStart }`. Booking inserts those rows;
 * a duplicate-key error **is** the conflict, decided by the database.
 *
 * This matters because an application-level "is the doctor free?" check followed by an
 * insert is not atomic. Two receptionists booking the same slot at the same instant both
 * read "free", both write, and the second silently overwrites or duplicates. A unique
 * index has no such window: exactly one insert can ever win, no matter how many app
 * instances are running.
 */

export const APPOINTMENT_STATUSES = [
  'SCHEDULED',
  'CONFIRMED',
  'CHECKED_IN',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]

/**
 * Statuses from which no further transition is allowed.
 *
 * Enforced as data rather than scattered `if` statements, so "is this appointment still
 * open?" has exactly one answer and cannot drift between the service and the UI.
 */
export const TERMINAL_STATUSES: ReadonlySet<AppointmentStatus> = new Set<AppointmentStatus>([
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
])

/** One entry in an appointment's status history. */
const statusEventSchema = new Schema(
  {
    from: { type: String, enum: APPOINTMENT_STATUSES, default: null },
    to: { type: String, enum: APPOINTMENT_STATUSES, required: true },
    at: { type: Date, required: true, default: () => new Date() },
    byUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    /**
     * Why the change happened.
     *
     * Free text, written by staff, and therefore the one field in this module that can
     * carry anything a person types — including something clinical. It is returned with
     * the appointment and is never copied into the audit trail's metadata, which records
     * only that a cancellation happened and who did it.
     */
    reason: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
)

const appointmentSchema = tenantScopedSchema(
  'Appointment',
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    doctorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    doctorProfileId: { type: Schema.Types.ObjectId, ref: 'DoctorProfile' },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department' },

    /** UTC instants. See the file header. */
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },

    status: { type: String, enum: APPOINTMENT_STATUSES, default: 'SCHEDULED' },

    /**
     * Why the patient is coming, in the patient's or referrer's words.
     *
     * Short and free-text by necessity — the alternative is a coded reason list that
     * cannot anticipate what brings someone to a doctor. It is treated as patient data
     * throughout: never audited, never logged, and returned only alongside the
     * appointment itself.
     */
    reason: { type: String, trim: true, maxlength: 300 },

    /**
     * Every status change, oldest first.
     *
     * Embedded rather than referenced: an appointment has a handful of transitions over
     * its life, they are always read with it, and a second collection would buy nothing
     * except a way for the history and the appointment to disagree.
     */
    statusHistory: { type: [statusEventSchema], default: [] },

    cancelledAt: { type: Date },
    cancelledByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    cancellationReason: { type: String, trim: true, maxlength: 500 },

    /**
     * Groups the slot rows belonging to one reservation attempt.
     *
     * Rolling back a partially-failed reservation must delete exactly the rows that
     * attempt created and nothing else. Without this marker the only way to undo a failed
     * insert is `deleteMany` on the doctor's whole day, which would silently cancel
     * everyone else's bookings.
     */
    reservationId: { type: String, required: true },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// The day and week views. Both are range queries on startAt within a tenant, so
// hospitalId leads and the range follows.
appointmentSchema.index({ hospitalId: 1, startAt: 1 })
appointmentSchema.index({ hospitalId: 1, doctorUserId: 1, startAt: 1 })
appointmentSchema.index({ hospitalId: 1, patientId: 1, startAt: -1 })

// ────────────────────────────── appointment slots ──────────────────────────────

/**
 * One row per occupied slot. See the double-booking note in the file header.
 *
 * `slotStart` is the UTC instant of the slot's beginning. Duration lives here as well as
 * on the appointment because a slot's own length is what makes two bookings collide — and
 * a 40-minute appointment must occupy two 20-minute slots, not one.
 */
const appointmentSlotSchema = tenantScopedSchema(
  'AppointmentSlot',
  {
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true },
    doctorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    slotStart: { type: Date, required: true },
    /** See `reservationId` on the appointment. */
    reservationId: { type: String, required: true },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

/**
 * THE CONSTRAINT THAT PREVENTS DOUBLE BOOKING.
 *
 * One row per doctor per slot instant, per hospital. Two concurrent reservations for the
 * same slot both try to insert here; the database lets exactly one through and rejects
 * the other with a duplicate-key error. No application check can be lost to a race,
 * because this decision is not made in application code.
 */
appointmentSlotSchema.index(
  { hospitalId: 1, doctorUserId: 1, slotStart: 1 },
  { unique: true },
)

// Releasing a booking must find its own rows without scanning the doctor's whole day.
appointmentSlotSchema.index({ hospitalId: 1, appointmentId: 1 })
appointmentSlotSchema.index({ hospitalId: 1, reservationId: 1 })

export const AppointmentModel =
  (mongoose.models['Appointment'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('Appointment', appointmentSchema)

export const AppointmentSlotModel =
  (mongoose.models['AppointmentSlot'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('AppointmentSlot', appointmentSlotSchema)