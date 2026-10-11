import { z } from 'zod'

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PLANS,
  ROLES,
  cursorQuerySchema,
  isoDateTimeSchema,
  objectIdSchema,
  pageQuerySchema,
  searchQuerySchema,
} from '@infinigrow/shared'

import { HOSPITAL_STATUSES, USER_STATUSES } from '../identity/models.js'

/**
 * Validation for the platform (SUPER_ADMIN) console.
 *
 * Everything here is `.strict()`, so an unexpected field is rejected rather than
 * silently dropped. On an operator console that matters twice over: a typo that names
 * the wrong field would otherwise appear to succeed while changing nothing, and a
 * request carrying `hospitalId` or `role` in the body would suggest the API trusts the
 * caller to declare its own scope. It never does — the tenant comes from the token.
 */

export const hospitalIdParamSchema = z.object({ hospitalId: objectIdSchema }).strict()

export const userIdParamSchema = z.object({ userId: objectIdSchema }).strict()

/**
 * The detail route takes no query parameters today.
 *
 * Declared explicitly, and `.strict()`, so that a stray parameter is rejected rather
 * than ignored. A silently-accepted filter that does nothing is worse than an error: it
 * tells the operator their view is filtered when it is not.
 */
export const hospitalDetailQuerySchema = z.object({}).strict()

/** `?status=PENDING&plan=HOSPITAL` — both optional, both validated against known values. */
export const hospitalListQuerySchema = z
  .object({
    ...pageQuerySchema.shape,
    ...searchQuerySchema.shape,
    status: z.enum(HOSPITAL_STATUSES).optional(),
    plan: z.enum(PLANS).optional(),
    sort: z.enum(['createdAt', 'name']).default('createdAt'),
  })
  .strict()

/**
 * The platform audit log is append-only and unbounded, so it is cursor-paginated
 * rather than offset-paginated. `skip`/`offset` would make the database walk every
 * skipped row, and rows inserted while an operator scrolls would shift the window and
 * silently duplicate or drop entries — unacceptable in an audit trail, where a gap
 * looks like tampering.
 */
export const auditListQuerySchema = z
  .object({
    ...cursorQuerySchema.shape,
    q: searchQuerySchema.shape.q,
    action: searchQuerySchema.shape.q,
    actorUserId: objectIdSchema.optional(),
    hospitalId: objectIdSchema.optional(),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict()

export const suspendHospitalSchema = z
  .object({
    /**
     * Why the tenant is being suspended.
     *
     * Required, not optional. A suspension with no recorded reason is indistinguishable
     * from a mistake, and the hospital — which can no longer reach its own data — has
     * no way to contest it. The reason is written to the audit trail.
     */
    reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500),
  })
  .strict()

export const reactivateHospitalSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
  })
  .strict()

export const assignPlanSchema = z
  .object({
    plan: z.enum(PLANS),
    /** Recorded alongside the change so an operator can see why a tier moved. */
    reason: z.string().trim().max(500).optional(),
  })
  .strict()

export const tenantUserListQuerySchema = z
  .object({
    ...pageQuerySchema.shape,
    ...searchQuerySchema.shape,
    role: z.enum(ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
  })
  .strict()

export const changeUserStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED']),
    reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500),
  })
  .strict()

export const platformReportQuerySchema = z
  .object({
    /** Inclusive lower bound; defaults to 30 days back. */
    days: z.coerce.number().int().min(1).max(365).default(30),
  })
  .strict()
