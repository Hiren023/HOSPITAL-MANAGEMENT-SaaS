import { Router, type NextFunction, type Request, type Response } from 'express'

import { authenticate, requirePlatformPermission } from '../../middleware/auth.js'
import { validate } from '../../validation/validate.js'

import {
  assignSubscriptionSchema,
  evaluateQuerySchema,
  reconcilePaymentSchema,
  subscriptionHospitalParamSchema,
  updateSubscriptionSchema,
} from './subscription.schemas.js'
import {
  assignPlan,
  evaluateSubscription,
  readSubscriptionForPlatform,
  reconcilePayment,
  updateSubscription,
  type Meta,
  type SubscriptionActor,
} from './subscription.service.js'
import { PLAN_DEFINITIONS, type Plan } from '@infinigrow/shared'

/**
 * Platform-side subscription management — `/api/v1/platform/subscriptions/*`, SUPER_ADMIN.
 *
 * ── Its own router, mounted inside the platform boundary ───────────────────────
 *
 * Every route applies `authenticate` and `requirePlatformPermission`, so the boundary
 * holds by construction rather than by each handler remembering. A tenant administrator
 * cannot reach any of this, and not because links are hidden — the guard rejects the
 * identity itself.
 *
 * ── Nothing here accepts an entitlement ────────────────────────────────────────
 *
 * There is no field in any schema for what a plan unlocks. The catalogue decides that.
 * If an operator could type entitlements into a request body, this endpoint would be a
 * self-service upgrade button and the whole entitlement mechanism would be theatre.
 */

export const platformSubscriptionRouter: Router = Router()

platformSubscriptionRouter.use(authenticate)

function actorOf(req: Request): SubscriptionActor {
  const auth = req.auth as { userId: string; role: string }
  // A platform operator has no hospital. These routes act on behalf of the hospital in
  // the path, which is why `hospitalId` is a parameter here and never read from the body.
  return { userId: auth.userId, role: auth.role, hospitalId: '', permissions: [] }
}

/**
 * Request metadata, including who is acting.
 *
 * `actorUserId`/`actorRole` are carried because every platform operation writes a
 * `PLATFORM_SCOPE_USED` audit entry, and an audit entry without an actor is not an
 * audit entry. A SUPER_ADMIN has no hospital, so this cannot be derived from the tenant
 * context the way it is elsewhere in the system.
 */
function metaOf(req: Request): Meta {
  const auth = req.auth as { userId: string; role: string }
  return {
    ip: req.ip ?? '',
    requestId: req.requestId,
    actorUserId: auth.userId,
    actorRole: auth.role,
  }
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }
}

function bodyOf<T>(req: Request): T {
  return req.body as T
}

/**
 * GET /api/v1/platform/subscriptions/plans — the catalogue.
 *
 * Includes entitlements, because "which plan" is only meaningful alongside "what that
 * plan actually lets you do". Prices are integer minor units per `docs/MONEY.md`; there
 * is no float in this payload.
 */
platformSubscriptionRouter.get(
  '/plans',
  requirePlatformPermission('platform:plan:manage'),
  handle(async (_req, res) => {
    res.status(200).json({
      success: true,
      data: {
        plans: Object.values(PLAN_DEFINITIONS).map((definition) => ({
          plan: definition.plan,
          label: definition.label,
          seatLimit: definition.seatLimit,
          departmentLimit: definition.departmentLimit,
          entitlements: definition.entitlements,
          trialDays: definition.trialDays,
          gracePeriodDays: definition.gracePeriodDays,
          monthlyPriceMinor: definition.monthlyPriceMinor,
        })),
      },
      meta: { requestId: _req.requestId },
    })
  }),
)

/** GET /api/v1/platform/subscriptions/hospitals/:hospitalId — full state plus history. */
platformSubscriptionRouter.get(
  '/hospitals/:hospitalId',
  requirePlatformPermission('platform:plan:manage'),
  validate({ params: subscriptionHospitalParamSchema }),
  handle(async (req, res) => {
    const { hospitalId } = req.params as { hospitalId: string }
    const data = await readSubscriptionForPlatform(actorOf(req), metaOf(req), hospitalId)
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/**
 * PUT /api/v1/platform/subscriptions/hospitals/:hospitalId — create or replace.
 *
 * Upsert rather than 409-on-exists: reassigning a plan is the common operation, and an
 * operator switching a hospital from Starter to Hospital mid-call should not have to know
 * whether a row already exists first.
 */
platformSubscriptionRouter.put(
  '/hospitals/:hospitalId',
  requirePlatformPermission('platform:plan:manage'),
  validate({ params: subscriptionHospitalParamSchema, body: assignSubscriptionSchema }),
  handle(async (req, res) => {
    const { hospitalId } = req.params as { hospitalId: string }
    const { plan, startTrial, periodDays, reason } = bodyOf<{
      plan: Plan
      startTrial?: boolean
      periodDays?: number
      reason?: string
    }>(req)

    const data = await assignPlan(actorOf(req), metaOf(req), hospitalId, {
      plan,
      startTrial,
      periodDays,
      reason,
    })
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** PATCH /api/v1/platform/subscriptions/hospitals/:hospitalId — plan, cancel, reactivate. */
platformSubscriptionRouter.patch(
  '/hospitals/:hospitalId',
  requirePlatformPermission('platform:plan:manage'),
  validate({ params: subscriptionHospitalParamSchema, body: updateSubscriptionSchema }),
  handle(async (req, res) => {
    const { hospitalId } = req.params as { hospitalId: string }
    const { plan, cancelAtPeriodEnd, cancelNow, reactivate, reason } = bodyOf<{
      plan?: Plan
      cancelAtPeriodEnd?: boolean
      cancelNow?: boolean
      reactivate?: boolean
      reason?: string
    }>(req)

    const data = await updateSubscription(actorOf(req), metaOf(req), hospitalId, {
      plan,
      cancelAtPeriodEnd,
      cancelNow,
      reactivate,
      reason,
    })
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/**
 * POST /api/v1/platform/subscriptions/hospitals/:hospitalId/payment — record a payment.
 *
 * **The only route in the system that can set `VERIFIED`.** It is a person pressing a
 * button after looking at something — a bank statement, a provider dashboard — and there
 * is no provider callback or webhook that reaches this state.
 *
 * A provider saying "paid" is a claim. Phase 8 already learned that lesson for invoices
 * and it applies identically here, so the rule is stated once and enforced twice.
 */
platformSubscriptionRouter.post(
  '/hospitals/:hospitalId/payment',
  requirePlatformPermission('platform:plan:manage'),
  validate({ params: subscriptionHospitalParamSchema, body: reconcilePaymentSchema }),
  handle(async (req, res) => {
    const { hospitalId } = req.params as { hospitalId: string }
    const { paymentState, providerSubscriptionId, reason } = bodyOf<{
      paymentState: 'PENDING' | 'VERIFIED' | 'FAILED'
      providerSubscriptionId?: string
      reason?: string
    }>(req)

    const data = await reconcilePayment(actorOf(req), metaOf(req), hospitalId, {
      paymentState,
      providerSubscriptionId,
      reason,
    })
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/**
 * POST /api/v1/platform/subscriptions/hospitals/:hospitalId/evaluate — run the rules now.
 *
 * **Idempotent by construction**, which matters because it is invoked from a sweep, from
 * this button, and by operators who refresh. An endpoint that behaved differently on its
 * second call would be impossible to reason about during an incident.
 */
platformSubscriptionRouter.post(
  '/hospitals/:hospitalId/evaluate',
  requirePlatformPermission('platform:plan:manage'),
  validate({ params: subscriptionHospitalParamSchema, query: evaluateQuerySchema }),
  handle(async (req, res) => {
    const { hospitalId } = req.params as { hospitalId: string }
    const { at } = (req as Request & { validatedQuery?: { at?: string } }).validatedQuery ?? {}

    const now = at ? new Date(at) : new Date()
    if (Number.isNaN(now.getTime())) {
      res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '`at` is not a valid date-time.',
          requestId: req.requestId,
        },
      })
      return
    }

    const data = await evaluateSubscription(hospitalId, now, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)