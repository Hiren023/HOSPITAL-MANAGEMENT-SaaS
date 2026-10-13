import mongoose, { Schema } from 'mongoose'
import { PLANS, SUBSCRIPTION_STATUSES } from '@infinigrow/shared'

import { tenantScopedSchema } from '../../infrastructure/db/tenant-plugin.js'

/**
 * Subscriptions and usage.
 *
 * ── Status is derived from dates, not typed in by hand ────────────────────────
 *
 * A subscription becomes overdue when its period ends without payment, and becomes
 * suspended when the grace period after that runs out. Both are consequences of dates plus
 * `paymentState`, so `evaluate()` derives them. Someone editing `status` by hand would
 * eventually disagree with `currentPeriodEndsAt`, and then which one is true?
 *
 * ── History is append-only ────────────────────────────────────────────────────
 *
 * Every change appends to `history`. A subscription with no history cannot be explained,
 * and "the plan was changed but when, by whom, and from what" is the first question
 * anybody asks after a billing dispute.
 */

const historyEntrySchema = new Schema(
  {
    plan: { type: String, enum: PLANS },
    status: { type: String, enum: SUBSCRIPTION_STATUSES },
    reason: { type: String, trim: true, maxlength: 500 },
    /** `SYSTEM` when a rule fired rather than a person acting. */
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorKind: { type: String, enum: ['USER', 'SYSTEM'], default: 'USER' },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
)

export const subscriptionSchema = tenantScopedSchema(
  'Subscription',
  {
    /** Mirrors `Hospital.plan` so a read does not need two documents joined. */
    plan: { type: String, enum: PLANS, required: true },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true },

    currentPeriodStartsAt: { type: Date, required: true },
    /** The renewal date. */
    currentPeriodEndsAt: { type: Date, required: true },

    /** Absent for a plan with no trial. */
    trialEndsAt: { type: Date },

    /**
     * Set when payment fails. Access continues until this passes, which is the difference
     * between a billing hiccup and a hospital losing its patient list mid-shift.
     */
    gracePeriodEndsAt: { type: Date },

    suspendedAt: { type: Date },

    /**
     * Downgrade at renewal rather than immediately.
     *
     * Removing capabilities the moment someone downgrades would break a hospital that has
     * just decided it does not need reporting. The change lands at renewal, where it was
     * agreed, and not in the middle of a working day.
     */
    cancelAtPeriodEnd: { type: Boolean, default: false },

    provider: { type: String, trim: true, maxlength: 60 },
    providerSubscriptionId: { type: String, trim: true, maxlength: 200 },

    /**
     * See `PaymentState` in the shared plan module: `VERIFIED` is unreachable from any
     * adapter and is set only by an explicit reconciliation naming a person.
     */
    paymentState: {
      type: String,
      enum: ['NONE', 'PENDING', 'VERIFIED', 'FAILED'],
      default: 'NONE',
    },

    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },

    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// One subscription per tenant. Without this a tenant could hold two and pick whichever
// grants it more.
subscriptionSchema.index({ hospitalId: 1 }, { unique: true })
// The sweep: find everything due for a status change.
subscriptionSchema.index({ status: 1, currentPeriodEndsAt: 1 })

export const SubscriptionModel =
  (mongoose.models['Subscription'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('Subscription', subscriptionSchema)

export type { ModuleKey } from '@infinigrow/shared'