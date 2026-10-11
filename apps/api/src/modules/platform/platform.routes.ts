import { Router, type NextFunction, type Request, type Response } from 'express'

import { authenticate, requirePlatformPermission } from '../../middleware/auth.js'
import { validate } from '../../validation/validate.js'
import {
  assignPlanSchema,
  auditListQuerySchema,
  changeUserStatusSchema,
  hospitalDetailQuerySchema,
  hospitalIdParamSchema,
  hospitalListQuerySchema,
  platformReportQuerySchema,
  reactivateHospitalSchema,
  suspendHospitalSchema,
  tenantUserListQuerySchema,
  userIdParamSchema,
} from './platform.schemas.js'
import {
  assignPlan,
  changeUserStatus,
  hospitalDetail,
  listAuditEvents,
  listHospitals,
  listTenantUsers,
  operationalReport,
  platformOverview,
  reactivateHospital,
  suspendHospital,
  type Actor,
  type AuditQuery,
  type HospitalListQuery,
  type Meta,
  type TenantUserQuery,
} from './platform.service.js'
import { approveHospital } from '../auth/registration.service.js'
import { isPlan } from '@infinigrow/shared'

/**
 * Platform console routes — `/api/v1/platform/*`, SUPER_ADMIN only.
 *
 * EVERY route on this router applies both `authenticate` and
 * `requirePlatformPermission`. There is no public route here and no conditional guard:
 * a new endpoint added to this router inherits the platform boundary by construction,
 * rather than by remembering to write the middleware. The single exception is public
 * hospital registration, which lives in `registration.routes.ts` because a brand-new
 * hospital has nobody who could already be a member of it.
 *
 * `requirePlatformPermission` rejects any token carrying a hospital `hospitalId`, so a
 * hospital administrator cannot reach any of this — not by hiding links in the UI, but
 * by the guard refusing the identity itself (docs/SECURITY.md R12).
 *
 * Route-level validation runs before the handler, so a service never sees an
 * unvalidated string, page number or ObjectId.
 */
export const platformRouter: Router = Router()

/** Every route below is authenticated and platform-scoped. */
platformRouter.use(authenticate)

function actorOf(req: Request): Actor {
  const auth = req.auth as { userId: string; role: string }
  return { userId: auth.userId, role: auth.role }
}

function metaOf(req: Request): Meta {
  return { ip: req.ip ?? '', requestId: req.requestId }
}

/**
 * The validated query.
 *
 * Express 5 makes `req.query` a getter-only property, so `validate` stores the parsed,
 * coerced result on `req.validatedQuery` instead. Reading `req.query` directly would
 * hand the service raw strings — `page` as `"1"`, `pageSize` as `"20"` — and
 * arithmetic on those yields `NaN`, which surfaces as a broken page rather than a
 * validation error.
 */
function queryOf<T>(req: Request): T {
  return (req as Request & { validatedQuery?: T }).validatedQuery ?? ({} as T)
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }
}

/** GET /api/v1/platform/overview — requires platform:hospital:read */
platformRouter.get(
  '/overview',
  requirePlatformPermission('platform:hospital:read'),
  handle(async (req, res) => {
    const data = await platformOverview(actorOf(req), metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** GET /api/v1/platform/hospitals — server-side search, filter and pagination. */
platformRouter.get(
  '/hospitals',
  requirePlatformPermission('platform:hospital:read'),
  validate({ query: hospitalListQuerySchema }),
  handle(async (req, res) => {
    const data = await listHospitals(actorOf(req), queryOf<HospitalListQuery>(req), metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** GET /api/v1/platform/hospitals/:hospitalId — tenant detail. */
platformRouter.get(
  '/hospitals/:hospitalId',
  requirePlatformPermission('platform:hospital:read'),
  validate({ params: hospitalIdParamSchema, query: hospitalDetailQuerySchema }),
  handle(async (req, res) => {
    const { hospitalId } = req.params as { hospitalId: string }
    const data = await hospitalDetail(actorOf(req), hospitalId, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** GET /api/v1/platform/hospitals/:hospitalId/users — tenant staff accounts. */
platformRouter.get(
  '/hospitals/:hospitalId/users',
  requirePlatformPermission('platform:user:manage'),
  validate({ params: hospitalIdParamSchema, query: tenantUserListQuerySchema }),
  handle(async (req, res) => {
    const { hospitalId } = req.params as { hospitalId: string }
    const data = await listTenantUsers(
      actorOf(req),
      hospitalId,
      queryOf<TenantUserQuery>(req),
      metaOf(req),
    )
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** POST /api/v1/platform/hospitals/:hospitalId/approve */
platformRouter.post(
  '/hospitals/:hospitalId/approve',
  requirePlatformPermission('platform:hospital:approve'),
  validate({ params: hospitalIdParamSchema }),
  handle(async (req, res) => {
    const { hospitalId } = req.params as { hospitalId: string }
    const actor = actorOf(req)
    const data = await approveHospital({ hospitalId, actor, meta: metaOf(req) })
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** POST /api/v1/platform/hospitals/:hospitalId/suspend — a reason is mandatory. */
platformRouter.post(
  '/hospitals/:hospitalId/suspend',
  requirePlatformPermission('platform:hospital:suspend'),
  validate({ params: hospitalIdParamSchema, body: suspendHospitalSchema }),
  handle(async (req, res) => {
    const { hospitalId } = req.params as { hospitalId: string }
    const { reason } = req.body as { reason: string }
    const data = await suspendHospital(actorOf(req), hospitalId, reason, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** POST /api/v1/platform/hospitals/:hospitalId/reactivate */
platformRouter.post(
  '/hospitals/:hospitalId/reactivate',
  requirePlatformPermission('platform:hospital:suspend'),
  validate({ params: hospitalIdParamSchema, body: reactivateHospitalSchema }),
  handle(async (req, res) => {
    const { hospitalId } = req.params as { hospitalId: string }
    const { note } = req.body as { note?: string }
    const data = await reactivateHospital(actorOf(req), hospitalId, note, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** PUT /api/v1/platform/hospitals/:hospitalId/plan — plan assignment only. */
platformRouter.put(
  '/hospitals/:hospitalId/plan',
  requirePlatformPermission('platform:plan:manage'),
  validate({ params: hospitalIdParamSchema, body: assignPlanSchema }),
  handle(async (req, res) => {
    const { hospitalId } = req.params as { hospitalId: string }
    const { plan, reason } = req.body as { plan: string; reason?: string }

    // Belt and braces: the Zod enum already restricts this, but the service takes a
    // `Plan` and a widening of the schema must never silently reach a non-plan value.
    if (!isPlan(plan)) {
      res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Unknown plan', requestId: req.requestId },
      })
      return
    }

    const data = await assignPlan(actorOf(req), hospitalId, plan, reason, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** PATCH /api/v1/platform/users/:userId/status — global account state. */
platformRouter.patch(
  '/users/:userId/status',
  requirePlatformPermission('platform:user:manage'),
  validate({ params: userIdParamSchema, body: changeUserStatusSchema }),
  handle(async (req, res) => {
    const { userId } = req.params as { userId: string }
    const { status, reason } = req.body as { status: 'ACTIVE' | 'SUSPENDED'; reason: string }
    const data = await changeUserStatus(actorOf(req), userId, status, reason, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/**
 * GET /api/v1/platform/audit — cursor-paginated, strictly validated, redacted on read.
 *
 * Reads the whole trail across tenants, which is the operator's job. It returns no
 * patient identifiers because none are ever written: `recordAudit` redacts at write
 * time, and the read path redacts again in defence in depth.
 */
platformRouter.get(
  '/audit',
  requirePlatformPermission('platform:audit:read'),
  validate({ query: auditListQuerySchema }),
  handle(async (req, res) => {
    const data = await listAuditEvents(actorOf(req), queryOf<AuditQuery>(req), metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** GET /api/v1/platform/reports/operational — aggregate counts only. */
platformRouter.get(
  '/reports/operational',
  requirePlatformPermission('platform:report:read'),
  validate({ query: platformReportQuerySchema }),
  handle(async (req, res) => {
    const { days } = queryOf<{ days: number }>(req)
    const data = await operationalReport(actorOf(req), days, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)
