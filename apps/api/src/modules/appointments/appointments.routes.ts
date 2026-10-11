import type { NextFunction, Request, Response } from 'express'

import { createTenantRouter } from '../../infrastructure/tenant-router.js'
import { requirePermission } from '../../middleware/auth.js'
import { validate } from '../../validation/validate.js'

import {
  appointmentDayQuerySchema,
  appointmentIdParamSchema,
  appointmentListQuerySchema,
  availabilityQuerySchema,
  cancelAppointmentSchema,
  createAppointmentSchema,
  rescheduleAppointmentSchema,
  updateWorkingHoursSchema,
} from './appointments.schemas.js'
import {
  bookAppointment,
  cancelAppointment,
  listAppointments,
  listAppointmentsForDay,
  listAvailability,
  readAppointment,
  rescheduleAppointment,
  updateWorkingHours,
  type AppointmentActor,
  type Meta,
} from './appointments.service.js'

/**
 * Appointment routes.
 *
 * ── The permission split, and why there are `:any` variants ────────────────────
 *
 * `appointment:read` / `appointment:write` mean "my own appointments". `appointment:read:any`
 * / `appointment:write:any` mean "the whole clinic". Reception and administration hold the
 * `:any` pair because booking on behalf of other doctors is their job; a doctor does not,
 * which is how a doctor's schedule stays theirs without the service branching on a role
 * name.
 *
 * The service enforces the self-scoping on every query and on every target row. The guards
 * here decide only what the interface offers — the server is the boundary either way.
 *
 * ── Consequential actions ──────────────────────────────────────────────────────
 *
 * Cancelling frees a patient's slot and is recorded in the appointment's status history,
 * so it takes a mandatory written reason. Rescheduling likewise. Neither is "delete", and
 * neither is treated as though it were.
 */

const { router: appointmentsRouter, route } = createTenantRouter()

function actorOf(req: Request): AppointmentActor {
  const auth = req.auth as unknown as {
    userId: string
    role: string
    hospitalId: string
    permissions: AppointmentActor['permissions']
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

// ────────────────────────────── scheduling views ──────────────────────────────

route(
  'get',
  '/appointments/day',
  requirePermission('appointment:read'),
  validate({ query: appointmentDayQuerySchema }),
  handle(async (req, res) => {
    const data = await listAppointmentsForDay(actorOf(req), queryOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

route(
  'get',
  '/appointments/availability',
  requirePermission('appointment:read'),
  validate({ query: availabilityQuerySchema }),
  handle(async (req, res) => {
    const data = await listAvailability(actorOf(req), queryOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

route(
  'get',
  '/appointments',
  requirePermission('appointment:read'),
  validate({ query: appointmentListQuerySchema }),
  handle(async (req, res) => {
    const data = await listAppointments(actorOf(req), queryOf(req), metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

// ────────────────────────────── booking ────────────────────────────────────────

route(
  'post',
  '/appointments',
  requirePermission('appointment:write'),
  validate({ body: createAppointmentSchema }),
  handle(async (req, res) => {
    const data = await bookAppointment(actorOf(req), req.body as never, metaOf(req))
    res.status(201).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

route(
  'get',
  '/appointments/:appointmentId',
  requirePermission('appointment:read'),
  validate({ params: appointmentIdParamSchema }),
  handle(async (req, res) => {
    const { appointmentId } = req.params as { appointmentId: string }
    const data = await readAppointment(actorOf(req), appointmentId, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

route(
  'patch',
  '/appointments/:appointmentId/reschedule',
  requirePermission('appointment:write'),
  validate({ params: appointmentIdParamSchema, body: rescheduleAppointmentSchema }),
  handle(async (req, res) => {
    const { appointmentId } = req.params as { appointmentId: string }
    const data = await rescheduleAppointment(actorOf(req), appointmentId, req.body as never, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/**
 * Cancel, freeing the slot.
 *
 * Deliberately not `DELETE`. Cancelling is not removal: the appointment stays, its status
 * history keeps every transition, and the slot is released so someone else can book it.
 * A `DELETE` here would imply a record that should not exist, which is a different and
 * clinically meaningless operation.
 */
route(
  'post',
  '/appointments/:appointmentId/cancel',
  requirePermission('appointment:write'),
  validate({ params: appointmentIdParamSchema, body: cancelAppointmentSchema }),
  handle(async (req, res) => {
    const { appointmentId } = req.params as { appointmentId: string }
    const { reason } = req.body as { reason: string }
    const data = await cancelAppointment(actorOf(req), appointmentId, reason, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

// ────────────────────────────── hospital configuration ────────────────────────

/**
 * Opening hours.
 *
 * `hospital:settings:manage`, the same permission as the rest of the hospital's
 * configuration — these are opening hours, and they belong with the other settings rather
 * than in the scheduling module where they would look like a doctor's preference.
 */
route(
  'patch',
  '/appointments/working-hours',
  requirePermission('hospital:settings:manage'),
  validate({ body: updateWorkingHoursSchema }),
  handle(async (req, res) => {
    const data = await updateWorkingHours(actorOf(req), req.body as never, metaOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

export { appointmentsRouter }