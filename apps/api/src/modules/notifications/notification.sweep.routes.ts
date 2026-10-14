import { Router, type NextFunction, type Request, type Response } from 'express'

import { authenticate, requirePlatformPermission } from '../../middleware/auth.js'
import { validate } from '../../validation/validate.js'

import { sweepQuerySchema } from './notification.schemas.js'
import { sweepNotifications } from './notification.service.js'

/**
 * The notification sweep — `/api/v1/platform/notifications/sweep`, SUPER_ADMIN only.
 *
 * ── Why a platform endpoint and not an in-process timer ────────────────────────
 *
 * A `setInterval` in the API process dies with the process. During a deploy, a crash, or a
 * scale-to-zero, the queue stops draining and nothing notices until somebody asks why a
 * reminder never arrived. An endpoint the platform calls has a retry, a log line and an
 * alert when it stops being called — all three of which a timer does not.
 *
 * The cost is that somebody has to call it. That is stated plainly rather than hidden: no
 * scheduler ships in this repository.
 *
 * ── Why it is platform-scoped ─────────────────────────────────────────────────
 *
 * The sweep reads across every tenant by design. A hospital's administrator triggering a
 * global queue drain would be a new capability with no legitimate use, so the router
 * inherits the platform boundary rather than carrying a tenant guard it could be reasoned
 * around.
 */

export const notificationSweepRouter: Router = Router()

notificationSweepRouter.use(authenticate)

/** POST /api/v1/platform/notifications/sweep — process everything currently due. */
notificationSweepRouter.post(
  '/notifications/sweep',
  requirePlatformPermission('platform:report:read'),
  validate({ query: sweepQuerySchema }),
  (req: Request, res: Response, next: NextFunction) => {
    const { limit } = (req as Request & { validatedQuery?: { limit?: number } }).validatedQuery ?? {}

    sweepNotifications({ ip: req.ip ?? '', requestId: req.requestId }, { limit })
      .then((data) => {
        res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
      })
      .catch(next)
  },
)