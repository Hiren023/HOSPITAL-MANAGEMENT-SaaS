import { z } from 'zod'

import { PAYMENT_STATES, PLANS, objectIdSchema } from '@infinigrow/shared'

/**
 * Validation for subscription management.
 *
 * Everything is `.strict()`, for the same reason the platform schemas are: a field that
 * is silently dropped is worse than a rejected request, because the caller believes it
 * took effect.
 *
 * ── What is deliberately absent ────────────────────────────────────────────────
 *
 * There is no `entitlements` field anywhere in this file. There is no `status` field on
 * assignment, no `seatLimit`, no `departmentLimit`, no `price`.
 *
 * All of those come from the plan catalogue, not from the request. If a caller could send
 * `entitlements: ['BILLING', 'PHARMACY']`, the subscription feature would be a
 * self-service upgrade button. `.strict()` is what makes refusing that a hard guarantee
 * rather than a convention — a body containing those keys is a 422, not a quietly
 * ignored extra.
 */

export const subscriptionHospitalParamSchema = z.object({ hospitalId: objectIdSchema }).strict()

/**
 * Create or replace a subscription.
 *
 * `periodDays` is an integer, 1–366. A period of zero or negative days would create a
 * subscription that is already overdue the instant it is written, which is a support
 * ticket nobody enjoys.
 */
export const assignSubscriptionSchema = z
  .object({
    plan: z.enum(PLANS),
    /** Opt into the plan's trial. Ignored when the plan has none. */
    startTrial: z.boolean().optional(),
    periodDays: z.number().int().min(1).max(366).optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()

/**
 * Amend a subscription.
 *
 * `reactivate` clears a suspension but deliberately does **not** restore `ACTIVE`. A
 * reactivated tenant goes to `PAST_DUE` and runs its own grace period, because somebody
 * still has to confirm that money arrived. Un-suspending is not paying.
 */
export const updateSubscriptionSchema = z
  .object({
    plan: z.enum(PLANS).optional(),
    /** Downgrade at renewal rather than immediately. */
    cancelAtPeriodEnd: z.boolean().optional(),
    cancelNow: z.boolean().optional(),
    reactivate: z.boolean().optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.plan !== undefined ||
      value.cancelAtPeriodEnd !== undefined ||
      value.cancelNow !== undefined ||
      value.reactivate !== undefined,
    { message: 'Nothing to change. Provide at least one of plan, cancelAtPeriodEnd, cancelNow, reactivate.' },
  )

/**
 * Record the result of a payment.
 *
 * This is the only route in the system that can set `VERIFIED`, and it is a person
 * pressing a button after looking at something. There is no provider callback, no
 * webhook and no "trust me" path — `docs/SECURITY.md` R16 and `docs/MONEY.md`.
 *
 * `NONE` is not accepted: un-verifying back to "we have no information" is expressed by
 * `FAILED` (we tried and it did not work) or by leaving the state alone.
 */
export const reconcilePaymentSchema = z
  .object({
    paymentState: z.enum(['PENDING', 'VERIFIED', 'FAILED']),
    providerSubscriptionId: z.string().trim().max(200).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict()

/** `?at=` — run the rules as at a given instant. For testing and for backdating a sweep. */
export const evaluateQuerySchema = z
  .object({
    at: z.string().trim().optional(),
  })
  .strict()

export const SUBSCRIPTION_STATES = PAYMENT_STATES