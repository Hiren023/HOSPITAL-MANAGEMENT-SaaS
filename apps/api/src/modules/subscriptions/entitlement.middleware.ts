import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ModuleKey } from '@infinigrow/shared'

import { ApiError } from '../../infrastructure/api-error.js'

import {
  entitlementContext,
  requireEntitlement,
  requireWritable,
  type EntitlementContext,
} from './subscription.service.js'

/**
 * Entitlement middleware.
 *
 * ── This is the control. The hidden menu item is a courtesy. ──────────────────
 *
 * `requirePermission` answers "may this person do this?"; this answers "may this hospital
 * pay for this?". A role with the right permission and the hospital on a plan that does
 * not include the module is refused, and the refusal names the plan upgrade that would fix
 * it — so the caller gets an instruction, not just a door closing.
 *
 * ── Failing closed ────────────────────────────────────────────────────────────
 *
 * A missing subscription, an unreadable one, or a module key outside the union all DENY.
 * There is no code path through here that allows access it cannot positively prove, which
 * is the property that makes this safe to put in front of a paid-for module.
 *
 * ── Placed after the tenant scope, before the handler ──────────────────────────
 *
 * It needs `req.auth.hospitalId`, which the registrar guarantees is bound. Running
 * earlier would mean reading a hospital id from the request, which is precisely the thing
 * this system has never done and never will.
 */

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `requireModule` / `requireReadable` so handlers need not re-query. */
    entitlements?: EntitlementContext
  }
}

interface AuthShape {
  userId: string
  role: string
  hospitalId: string
  permissions: unknown[]
}

function actorOf(req: Request): Parameters<typeof requireEntitlement>[0] {
  const auth = req.auth as unknown as AuthShape
  return {
    userId: auth.userId,
    role: auth.role,
    hospitalId: auth.hospitalId,
    permissions: auth.permissions as Parameters<typeof requireEntitlement>[0]['permissions'],
  }
}

/**
 * Require this module, and optionally that the subscription permits writing.
 *
 * `write: true` is what stops a suspended tenant from creating records while still
 * letting it read them.
 */
export function requireModule(
  moduleKey: ModuleKey,
  options: { write?: boolean } = {},
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    requireEntitlement(actorOf(req), moduleKey)
      .then((context) => {
        if (options.write === true) requireWritable(context)
        req.entitlements = context
        next()
      })
      .catch(next)
  }
}

/**
 * Require only that the subscription still permits reads.
 *
 * Applied to the routes a suspended tenant must keep: patients, stock, invoices. A
 * hospital in a billing dispute still needs to see its own records, and suspending must
 * never be indistinguishable from losing them. This is the difference between a payment
 * problem and a patient-safety one.
 */
export function requireReadable(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth as unknown as { hospitalId: string }

    entitlementContext(auth.hospitalId)
      .then((context) => {
        if (!context.mayRead) {
          throw ApiError.forbidden(
            'This hospital’s subscription has expired. Renew to restore access. No data has been deleted.',
          )
        }
        req.entitlements = context
        next()
      })
      .catch(next)
  }
}

/**
 * Refuse writes for a subscription that does not permit them, without naming a module.
 *
 * For routes a suspended tenant may still read but must not change. Reading the patient
 * list stays possible; adding a patient does not.
 */
export function requireWritableSubscription(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth as unknown as { hospitalId: string }

    entitlementContext(auth.hospitalId)
      .then((context) => {
        requireWritable(context)
        req.entitlements = context
        next()
      })
      .catch(next)
  }
}