import type { NextFunction, Request, Response } from 'express'
import type { NotificationChannel, NotificationStatus } from '@infinigrow/shared'

import { requirePermission } from '../../middleware/auth.js'
import { createTenantRouter } from '../../infrastructure/tenant-router.js'
import { validate } from '../../validation/validate.js'

import {
  enqueueNotificationSchema,
  notificationIdParamSchema,
  notificationListQuerySchema,
  recordConsentSchema,
  recipientQuerySchema,
  updatePreferenceSchema,
} from './notification.schemas.js'
import {
  enqueueNotification,
  listNotifications,
  readConsents,
  readMyPreferences,
  readNotification,
  recordConsent,
  retryNotification,
  updateMyPreference,
  type Meta,
  type NotificationActor,
} from './notification.service.js'
import { allTemplates } from './notification.templates.js'

/**
 * Tenant notification routes.
 *
 * Built on the registrar, so every route here is authenticated, tenant-scoped and behind
 * the subscription's `CLINICAL` entitlement without any route having to remember. A
 * hospital on a plan without the module cannot send a patient an appointment reminder.
 *
 * **`202 Accepted`, not `201 Created`.** A queued notification is not a sent one, and a
 * `201` with a message body in the response invites the caller to display "sent" to
 * somebody. The response says `queued`, and the row says `PENDING`.
 */

const { router, route } = createTenantRouter({ module: 'CLINICAL' })

function actorOf(req: Request): NotificationActor {
  const auth = req.auth as unknown as {
    userId: string
    role: string
    hospitalId: string
    permissions: string[]
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

function bodyOf<T>(req: Request): T {
  return req.body as T
}

function queryOf<T>(req: Request): T {
  return (req as Request & { validatedQuery?: T }).validatedQuery ?? ({} as T)
}

/** GET /api/v1/notifications — the delivery log. */
route(
  'get',
  '/notifications',
  requirePermission('notification:read'),
  validate({ query: notificationListQuerySchema }),
  handle(async (req, res) => {
    const data = await listNotifications(
      actorOf(req),
      metaOf(req),
      queryOf<{ page?: number; pageSize?: number; status?: NotificationStatus }>(req),
    )
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/**
 * GET /api/v1/notifications/templates — every template, for the preview screen.
 *
 * Served before `/:notificationId` in the route table so `templates` is matched as a
 * literal rather than swallowed by the `:notificationId` pattern — which would fail
 * ObjectId validation and return a confusing 422.
 */
route(
  'get',
  '/notifications/templates',
  requirePermission('notification:read'),
  handle(async (req, res) => {
    res.status(200).json({
      success: true,
      data: { items: allTemplates() },
      meta: { requestId: req.requestId },
    })
  }),
)

/** GET /api/v1/notifications/preferences — my own channel/category choices. */
route(
  'get',
  '/notifications/preferences',
  requirePermission('notification:read'),
  handle(async (req, res) => {
    const data = await readMyPreferences(actorOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** PUT /api/v1/notifications/preferences — opt out of one category, keep the others. */
route(
  'put',
  '/notifications/preferences',
  requirePermission('notification:read'),
  validate({ body: updatePreferenceSchema }),
  handle(async (req, res) => {
    const data = await updateMyPreference(actorOf(req), bodyOf(req))
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/** GET /api/v1/notifications/:notificationId — one, with its attempt log. */
route(
  'get',
  '/notifications/:notificationId',
  requirePermission('notification:read'),
  validate({ params: notificationIdParamSchema }),
  handle(async (req, res) => {
    const { notificationId } = req.params as { notificationId: string }
    const data = await readNotification(actorOf(req), notificationId)
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/**
 * POST /api/v1/notifications — queue a message.
 *
 * `202 Accepted` with `queued: true` and the stored status. The status may already be
 * `SUPPRESSED`, because consent and preference are checked before the row is written and a
 * refusal is recorded rather than thrown away.
 */
route(
  'post',
  '/notifications',
  // `patient:read` as well as `notification:send`. Messaging a patient requires knowing
  // they exist; the ability to send is not itself the ability to address anyone.
  requirePermission('notification:send', 'patient:read'),
  validate({ body: enqueueNotificationSchema }),
  handle(async (req, res) => {
    const data = await enqueueNotification(actorOf(req), metaOf(req), bodyOf(req))
    res.status(202).json({
      success: true,
      data: { queued: true, notification: data },
      meta: { requestId: req.requestId },
    })
  }),
)

/** POST /api/v1/notifications/:notificationId/retry — manual retry of a failed message. */
route(
  'post',
  '/notifications/:notificationId/retry',
  requirePermission('notification:send'),
  validate({ params: notificationIdParamSchema }),
  handle(async (req, res) => {
    const { notificationId } = req.params as { notificationId: string }
    const data = await retryNotification(actorOf(req), metaOf(req), notificationId)
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

/**
 * Consent, addressed by recipient rather than by path.
 *
 * A path like `/patients/:id/consents` would be more RESTful and would mean the consent
 * routes live on the patients router, where they could be reached by a caller with
 * `patient:write` but no `notification:send`. Keeping them here means the permission pair
 * is stated in one place and cannot drift apart.
 */
route(
  'get',
  '/notifications/consents',
  requirePermission('notification:read', 'patient:read'),
  validate({ query: recipientQuerySchema }),
  handle(async (req, res) => {
    const { recipientKind } = queryOf<{ recipientKind: 'PATIENT' | 'USER' }>(req)
    const { recipientRef } = req.query as { recipientRef?: string }
    const data = await readConsents(
      actorOf(req),
      recipientKind ?? 'PATIENT',
      String(recipientRef ?? ''),
    )
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

route(
  'post',
  '/notifications/consents',
  requirePermission('notification:send', 'patient:read'),
  validate({ body: recordConsentSchema }),
  handle(async (req, res) => {
    const { recipientKind, channel, granted, source } = bodyOf<{
      recipientKind: 'PATIENT' | 'USER'
      channel: NotificationChannel
      granted: boolean
      source?: string
    }>(req)
    const { recipientRef } = req.query as { recipientRef?: string }
    const data = await recordConsent(actorOf(req), metaOf(req), {
      recipientKind,
      recipientRef: String(recipientRef ?? ''),
      channel,
      granted,
      source,
    })
    res.status(200).json({ success: true, data, meta: { requestId: req.requestId } })
  }),
)

export { router as notificationsRouter }