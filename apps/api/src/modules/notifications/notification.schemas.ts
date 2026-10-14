import { z } from 'zod'

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  objectIdSchema,
  pageQuerySchema,
} from '@infinigrow/shared'

/**
 * Request validation for notifications.
 *
 * Everything is `.strict()`.
 *
 * ── The most important thing absent from this file ─────────────────────────────
 *
 * There is no `body`, `message`, `text`, `subject` or `content` field anywhere.
 *
 * That is the privacy control expressed as a schema. A request cannot carry message text,
 * so no amount of runtime cleverness can put clinical information into a message — the
 * templates are code, and this file is what makes that true at the boundary rather than
 * by good intentions further in.
 *
 * It also means a template can be swapped without touching any caller, which is the point
 * of having them at all.
 */

export const notificationListQuerySchema = z
  .object({
    ...pageQuerySchema.shape,
    status: z.enum(NOTIFICATION_STATUSES).optional(),
  })
  .strict()

export const notificationIdParamSchema = z.object({ notificationId: objectIdSchema }).strict()

export const recipientQuerySchema = z
  .object({
    recipientKind: z.enum(['PATIENT', 'USER']).default('PATIENT'),
  })
  .strict()

/**
 * Queue a message.
 *
 * `substitutions` is the five allowed values and nothing else. `.strict()` on the nested
 * object means a sixth key is a 422 rather than a silently dropped extra — otherwise the
 * first attempt to pass `diagnosis: '...'` would look like it worked.
 */
export const enqueueNotificationSchema = z
  .object({
    templateKey: z.string().trim().min(1).max(60),
    recipientKind: z.enum(['PATIENT', 'USER']),
    recipientRef: objectIdSchema,
    substitutions: z
      .object({
        recipientName: z.string().trim().max(100).optional(),
        dateLabel: z.string().trim().max(60).optional(),
        timeLabel: z.string().trim().max(40).optional(),
        departmentName: z.string().trim().max(120).optional(),
        locationName: z.string().trim().max(120).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const recordConsentSchema = z
  .object({
    recipientKind: z.enum(['PATIENT', 'USER']).default('PATIENT'),
    channel: z.enum(NOTIFICATION_CHANNELS),
    granted: z.boolean(),
    /** "who said so". Present because a disputed consent needs an answerable origin. */
    source: z.string().trim().max(40).optional(),
  })
  .strict()

export const updatePreferenceSchema = z
  .object({
    channel: z.enum(NOTIFICATION_CHANNELS),
    category: z.enum(NOTIFICATION_CATEGORIES),
    enabled: z.boolean(),
  })
  .strict()

export const sweepQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict()