import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { objectIdSchema } from '@infinigrow/shared'

import { createTenantRouter } from '../../infrastructure/tenant-router.js'
import { requirePermission } from '../../middleware/auth.js'
import { validate } from '../../validation/validate.js'

import {
  attendanceCorrectionSchema,
  attendanceDecisionSchema,
  attendanceListQuerySchema,
  myAttendanceQuerySchema,
} from './attendance.schemas.js'
import {
  checkIn,
  checkOut,
  decideCorrection,
  listAttendance,
  listMyAttendance,
  requestCorrection,
  type AttendanceActor,
  type Meta,
} from './attendance.service.js'

/**
 * Attendance routes.
 *
 * ── Self-service and team view are separate resources, on purpose ──────────────
 *
 * `/attendance/me` is available to anyone who can record their own attendance.
 * `/attendance` is the team view and demands `attendance:read:any`.
 *
 * One route with a `userId` filter would have meant a caller who omitted the filter got
 * their own records while believing they had the whole team's — a report that looks
 * authoritative and is quietly wrong about everyone but one person. Separate resources
 * put the scope in the URL, where it cannot be misread.
 *
 * ── Check-in takes no timestamp ────────────────────────────────────────────────
 *
 * `check-in` and `check-out` accept no body at all. The time comes from the server
 * clock. A client allowed to state its own arrival time could claim an eight-hour shift
 * by setting a device back, which would make the record worth nothing. The correction
 * workflow exists precisely for the cases where the server clock is not the truth, and
 * it requires a reason and a second person.
 */

const { router: attendanceRouter, route } = createTenantRouter({ module: 'ATTENDANCE' })

function actorOf(req: Request): AttendanceActor {
  const auth = req.auth as unknown as {
    userId: string
    role: string
    hospitalId: string
    permissions: AttendanceActor['permissions']
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

const recordParams = z.object({ attendanceId: objectIdSchema }).passthrough()
const decisionParams = z
  .object({
    attendanceId: objectIdSchema,
    decision: z.enum(['approve', 'reject']),
  })
  .passthrough()

route(
  'post',
  '/attendance/check-in',
  requirePermission('attendance:write'),
  handle(async (req, res) => {
    res.status(201).json({ data: await checkIn(actorOf(req), metaOf(req)) })
  }),
)

route(
  'post',
  '/attendance/check-out',
  requirePermission('attendance:write'),
  handle(async (req, res) => {
    res.json({ data: await checkOut(actorOf(req), metaOf(req)) })
  }),
)

route(
  'get',
  '/attendance/me',
  requirePermission('attendance:read'),
  validate({ query: myAttendanceQuerySchema }),
  handle(async (req, res) => {
    res.json({ data: await listMyAttendance(actorOf(req), metaOf(req), queryOf(req)) })
  }),
)

/**
 * The team view. Without `attendance:read:any` a caller gets 403 rather than their own
 * records substituted in — a refusal is safer than a plausible-looking wrong answer.
 */
route(
  'get',
  '/attendance',
  requirePermission('attendance:read:any'),
  validate({ query: attendanceListQuerySchema }),
  handle(async (req, res) => {
    res.json({ data: await listAttendance(actorOf(req), metaOf(req), queryOf(req)) })
  }),
)

/**
 * Request a correction. Does NOT change the record — that is the entire distinction, and
 * it is why this is a POST to a `correction-requests` resource rather than a PATCH on
 * the attendance record.
 */
route(
  'post',
  '/attendance/:attendanceId/correction-requests',
  requirePermission('attendance:write'),
  validate({ params: recordParams, body: attendanceCorrectionSchema }),
  handle(async (req, res) => {
    const data = await requestCorrection(
      actorOf(req),
      metaOf(req),
      paramOf(req, 'attendanceId'),
      bodyOf(req),
    )
    res.status(201).json({ data })
  }),
)

/**
 * Approve or reject a pending correction.
 *
 * The decision is an explicit path segment rather than a body field: accepting a
 * correction is a different kind of act from asking for one, and that difference should
 * be visible in the URL and in the audit log rather than buried in a JSON property.
 */
route(
  'post',
  '/attendance/:attendanceId/correction-requests/:decision/decision',
  requirePermission('attendance:approve'),
  validate({ params: decisionParams, body: attendanceDecisionSchema }),
  handle(async (req, res) => {
    const data = await decideCorrection(
      actorOf(req),
      metaOf(req),
      paramOf(req, 'attendanceId'),
      paramOf(req, 'decision') === 'reject' ? 'REJECTED' : 'APPROVED',
      bodyOf(req),
    )
    res.json({ data })
  }),
)

export { attendanceRouter }