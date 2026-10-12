import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { objectIdSchema } from '@infinigrow/shared'

import { createTenantRouter } from '../../infrastructure/tenant-router.js'
import { requirePermission } from '../../middleware/auth.js'
import { validate } from '../../validation/validate.js'

import {
  consultationListQuerySchema,
  consultationQueueQuerySchema,
  createConsultationSchema,
  createPrescriptionSchema,
  finalizeConsultationSchema,
  finalizePrescriptionSchema,
  updateConsultationSchema,
} from './clinical.schemas.js'
import {
  createConsultation,
  createPrescription,
  downloadPrescriptionDocument,
  finalizeConsultation,
  finalizePrescription,
  listConsultations,
  readConsultation,
  readPatientSummary,
  readPrescription,
  readQueue,
  updateConsultation,
  type ClinicalActor,
  type Meta,
} from './clinical.service.js'

/**
 * Clinical routes.
 *
 * Every route is authenticated and tenant-scoped by the registrar before its handler
 * runs, so no route here can be added without that boundary. A SUPER_ADMIN is refused by
 * `requireTenantScope` itself: the platform operator holds `platform:*` permissions and no
 * hospital, so there is no hospital a clinical record could belong to. Clinical data is
 * unreachable from the platform console by construction, not by a check someone might
 * forget to repeat.
 *
 * ── Permission split ─────────────────────────────────────────────────────────
 *
 * `consultation:read` / `consultation:write` mean "my own records".
 * `consultation:read:any` / `consultation:write:any` mean every clinician's in this
 * hospital. A doctor does not hold `:any` by default: notes are written by a named person
 * about a person they actually saw, and opening them to every colleague by default would
 * make the attribution on the record decorative.
 *
 * The service enforces the scoping on every query and on every target row. The guards
 * here decide only what the interface offers — the server is the boundary either way.
 */

const { router: clinicalRouter, route } = createTenantRouter()

function actorOf(req: Request): ClinicalActor {
  const auth = req.auth as unknown as {
    userId: string
    role: string
    hospitalId: string
    permissions: ClinicalActor['permissions']
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

function queryOf<T>(req: Request): T {
  return (req as Request & { validatedQuery?: T }).validatedQuery ?? ({} as T)
}

/**
 * `validate()` replaces `req.body` in place rather than writing a side channel — unlike
 * the query, which Express 5 makes a getter. Reading `req.body` here is therefore correct
 * and reading a `validatedBody` property would silently be `undefined`.
 */
function bodyOf<T>(req: Request): T {
  return req.body as T
}

function paramOf(req: Request, key: string): string {
  return String(req.params[key] ?? '')
}

const consultationIdParams = z
  .object({ consultationId: objectIdSchema })
  .passthrough()
const prescriptionIdParams = z.object({ prescriptionId: objectIdSchema }).passthrough()
const patientIdParams = z.object({ patientId: objectIdSchema }).passthrough()

route(
  'get',
  '/consultations',
  requirePermission('consultation:read'),
  validate({ query: consultationListQuerySchema }),
  handle(async (req, res) => {
    const data = await listConsultations(actorOf(req), metaOf(req), queryOf(req))
    res.json({ data })
  }),
)

/**
 * The clinician's queue.
 *
 * Registered before `/consultations/:consultationId` so that "queue" is never matched as
 * an id. Express matches in registration order, and a param route above this one would
 * swallow it.
 */
route(
  'get',
  '/consultations/queue',
  requirePermission('consultation:read'),
  validate({ query: consultationQueueQuerySchema }),
  handle(async (req, res) => {
    const data = await readQueue(actorOf(req), metaOf(req), queryOf<{ date: string }>(req))
    res.json({ data })
  }),
)

route(
  'post',
  '/consultations',
  requirePermission('consultation:write'),
  validate({ body: createConsultationSchema }),
  handle(async (req, res) => {
    const data = await createConsultation(actorOf(req), metaOf(req), bodyOf(req))
    res.status(201).json({ data })
  }),
)

route(
  'get',
  '/consultations/:consultationId',
  requirePermission('consultation:read'),
  validate({ params: consultationIdParams }),
  handle(async (req, res) => {
    const data = await readConsultation(actorOf(req), metaOf(req), paramOf(req, 'consultationId'))
    res.json({ data })
  }),
)

/**
 * Edit a consultation.
 *
 * One route for both cases: a draft is the clinician's own scratch work and edits in
 * place; a finalized record requires `amendmentReason` and appends an immutable
 * amendment. Splitting them into two URLs would invite a caller to reach for the
 * "edit" verb on a signed record and be surprised.
 */
route(
  'patch',
  '/consultations/:consultationId',
  requirePermission('consultation:write'),
  validate({ params: consultationIdParams, body: updateConsultationSchema }),
  handle(async (req, res) => {
    const data = await updateConsultation(
      actorOf(req),
      metaOf(req),
      paramOf(req, 'consultationId'),
      bodyOf(req),
    )
    res.json({ data })
  }),
)

/**
 * Seal a consultation. One-way — there is deliberately no "un-finalize".
 */
route(
  'post',
  '/consultations/:consultationId/finalize',
  requirePermission('consultation:write'),
  validate({ params: consultationIdParams, body: finalizeConsultationSchema }),
  handle(async (req, res) => {
    const data = await finalizeConsultation(actorOf(req), metaOf(req), paramOf(req, 'consultationId'))
    res.json({ data })
  }),
)

/**
 * A patient's clinical summary.
 *
 * On the patient, not on the consultation: "show me this patient's history" is a
 * question about a person. Putting it under the consultation resource would tempt an
 * implementation to answer it by scanning every consultation in the hospital, instead of
 * asking the service to scope it to what this caller is entitled to see.
 */
route(
  'get',
  '/patients/:patientId/clinical-summary',
  requirePermission('consultation:read'),
  validate({ params: patientIdParams }),
  handle(async (req, res) => {
    const data = await readPatientSummary(actorOf(req), metaOf(req), paramOf(req, 'patientId'))
    res.json({ data })
  }),
)

route(
  'post',
  '/prescriptions',
  requirePermission('prescription:write'),
  validate({ body: createPrescriptionSchema }),
  handle(async (req, res) => {
    const data = await createPrescription(actorOf(req), metaOf(req), bodyOf(req))
    res.status(201).json({ data })
  }),
)

route(
  'get',
  '/prescriptions/:prescriptionId',
  requirePermission('prescription:read'),
  validate({ params: prescriptionIdParams }),
  handle(async (req, res) => {
    const data = await readPrescription(actorOf(req), metaOf(req), paramOf(req, 'prescriptionId'))
    res.json({ data })
  }),
)

/**
 * Issue a prescription: seal it and generate its printable document.
 */
route(
  'post',
  '/prescriptions/:prescriptionId/issue',
  requirePermission('prescription:write'),
  validate({ params: prescriptionIdParams, body: finalizePrescriptionSchema }),
  handle(async (req, res) => {
    const data = await finalizePrescription(actorOf(req), metaOf(req), paramOf(req, 'prescriptionId'))
    res.json({ data })
  }),
)

/**
 * Download a generated prescription.
 *
 * The ONLY route through which those bytes leave the system, and the service re-checks
 * permission on the underlying prescription before returning them. Nothing here hands
 * out a URL or a storage key — a URL is a capability that outlives the authorization
 * decision which produced it.
 *
 * `private, no-store` and `nosniff` are load-bearing. A prescription must not linger in
 * a shared proxy cache or on disk in a browser where the next person at that machine
 * could read it, and it must not be rendered inline as something the browser might sniff
 * into a different content type.
 */
route(
  'get',
  '/prescriptions/:prescriptionId/document',
  requirePermission('prescription:read'),
  validate({ params: prescriptionIdParams }),
  handle(async (req, res) => {
    const { fileName, bytes } = await downloadPrescriptionDocument(
      actorOf(req),
      metaOf(req),
      paramOf(req, 'prescriptionId'),
    )

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', String(bytes.byteLength))
    res.setHeader('Cache-Control', 'private, no-store, max-age=0')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    res.status(200).end(Buffer.from(bytes))
  }),
)

export { clinicalRouter }