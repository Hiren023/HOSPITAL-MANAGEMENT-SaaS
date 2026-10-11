import { z } from 'zod'

import { MAX_PAGE_SIZE, objectIdSchema, pageQuerySchema, searchQuerySchema } from '@infinigrow/shared'

import { GENDER_VALUES } from './patients.models.js'

/**
 * Patient input validation.
 *
 * Every object is `.strict()`. On a registration form a silently-dropped field is worse
 * than a rejected one: the desk types an address, presses save, sees success, and the
 * address was never stored — and the error surfaces days later as an unreachable patient.
 *
 * There is deliberately no `hospitalId` anywhere in these schemas. The tenant comes from
 * the session; accepting one would let a crafted request target another hospital's
 * register.
 */

const trimmed = (max: number) => z.string().trim().max(max)

/**
 * A phone number.
 *
 * Digits, spaces and the usual separators, optionally a leading `+`. Not validated for
 * being a *reachable* number — that is unknowable and a wrong-but-well-formed number is
 * far better than refusing a legitimate one over a formatting rule.
 */
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a phone number of 7 to 20 digits')

const name = (label: string, max = 100) =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`)

/**
 * Date of birth.
 *
 * A calendar date with no zone — `YYYY-MM-DD`. It is deliberately NOT an instant: a birth
 * date identifies a day of someone's life, and attaching a time and offset to it means a
 * patient born at midnight could render as the previous day for half the world.
 *
 * Bounded below because a birth date of 1900 is a data-entry slip that then distorts every
 * age calculation in the system, and bounded above at today because nobody is born in the
 * future. The comparison is done in code rather than with `z.string().datetime()` so the
 * message can say which bound was broken.
 */
const dateOfBirth = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  }, 'That is not a real calendar date')
  .refine((value) => value >= '1900-01-01', 'That date of birth looks like a typing slip')
  .refine(
    (value) => value <= new Date().toISOString().slice(0, 10),
    'A date of birth cannot be in the future',
  )

const addressSchema = z
  .object({
    line1: trimmed(160).optional(),
    line2: trimmed(160).optional(),
    city: trimmed(80).optional(),
    state: trimmed(80).optional(),
    postalCode: trimmed(20).optional(),
    country: trimmed(80).optional(),
  })
  .strict()

const emergencyContactSchema = z
  .object({
    name: trimmed(120).optional(),
    relationship: trimmed(60).optional(),
    phone: phone.optional(),
  })
  .strict()

/**
 * The duplicate-check body.
 *
 * A dedicated schema rather than `createPatientSchema.pick(...)`: that schema carries a
 * `.refine()` requiring a contact detail, and Zod refuses to pick from a refined object.
 * The refinement does not belong here anyway — someone part-way through the form has
 * usually typed a number, and demanding one before they finish typing a name is hostile.
 */
export const duplicateCheckSchema = z
  .object({
    firstName: name('First name'),
    lastName: name('Last name'),
    dateOfBirth,
  })
  .strict()

export const patientIdParamSchema = z.object({ patientId: objectIdSchema }).strict()

export const createPatientSchema = z
  .object({
    firstName: name('First name'),
    lastName: name('Last name'),
    dateOfBirth,
    gender: z.enum(GENDER_VALUES).optional(),
    phone: phone.optional(),
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254).optional(),
    address: addressSchema.optional(),
    emergencyContact: emergencyContactSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.phone ?? value.email),
    'Give at least a phone number or an email address so the patient can be reached',
  )

/**
 * An update.
 *
 * Every field optional, but at least one required — otherwise `PATCH` with an empty body
 * would return 200 and change nothing, which reads as "saved" to whoever pressed the
 * button.
 */
export const updatePatientSchema = z
  .object({
    firstName: name('First name').optional(),
    lastName: name('Last name').optional(),
    dateOfBirth: dateOfBirth.optional(),
    gender: z.enum(GENDER_VALUES).optional(),
    phone: phone.optional(),
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254).optional(),
    address: addressSchema.optional(),
    emergencyContact: emergencyContactSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'There is nothing to update')

export const patientListQuerySchema = z
  .object({
    ...pageQuerySchema.shape,
    ...searchQuerySchema.shape,
    gender: z.enum(GENDER_VALUES).optional(),
    isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    /**
     * Restrict to a single patient number or an exact phone number.
     *
     * Exposed as a filter rather than folded into `q` because those are the two lookups
     * a receptionist performs when a patient arrives holding a card, and they must be
     * exact. Free-text `q` matching them approximately would return the wrong patient's
     * record at a busy desk.
     */
    patientNumber: trimmed(40).optional(),
    phone: trimmed(20).optional(),
  })
  .strict()

/** Exactly one lookup identifier, so a bare id is never ambiguous. */
export const appointmentPatientHistoryQuerySchema = z
  .object({
    ...pageQuerySchema.shape,
    status: trimmed(30).optional(),
  })
  .strict()

export { MAX_PAGE_SIZE }