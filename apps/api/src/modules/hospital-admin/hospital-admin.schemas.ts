import { z } from 'zod'

import {
  HOSPITAL_ASSIGNABLE_ROLES,
  MAX_PAGE_SIZE,
  objectIdSchema,
  pageQuerySchema,
  searchQuerySchema,
} from '@infinigrow/shared'

/**
 * Hospital administration input validation.
 *
 * Every object is `.strict()`. On an administration form a silently-dropped field is
 * worse than a rejected one: the person fills in a code, presses save, sees success, and
 * the code was never stored.
 */

const trimmed = (max: number) => z.string().trim().max(max)

/**
 * A staff role.
 *
 * Validated as a plain string rather than `z.enum(HOSPITAL_ASSIGNABLE_ROLES)` so that the
 * rejection message comes from `assertAssignableRole` in the service, which explains
 * *why*: "that role cannot be assigned within a hospital. Platform roles are provisioned
 * separately." Zod's default would be "Invalid option: expected one of …", which tells a
 * hospital administrator nothing about the one role they actually tried to grant.
 */
const staffRole = z.string().trim().min(1, 'A role is required')

export const userIdParamSchema = z.object({ userId: objectIdSchema }).strict()

export const objectIdParamSchema = z.object({ departmentId: objectIdSchema }).strict()

export const profileIdParamSchema = z.object({ profileId: objectIdSchema }).strict()

/**
 * Department code.
 *
 * Upper-cased and restricted to letters, digits and a hyphen. Codes end up on printed
 * rosters, signage and claim forms, so an unconstrained string would eventually put a
 * quote or a slash into a printed schedule.
 */
const departmentCode = z
  .string()
  .trim()
  .min(2, 'Code must be at least 2 characters')
  .max(20)
  .regex(/^[A-Za-z0-9-]+$/, 'Use letters, digits and hyphens only')

// ────────────────────────────── hospital profile ──────────────────────────────

export const updateHospitalProfileSchema = z
  .object({
    name: trimmed(200).min(1, 'Hospital name is required').optional(),
    registrationNumber: trimmed(80).optional(),
    contactEmail: z.string().trim().toLowerCase().email().max(254).optional(),
    contactPhone: trimmed(20).optional(),
    address: z
      .object({
        line1: trimmed(200).optional(),
        line2: trimmed(200).optional(),
        city: trimmed(100).optional(),
        state: trimmed(100).optional(),
        postalCode: trimmed(20).optional(),
        country: trimmed(80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to update',
  })

/**
 * Clinical and operational settings.
 *
 * `appointmentBufferMinutes` is capped at 120. A hospital setting an hour-long buffer on
 * a five-minute clinic produces a schedule with no bookable slots at all, and it is
 * indistinguishable from a bug when someone reports "the system shows no availability".
 */
export const updateHospitalSettingsSchema = z
  .object({
    currency: trimmed(8).length(3, 'Use a three-letter code').optional(),
    timezone: trimmed(64).min(1).optional(),
    slotDurationMinutes: z.coerce.number().int().min(5).max(120).optional(),
    appointmentBufferMinutes: z.coerce.number().int().min(0).max(120).optional(),
    maxAppointmentAdvanceDays: z.coerce.number().int().min(1).max(365).optional(),
    invoicePrefix: trimmed(16).optional(),
    dateFormat: trimmed(32).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one setting to update',
  })

// ────────────────────────────── departments ──────────────────────────────

export const listDepartmentsQuerySchema = z
  .object({
    ...pageQuerySchema.shape,
    ...searchQuerySchema.shape,
    /** `true` or `false`; absent means both. */
    isActive: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict()

export const createDepartmentSchema = z
  .object({
    name: z.string().trim().min(1, 'Department name is required').max(120),
    code: departmentCode,
    description: trimmed(500).optional(),
    headUserId: objectIdSchema.optional(),
    isActive: z.coerce.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  })
  .strict()

export const updateDepartmentSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    code: departmentCode.optional(),
    description: trimmed(500).optional(),
    headUserId: objectIdSchema.nullable().optional(),
    isActive: z.coerce.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to update',
  })

// ────────────────────────────── doctors ──────────────────────────────

export const listDoctorsQuerySchema = z
  .object({
    ...pageQuerySchema.shape,
    ...searchQuerySchema.shape,
    departmentId: objectIdSchema.optional(),
    isAcceptingNewPatients: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict()

export const createDoctorProfileSchema = z
  .object({
    /**
     * The user the profile belongs to. Must already hold a `DOCTOR` membership in this
     * hospital — checked in the service, because it needs a database read.
     */
    userId: objectIdSchema,
    departmentId: objectIdSchema.optional(),
    registrationNumber: z
      .string()
      .trim()
      .min(3, 'Registration number is required')
      .max(60)
      .transform((value) => value.toUpperCase()),
    specialities: z.array(trimmed(80)).max(20).optional(),
    qualifications: z.array(trimmed(120)).max(20).optional(),
    yearsOfExperience: z.coerce.number().int().min(0).max(80).optional(),
    consultationFeeInPaise: z.coerce.number().int().min(0).max(10_000_000).optional(),
    bio: trimmed(2_000).optional(),
    isAcceptingNewPatients: z.coerce.boolean().optional(),
  })
  .strict()

export const updateDoctorProfileSchema = createDoctorProfileSchema
  .partial()
  .extend({ userId: objectIdSchema.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to update',
  })

// ────────────────────────────── schedules ──────────────────────────────

export const setScheduleSchema = z
  .object({
    blocks: z
      .array(
        z
          .object({
            weekday: z.coerce.number().int().min(0).max(6),
            startMinute: z.coerce.number().int().min(0).max(24 * 60 - 1),
            endMinute: z.coerce.number().int().min(1).max(24 * 60),
            slotDurationMinutes: z.coerce.number().int().min(5).max(120).optional(),
            isActive: z.coerce.boolean().optional(),
          })
          .strict()
          // Cross-field rule: a block ending at or before it starts would render as a
          // zero-length working day and silently produce no bookable slots.
          .refine((value) => value.endMinute > value.startMinute, {
            message: 'A working block must end after it starts',
            path: ['endMinute'],
          }),
      )
      .max(7, 'At most one block per weekday'),
  })
  .strict()

// ────────────────────────────── staff ──────────────────────────────

export const listStaffQuerySchema = z
  .object({
    ...pageQuerySchema.shape,
    ...searchQuerySchema.shape,
    role: z.enum(HOSPITAL_ASSIGNABLE_ROLES).optional(),
    membershipStatus: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']).optional(),
  })
  .strict()

/**
 * Create a staff account.
 *
 * `role` is drawn from `HOSPITAL_ASSIGNABLE_ROLES`, which excludes `SUPER_ADMIN` and
 * `PATIENT`. That exclusion is the whole defence against a hospital administrator
 * minting a platform operator, and it is a shared enum rather than an API-only check so
 * the client's role picker cannot offer a role the server would refuse.
 *
 * There is no `hospitalId` field. The tenant comes from the session, always. Accepting
 * one would let a crafted request target another hospital.
 */
export const createStaffSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    firstName: z.string().trim().min(1, 'First name is required').max(100),
    lastName: z.string().trim().min(1, 'Last name is required').max(100),
    phone: trimmed(20).optional(),
    role: staffRole,
    /** Optional explicit narrowing. Never widens the role's ceiling. */
    grantedPermissions: z.array(z.string().max(60)).max(40).optional(),
  })
  .strict()

export const updateStaffRoleSchema = z
  .object({
    role: staffRole,
    grantedPermissions: z.array(z.string().max(60)).max(40).optional(),
  })
  .strict()

export const setStaffStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED']),
    reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500),
  })
  .strict()

export { MAX_PAGE_SIZE }