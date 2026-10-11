import type { NextFunction, Request, Response } from 'express'

import { createTenantRouter } from '../../infrastructure/tenant-router.js'
import { requirePermission } from '../../middleware/auth.js'
import { validate } from '../../validation/validate.js'

import {
  createPatientSchema,
  duplicateCheckSchema,
  patientIdParamSchema,
  patientListQuerySchema,
  updatePatientSchema,
} from './patients.schemas.js'
import {
  findPossibleDuplicate,
  listPatients,
  readPatient,
  registerPatient,
  updatePatient,
  type PatientActor,
  type PatientMeta,
} from './patients.service.js'

/**
 * Patient routes.
 *
 * Tenant-scoped and permissioned by construction: `createTenantRouter` prepends
 * authentication and the tenant-scope check to every route registered here, so a route
 * cannot be added without them.
 *
 * There is no `hospitalId` in any path, query or body. The hospital is whatever the signed
 * session says it is — there is no identifier for a caller to tamper with because none is
 * accepted.
 *
 * Reading a patient requires `patient:read`; changing one requires `patient:write`. The
 * service additionally withholds contact details from a `patient:read`-only caller, so
 * the permission split controls disclosure as well as access.
 */

const { router: patientsRouter, route } = createTenantRouter()

function actorOf(req: Request): PatientActor {
  // `requireTenantScope` guarantees `hospitalId` is a string here, which the type cannot
  // express, hence the `unknown` hop.
  const auth = req.auth as unknown as {
    userId: string
    role: string
    hospitalId: string
    permissions: PatientActor['permissions']
  }
  return {
    userId: auth.userId,
    role: auth.role,
    hospitalId: auth.hospitalId,
    permissions: auth.permissions,
  }
}

function metaOf(req: Request): PatientMeta {
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

// ────────────────────────────── list and search ──────────────────────────────

route(
  'get',
  '/patients',
  requirePermission('patient:read'),
  validate({ query: patientListQuerySchema }),
  handle(async (req, res) => {
    const data = await listPatients(actorOf(req), queryOf(req), metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

// ────────────────────────────── registration ──────────────────────────────────

route(
  'post',
  '/patients',
  requirePermission('patient:write'),
  validate({ body: createPatientSchema }),
  handle(async (req, res) => {
    const data = await registerPatient(actorOf(req), req.body as never, metaOf(req))
    res.status(201).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/**
 * Possible duplicates for the values currently in the registration form.
 *
 * A WARNING endpoint, not a gate: the desk needs to be told "this looks like an existing
 * patient" while the person is still looking at the person in front of them, and the
 * decision to merge or create separately belongs to a human. Siblings genuinely share a
 * name and a birthday, and refusing to register the second child because the first exists
 * would be a far worse failure than a duplicate record someone can merge.
 *
 * Returns patient numbers and names only — never contact details, because this endpoint is
 * reached while typing a name and must not become a way to enumerate a register.
 */
route(
  'post',
  '/patients/duplicate-check',
  requirePermission('patient:write'),
  validate({ body: duplicateCheckSchema }),
  handle(async (req, res) => {
    const matches = await findPossibleDuplicate(req.body as never)
    res.status(200).json({
      success: true,
      data: { matches, exactMatches: matches.length },
      meta: { requestId: req.requestId },
    })
  }),
)

// ────────────────────────────── read and update ───────────────────────────────

route(
  'get',
  '/patients/:patientId',
  requirePermission('patient:read'),
  validate({ params: patientIdParamSchema }),
  handle(async (req, res) => {
    const { patientId } = req.params as { patientId: string }
    const data = await readPatient(actorOf(req), patientId, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

route(
  'patch',
  '/patients/:patientId',
  requirePermission('patient:write'),
  validate({ params: patientIdParamSchema, body: updatePatientSchema }),
  handle(async (req, res) => {
    const { patientId } = req.params as { patientId: string }
    const data = await updatePatient(actorOf(req), patientId, req.body as never, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

export { patientsRouter }