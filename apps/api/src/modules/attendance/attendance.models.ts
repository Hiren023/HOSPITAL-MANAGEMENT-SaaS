import mongoose, { Schema } from 'mongoose'

import { tenantScopedSchema } from '../../infrastructure/db/tenant-plugin.js'

/**
 * Staff attendance.
 *
 * ── Why corrections are a workflow and not an edit ────────────────────────────
 *
 * An attendance record is evidence of where a person was. Letting anyone silently edit
 * it would make the record meaningless — the whole value of keeping it is that it cannot
 * be adjusted to suit.
 *
 * So a change is REQUESTED with a reason, and only a holder of `attendance:approve` can
 * apply it. The original values are kept alongside the corrected ones, so the record shows
 * both what was claimed and what was approved. That is the same principle as amendments on
 * a signed clinical record, applied to time.
 */

export const ATTENDANCE_STATUSES = ['OPEN', 'CLOSED', 'CORRECTED'] as const
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number]

/** A requested change to an attendance record, awaiting approval. */
const correctionSchema = new Schema(
  {
    /** What the person is asking to change. */
    field: { type: String, enum: ['checkInAt', 'checkOutAt'], required: true },
    previousValue: { type: Date },
    requestedValue: { type: Date, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    requestedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, required: true, default: () => new Date() },

    decidedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
    decision: { type: String, enum: ['APPROVED', 'REJECTED'] },
    decisionNote: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
)

const attendanceSchema = tenantScopedSchema(
  'AttendanceRecord',
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /**
     * The LOCAL calendar day, `YYYY-MM-DD`, in the hospital's timezone.
     *
     * A date rather than a range, because "did they work on Tuesday" is the question this
     * record answers, and Tuesday is a local day. Deriving it from a timestamp would put
     * a night shift on the wrong day for anyone east or west of UTC.
     */
    workDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    checkInAt: { type: Date, required: true },
    checkOutAt: { type: Date },
    status: { type: String, enum: ATTENDANCE_STATUSES, default: 'OPEN' },

    /** Recorded once at check-in, so the record cannot be back-dated silently. */
    recordedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    corrections: { type: [correctionSchema], default: [] },
  },
  { timestamps: true, strict: true, strictQuery: true },
);

/**
 * One attendance record per person per day.
 *
 * This is what makes double check-in impossible: the second insert is refused by the
 * database rather than by a check the caller might race. The same reasoning as the
 * appointment slot grid.
 */
attendanceSchema.index({ hospitalId: 1, userId: 1, workDate: 1 }, { unique: true })

// The roster views: "the team for this day", and "my own history".
attendanceSchema.index({ hospitalId: 1, workDate: 1, status: 1 })
attendanceSchema.index({ hospitalId: 1, userId: 1, workDate: -1 })

export const AttendanceRecordModel =
  (mongoose.models['AttendanceRecord'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('AttendanceRecord', attendanceSchema)