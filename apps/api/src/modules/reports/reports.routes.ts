import type { NextFunction, Request, Response } from 'express'

import { createTenantRouter } from '../../infrastructure/tenant-router.js'
import { requirePermission } from '../../middleware/auth.js'
import { validate } from '../../validation/validate.js'

import {
  appointmentReportQuerySchema,
  attendanceReportQuerySchema,
  revenueQuerySchema,
} from '../billing/billing.schemas.js'
import {
  appointmentCsv,
  appointmentReport,
  attendanceCsv,
  attendanceReport,
  csvResponse,
  revenueCsv,
  revenueReport,
  type ReportActor,
} from './reports.service.js'

/**
 * Report routes.
 *
 * Two permission tiers, deliberately:
 *
 * - **`report:financial`** for revenue. A doctor holds `report:read` but not this, and must
 *   not be able to derive a hospital's turnover from operational data and arithmetic.
 * - **`report:read`** for appointments and attendance. Those are operational facts about
 *   time, not about money, and a doctor has a legitimate need for them.
 *
 * Every export is audited. An export is the easiest way to take data out of the system in
 * bulk, so "someone exported the revenue report" is an event worth being able to answer.
 */
const { router: reportsRouter, route } = createTenantRouter({ module: 'REPORTS' })

function actorOf(req: Request): ReportActor {
  const auth = req.auth as unknown as ReportActor
  return {
    userId: auth.userId,
    role: auth.role,
    hospitalId: auth.hospitalId,
    permissions: auth.permissions,
  }
}

function metaOf(req: Request): { ip: string; requestId: string } {
  return { ip: req.ip ?? '', requestId: req.requestId }
}

function queryOf<T>(req: Request): T {
  return (req as Request & { validatedQuery?: T }).validatedQuery ?? ({} as T)
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }
}

route(
  'get',
  '/reports/revenue',
  requirePermission('report:financial'),
  validate({ query: revenueQuerySchema }),
  handle(async (req, res) => {
    res.json({ data: await revenueReport(actorOf(req), metaOf(req), queryOf(req)) })
  }),
)

route(
  'get',
  '/reports/revenue.csv',
  requirePermission('report:financial'),
  validate({ query: revenueQuerySchema }),
  handle(async (req, res) => {
    const { fileName, body } = await revenueCsv(actorOf(req), metaOf(req), queryOf(req))
    csvResponse(res, fileName, body)
  }),
)

route(
  'get',
  '/reports/appointments',
  requirePermission('report:read'),
  validate({ query: appointmentReportQuerySchema }),
  handle(async (req, res) => {
    res.json({ data: await appointmentReport(actorOf(req), metaOf(req), queryOf(req)) })
  }),
)

route(
  'get',
  '/reports/appointments.csv',
  requirePermission('report:read'),
  validate({ query: appointmentReportQuerySchema }),
  handle(async (req, res) => {
    const { fileName, body } = await appointmentCsv(actorOf(req), metaOf(req), queryOf(req))
    csvResponse(res, fileName, body)
  }),
)

route(
  'get',
  '/reports/attendance',
  requirePermission('report:read'),
  validate({ query: attendanceReportQuerySchema }),
  handle(async (req, res) => {
    res.json({ data: await attendanceReport(actorOf(req), metaOf(req), queryOf(req)) })
  }),
)

route(
  'get',
  '/reports/attendance.csv',
  requirePermission('report:read'),
  validate({ query: attendanceReportQuerySchema }),
  handle(async (req, res) => {
    const { fileName, body } = await attendanceCsv(actorOf(req), metaOf(req), queryOf(req))
    csvResponse(res, fileName, body)
  }),
)

export { reportsRouter }