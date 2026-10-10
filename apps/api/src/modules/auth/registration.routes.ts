import { Router, type NextFunction, type Request, type Response } from 'express'
import type { Model } from 'mongoose'

import { authenticate, requirePlatformPermission } from '../../middleware/auth.js'
import { registrationLimiter } from '../../middleware/rate-limit.js'
import { validate } from '../../validation/validate.js'
import { ApiError } from '../../infrastructure/api-error.js'
import { withPlatformScope } from '../../infrastructure/db/tenant-plugin.js'
import { HospitalModel } from '../identity/models.js'
import { AUDIT_ACTIONS } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'
import { hospitalIdParamSchema, hospitalRegistrationSchema } from './auth.schemas.js'
import { registerHospital } from './registration.service.js'

/**
 * Hospital registration and platform (SUPER_ADMIN) tenant administration.
 *
 * All platform routes live under `/api/v1/platform/*` in ONE router, behind
 * `requirePlatformPermission`. Centralising them means a `SUPER_ADMIN` capability
 * cannot be added at an unexpected path, and a hospital role can never reach one.
 *
 * `POST /hospitals` is UNAUTHENTICATED by necessity — a new hospital is onboarding and
 * nobody can already belong to it. That is why the safe-creation properties matter:
 *
 *  - The tenant is created PENDING and is unusable until approved.
 *  - The administrator role is assigned server-side, never from the payload.
 *  - Rate limited, because each call provisions real state.
 *  - Validated with a `.strict()` schema, so no unexpected field is accepted.
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

/** GET /api/v1/platform/hospitals — requires platform:hospital:read. */
registrationRouter.get(
  '/hospitals',
  authenticate,
  requirePlatformPermission('platform:hospital:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = (await withPlatformScope(() =>
        (HospitalModel as Model<Record<string, unknown>>)
          .find({})
          .sort({ createdAt: -1 })
          .limit(100)
          .lean()
          .exec(),
      )) as Record<string, unknown>[]

      await recordAudit({
        action: AUDIT_ACTIONS.PLATFORM_SCOPE_USED,
        actorUserId: String((req.auth as { userId: string }).userId),
        actorRole: String((req.auth as { role: string }).role),
        resourceType: 'Hospital',
        resourceId: 'collection',
        ip: req.ip ?? '',
        requestId: req.requestId,
        metadata: { operation: 'list_hospitals', rowsReturned: rows.length },
      })

      res.status(200).json({
        success: true,
        data: rows.map((row) => ({
          id: String(row['_id']),
          name: row['name'],
          slug: row['slug'],
          status: row['status'],
          createdAt: row['createdAt'],
        })),
        meta: { requestId: req.requestId },
      })
    } catch (error) {
      next(error)
    }
  },
)

/** POST /api/v1/platform/hospitals/:hospitalId/approve — requires platform:hospital:approve. */
registrationRouter.post(
  '/hospitals/:hospitalId/approve',
  authenticate,
  requirePlatformPermission('platform:hospital:approve'),
  validate({ params: hospitalIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { hospitalId } = req.params as { hospitalId: string }

      const updated = await withPlatformScope(() =>
        (HospitalModel as Model<Record<string, unknown>>)
          .findByIdAndUpdate(
            hospitalId,
            {
              $set: {
                status: 'APPROVED',
                approvedAt: new Date(),
                approvedBy: (req.auth as { userId: string }).userId,
              },
            },
            { new: true },
          )
          .lean()
          .exec(),
      )

      if (!updated) throw ApiError.notFound()

      await recordAudit({
        action: AUDIT_ACTIONS.HOSPITAL_APPROVED,
        actorUserId: String((req.auth as { userId: string }).userId),
        actorRole: String((req.auth as { role: string }).role),
        hospitalId,
        resourceType: 'Hospital',
        resourceId: hospitalId,
        ip: req.ip ?? '',
        requestId: req.requestId,
      })

      res.status(200).json({ success: true, data: { hospitalId, status: 'APPROVED' } })
    } catch (error) {
      next(error)
    }
  },
)

/** POST /api/v1/platform/hospitals/:hospitalId/suspend — requires platform:hospital:suspend. */
registrationRouter.post(
  '/hospitals/:hospitalId/suspend',
  authenticate,
  requirePlatformPermission('platform:hospital:suspend'),
  validate({ params: hospitalIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { hospitalId } = req.params as { hospitalId: string }

      const updated = await withPlatformScope(() =>
        (HospitalModel as Model<Record<string, unknown>>)
          .findByIdAndUpdate(
            hospitalId,
            { $set: { status: 'SUSPENDED', suspendedAt: new Date() } },
            { new: true },
          )
          .lean()
          .exec(),
      )

      if (!updated) throw ApiError.notFound()

      await recordAudit({
        action: AUDIT_ACTIONS.HOSPITAL_SUSPENDED,
        actorUserId: String((req.auth as { userId: string }).userId),
        actorRole: String((req.auth as { role: string }).role),
        hospitalId,
        resourceType: 'Hospital',
        resourceId: hospitalId,
        ip: req.ip ?? '',
        requestId: req.requestId,
      })

      res.status(200).json({ success: true, data: { hospitalId, status: 'SUSPENDED' } })
    } catch (error) {
      next(error)
    }
  },
)