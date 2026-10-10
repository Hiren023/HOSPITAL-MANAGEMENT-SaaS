import { z } from 'zod'

import { emailSchema, objectIdSchema, passwordSchema } from '@infinigrow/shared'

/**
 * Request schemas for the authentication endpoints.
 *
 * Every schema is `.strict()`: an unexpected key is rejected rather than ignored.
 * That is what stops a client smuggling `role: "SUPER_ADMIN"` or `hospitalId` into a
 * sign-in payload (docs/SECURITY.md R10).
 */

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(200),
    /** Optional: selects a membership when the user belongs to several hospitals. */
    hospitalId: objectIdSchema.optional(),
  })
  .strict()

export const refreshSchema = z.object({}).strict()

export const forgotPasswordSchema = z
  .object({
    email: emailSchema,
  })
  .strict()

export const resetPasswordSchema = z
  .object({
    email: emailSchema,
    /** Digits only after normalisation; length is checked post-normalisation. */
    code: z
      .string()
      .min(1)
      .max(20)
      .transform((value) => value.replace(/\D/g, ''))
      .refine((value) => value.length === 6, 'Code must be exactly 6 digits'),
    newPassword: passwordSchema,
    confirmPassword: z.string().max(200).optional(),
  })
  .strict()
  .refine((value) => !value.confirmPassword || value.confirmPassword === value.newPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

export const verifyEmailSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(20)
      .transform((value) => value.replace(/\D/g, ''))
      .refine((value) => value.length === 6, 'Code must be exactly 6 digits'),
  })
  .strict()

export const hospitalRegistrationSchema = z
  .object({
    hospitalName: z.string().trim().min(2).max(200),
    registrationNumber: z.string().trim().max(80).optional(),
    contactEmail: emailSchema,
    contactPhone: z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9\s-]{7,17}$/, 'Must be a valid phone number')
      .optional(),

    address: z
      .object({
        line1: z.string().trim().max(200).optional(),
        line2: z.string().trim().max(200).optional(),
        city: z.string().trim().max(100).optional(),
        state: z.string().trim().max(100).optional(),
        postalCode: z.string().trim().max(20).optional(),
        country: z.string().trim().max(80).optional(),
      })
      .strict()
      .optional(),

    /** Administrator who will own this tenant. */
    admin: z
      .object({
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
        email: emailSchema,
        phone: z
          .string()
          .trim()
          .regex(/^\+?[0-9][0-9\s-]{7,17}$/, 'Must be a valid phone number')
          .optional(),
        password: passwordSchema,
      })
      .strict(),
  })
  .strict()

export const hospitalIdParamSchema = z
  .object({
    hospitalId: objectIdSchema,
  })
  .strict()

export const objectIdParamSchema = (name: string) =>
  z
    .object({
      [name]: objectIdSchema,
    })
    .strict()

/**
 * Platform list query.
 *
 * `status` is an enum so an arbitrary string cannot reach a query filter; the
 * underlying record limit is enforced by the pagination schema.
 */
export const platformHospitalListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED']).optional(),
  })
  .strict()

export type LoginInput = z.infer<typeof loginSchema>
export type HospitalRegistrationInput = z.infer<typeof hospitalRegistrationSchema>