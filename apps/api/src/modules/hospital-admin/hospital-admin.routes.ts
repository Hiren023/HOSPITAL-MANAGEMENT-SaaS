import { type NextFunction, type Request, type Response } from 'express'
import type { Permission } from '@infinigrow/shared'

import { createTenantRouter } from '../../infrastructure/tenant-router.js'
import { requirePermission } from '../../middleware/auth.js'
import { validate } from '../../validation/validate.js'
import {
  createDepartmentSchema,
  createDoctorProfileSchema,
  createStaffSchema,
  listDepartmentsQuerySchema,
  listDoctorsQuerySchema,
  listStaffQuerySchema,
  objectIdParamSchema,
  profileIdParamSchema,
  setScheduleSchema,
  setStaffStatusSchema,
  updateDepartmentSchema,
  updateDoctorProfileSchema,
  updateHospitalProfileSchema,
  updateHospitalSettingsSchema,
  updateStaffRoleSchema,
  userIdParamSchema,
} from './hospital-admin.schemas.js'
import {
  changeStaffRole,
  createDepartment,
  createDoctorProfile,
  createStaffAccount,
  listDepartments,
  listDoctors,
  listStaff,
  readDepartment,
  readDoctor,
  readHospitalProfile,
  readSchedule,
  replaceSchedule,
  setStaffStatus,
  updateDepartment,
  updateDoctorProfile,
  updateHospitalProfile,
  updateHospitalSettings,
  type Actor,
  type Meta,
} from './hospital-admin.service.js'

/**
 * Hospital administration — tenant-scoped.
 *
 * `requireTenantScope` is applied router-wide, once. Every route below therefore runs
 * inside an established tenant context, and the isolation plugin adds `hospitalId` to
 * every query on a scoped collection. A route cannot opt out by forgetting a line — the
 * boundary is above it, not beside it.
 *
 * There is no `hospitalId` in any path, query or body on this router. The hospital is
 * whatever the signed session says it is. That is the whole design: there is no
 * identifier for a caller to tamper with because none is accepted.
 *
 * Each route additionally requires its specific permission, so a doctor holding
 * `schedule:write` cannot create a department.
 */
// The router is created by the shared factory, which guarantees every route is
// authenticated and tenant-scoped before it runs. See `infrastructure/tenant-router.ts`
// for why this is a registrar rather than `router.use()` — the short version is that
// `router.use` at the API root leaks the boundary onto every unmatched path.
const { router: hospitalAdminRouter, route: tenantRoute } = createTenantRouter({ module: 'CLINICAL' })


export { hospitalAdminRouter }

function actorOf(req: Request): Actor {
  // `requireTenantScope` above guarantees `hospitalId` is a string here, which the
  // cast cannot express, hence the `unknown` hop.
  const auth = req.auth as unknown as {
    userId: string
    role: string
    hospitalId: string
    permissions: Permission[]
  }
  return {
    userId: auth.userId,
    role: auth.role,
    hospitalId: auth.hospitalId,
    permissions: auth.permissions,
  }
}

function metaOf(req: Request): Meta {
  return { ip: req.ip ?? '', requestId: req.requestId }
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }
}

/** Express 5 makes `req.query` getter-only; `validate` stores the parsed value here. */
function queryOf<T>(req: Request): T {
  return (req as Request & { validatedQuery?: T }).validatedQuery ?? ({} as T)
}

// ────────────────────────────── hospital profile ──────────────────────────────

tenantRoute('get', 
  '/hospital',
  requirePermission('hospital:read'),
  handle(async (req, res) => {
    const data = await readHospitalProfile(actorOf(req), metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('patch', 
  '/hospital',
  requirePermission('hospital:write'),
  validate({ body: updateHospitalProfileSchema }),
  handle(async (req, res) => {
    const data = await updateHospitalProfile(actorOf(req), req.body as never, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('patch', 
  '/hospital/settings',
  requirePermission('hospital:settings:manage'),
  validate({ body: updateHospitalSettingsSchema }),
  handle(async (req, res) => {
    const data = await updateHospitalSettings(actorOf(req), req.body as never, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

// ────────────────────────────── departments ──────────────────────────────

tenantRoute('get', 
  '/departments',
  requirePermission('department:read'),
  validate({ query: listDepartmentsQuerySchema }),
  handle(async (req, res) => {
    const data = await listDepartments(actorOf(req), queryOf(req), metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('post', 
  '/departments',
  requirePermission('department:write'),
  validate({ body: createDepartmentSchema }),
  handle(async (req, res) => {
    const data = await createDepartment(actorOf(req), req.body as never, metaOf(req))
    res.status(201).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('get', 
  '/departments/:departmentId',
  requirePermission('department:read'),
  validate({ params: objectIdParamSchema }),
  handle(async (req, res) => {
    const { departmentId } = req.params as { departmentId: string }
    const data = await readDepartment(actorOf(req), departmentId)
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('patch', 
  '/departments/:departmentId',
  requirePermission('department:write'),
  validate({ params: objectIdParamSchema, body: updateDepartmentSchema }),
  handle(async (req, res) => {
    const { departmentId } = req.params as { departmentId: string }
    const data = await updateDepartment(actorOf(req), departmentId, req.body as never, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

// ────────────────────────────── doctors ──────────────────────────────

tenantRoute('get', 
  '/doctors',
  requirePermission('doctor:read'),
  validate({ query: listDoctorsQuerySchema }),
  handle(async (req, res) => {
    const data = await listDoctors(actorOf(req), queryOf(req), metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('post', 
  '/doctors',
  requirePermission('doctor:write'),
  validate({ body: createDoctorProfileSchema }),
  handle(async (req, res) => {
    const data = await createDoctorProfile(actorOf(req), req.body as never, metaOf(req))
    res.status(201).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('get', 
  '/doctors/:profileId',
  requirePermission('doctor:read'),
  validate({ params: profileIdParamSchema }),
  handle(async (req, res) => {
    const { profileId } = req.params as { profileId: string }
    const data = await readDoctor(actorOf(req), profileId)
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('patch', 
  '/doctors/:profileId',
  requirePermission('doctor:write'),
  validate({ params: profileIdParamSchema, body: updateDoctorProfileSchema }),
  handle(async (req, res) => {
    const { profileId } = req.params as { profileId: string }
    const data = await updateDoctorProfile(actorOf(req), profileId, req.body as never, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('get', 
  '/doctors/:profileId/schedule',
  requirePermission('schedule:read'),
  validate({ params: profileIdParamSchema }),
  handle(async (req, res) => {
    const { profileId } = req.params as { profileId: string }
    const data = await readSchedule(actorOf(req), profileId)
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('put', 
  '/doctors/:profileId/schedule',
  requirePermission('schedule:write'),
  validate({ params: profileIdParamSchema, body: setScheduleSchema }),
  handle(async (req, res) => {
    const { profileId } = req.params as { profileId: string }
    const { blocks } = req.body as { blocks: Record<string, unknown>[] }
    const data = await replaceSchedule(actorOf(req), profileId, blocks, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

// ────────────────────────────── staff ──────────────────────────────

tenantRoute('get', 
  '/staff',
  requirePermission('user:read'),
  validate({ query: listStaffQuerySchema }),
  handle(async (req, res) => {
    const data = await listStaff(actorOf(req), queryOf(req), metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('post', 
  '/staff',
  requirePermission('user:write'),
  validate({ body: createStaffSchema }),
  handle(async (req, res) => {
    const data = await createStaffAccount(actorOf(req), req.body as never, metaOf(req))
    res.status(201).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('patch', 
  '/staff/:userId/role',
  requirePermission('user:permissions:manage'),
  validate({ params: userIdParamSchema, body: updateStaffRoleSchema }),
  handle(async (req, res) => {
    const { userId } = req.params as { userId: string }
    const { role, grantedPermissions } = req.body as {
      role: string
      grantedPermissions?: string[]
    }
    const data = await changeStaffRole(
      actorOf(req),
      userId,
      role,
      grantedPermissions,
      metaOf(req),
    )
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

tenantRoute('patch', 
  '/staff/:userId/status',
  requirePermission('user:permissions:manage'),
  validate({ params: userIdParamSchema, body: setStaffStatusSchema }),
  handle(async (req, res) => {
    const { userId } = req.params as { userId: string }
    const { status, reason } = req.body as { status: 'ACTIVE' | 'SUSPENDED'; reason: string }
    const data = await setStaffStatus(actorOf(req), userId, status, reason, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)
