import { Router, type NextFunction, type Request, type Response } from 'express'

import { registrationLimiter } from '../../middleware/rate-limit.js'
import { validate } from '../../validation/validate.js'
import { hospitalRegistrationSchema } from './auth.schemas.js'
import { registerHospital } from './registration.service.js'

/**
 * Public hospital registration — the ONLY unauthenticated route under
 * `/api/v1/platform/*`.
 *
 * It must be unauthenticated: a hospital registering for the first time has nobody who
 * could already be a member of it. That is why the safe-creation properties matter:
 *
 *  - The tenant is created PENDING and is unusable until approved.
 *  - The administrator role is assigned server-side, never from the payload.
 *  - Rate limited, because each call provisions real state.
 *  - Validated with a `.strict()` schema, so no unexpected field is accepted.
 *
 * Everything else on `/api/v1/platform/*` moved to
 * `modules/platform/platform.routes.ts` in Phase 4. Keeping public registration in its
 * own file is not tidiness — it is what lets the platform router apply `authenticate`
 * to *every* one of its routes without exception, so a future endpoint inherits the
 * platform boundary by construction rather than by remembering to write the middleware.
 */
export const registrationRouter: Router = Router()

/** POST /api/v1/platform/hospitals — public registration. */
registrationRouter.post(
  '/hospitals',
  registrationLimiter,
  validate({ body: hospitalRegistrationSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await registerHospital(req.body, {
        ip: req.ip ?? '',
        requestId: req.requestId,
      })

      res.status(201).json({
        success: true,
        data: {
          hospitalId: result.hospitalId,
          slug: result.hospitalSlug,
          status: result.hospitalStatus,
          message:
            'Hospital registered. It is pending approval and cannot be used until an ' +
            'administrator approves it.',
        },
        meta: { requestId: req.requestId },
      })
    } catch (error) {
      next(error)
    }
  },
)
