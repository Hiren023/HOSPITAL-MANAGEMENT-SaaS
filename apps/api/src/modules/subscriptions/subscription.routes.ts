import type { NextFunction, Request, Response } from 'express'

import { requirePermission } from '../../middleware/auth.js'
import { createTenantRouter } from '../../infrastructure/tenant-router.js'

import {
  readOwnEntitlements,
  readOwnSubscription,
  type SubscriptionActor,
} from './subscription.service.js'

/**
 * Tenant-facing subscription routes — `/api/v1/hospital/subscription`, `/hospital/entitlements`.
 *
 * ── Read-only, deliberately ───────────────────────────────────────────────────
 *
 * A hospital can see what it bought, what it has used, when it renews and what happens
 * at renewal. It cannot renew, upgrade, cancel or un-suspend itself. All of those are the
 * platform operator's actions, and the only payment state a tenant can reach is the one
 * it already has — a tenant cannot mark its own invoice paid, which is the Phase 8 rule
 * applied one level up.
 *
 * ── It never 404s for a missing subscription ──────────────────────────────────
 *
 * A tenant with no configured subscription gets an explicit `configured: false`, not an
 * empty object. An empty response reads as "you have nothing" rather than "we do not
 * know", and the operator needs to see the difference between those.
 */

const { router, route } = createTenantRouter()

function actorOf(req: Request): SubscriptionActor {
  const auth = req.auth as unknown as {
    userId: string
    role: string
    hospitalId: string
    permissions: SubscriptionActor['permissions']
  }
  return {
    userId: auth.userId,
    role: auth.role,
    hospitalId: auth.hospitalId,
    permissions: auth.permissions,
  }
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }
}

/**
 * GET /api/v1/hospital/subscription — plan, status, entitlements, usage, renewal.
 *
 * ── Deliberately NOT behind `requireReadable()` ─────────────────────────────────
 *
 * The obvious guard is the subscription gate itself. That would be self-defeating: a
 * tenant whose subscription has just lapsed would get a 403 telling them to renew, from
 * the one screen that shows the renewal date.
 *
 * `readOwnSubscription` never throws. It returns `mayRead: false` and `denied:
 * 'SUBSCRIPTION_EXPIRED'` and lets the UI explain the situation in full. This route is
 * the one place in the tenant API that is always available, which is exactly why it is
 * safe for it to be: it exposes plan and usage, not patient data.
 */
route(
  'get',
  '/hospital/subscription',
  requirePermission('subscription:read'),
  handle(async (req, res) => {
    const data = await readOwnSubscription(actorOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/**
 * GET /api/v1/hospital/entitlements — just the module keys.
 *
 * Exists so the shell can decide what to render without re-parsing the whole subscription
 * payload on every navigation. **The client uses this to hide nav items for usability; the
 * server enforces the same rules independently.** A hidden link is a courtesy, and this
 * endpoint being wrong is not a security event — the API refuses regardless.
 *
 * Unguarded by the subscription gate for the same reason as above: the shell needs to
 * know it is suspended in order to render the banner that explains it.
 */
route(
  'get',
  '/hospital/entitlements',
  requirePermission('hospital:read'),
  handle(async (req, res) => {
    const data = await readOwnEntitlements(actorOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

export { router as subscriptionRouter }