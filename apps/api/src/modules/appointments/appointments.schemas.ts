import { z } from 'zod'

import {
  MAX_PAGE_SIZE,
  objectIdSchema,
  pageQuerySchema,
  searchQuerySchema,
} from '@infinigrow/shared'

import { APPOINTMENT_STATUSES } from './appointments.models.js'

/**
 * Appointment input validation.
 *
 * As elsewhere, every object is `.strict()` — a dropped `startAt` would otherwise produce
 * a confirmed booking at an unknown time.
 *
 * Times arrive as full ISO 8601 instants WITH an explicit offset. See
 * `utilities/hospital-time.ts` for why a bare `"09:00"` is refused rather than guessed at.
 */

/**
 * A calendar date in the HOSPITAL's local zone, `YYYY-MM-DD`.
 *
 * Used by the day and week views, where the caller is asking "show me the clinic's
 * Tuesday" and the server — not the caller's browser — decides which Tuesday that is. A
 * request carrying an instant here would silently mean a different day for a user in a
 * different zone from the hospital, which is precisely the confusion this policy exists
 * to prevent.
 */
const localDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  }, 'That is not a real calendar date')

/** Minutes from midnight. */
const minuteOfDay = z
  .number()
  .int('Use whole minutes')
  .min(0, 'Time cannot be before midnight')
  .max(24 * 60, 'Time cannot be after midnight')

const instantString = z
  .string()
  .trim()
  .min(1, 'A date and time is required')
  .max(40)

const reason = (max: number) => z.string().trim().max(max)

export const appointmentIdParamSchema = z.object({ appointmentId: objectIdSchema }).strict()

export const createAppointmentSchema = z
  .object({
    patientId: objectIdSchema,
    doctorUserId: objectIdSchema,
    departmentId: objectIdSchema.optional(),

    /** ISO 8601 with an explicit offset. Parsed and range-checked by the service. */
    startAt: instantString,
    /**
     * Optional. When omitted the hospital's configured slot duration is used, which keeps
     * the common case ("the next free 20-minute slot") a single-field form.
     */
    durationMinutes: minuteOfDay.optional(),

    reason: reason(300).optional(),

    /**
     * Book as CONFIRMED rather than SCHEDULED.
     *
     * Distinct from the status field so the client cannot create an appointment directly
     * in COMPLETED or CANCELLED. Those are only reachable by a transition, and every
     * transition is recorded in the status history.
     */
    confirm: z.boolean().optional(),
  })
  .strict()

export const rescheduleAppointmentSchema = z
  .object({
    startAt: instantString,
    durationMinutes: minuteOfDay.optional(),
    doctorUserId: objectIdSchema.optional(),
    /**
     * Why the appointment is moving.
     *
     * Required, and not merely optional-with-a-default: a reschedule that silently drops
     * the reason leaves a patient asking why their appointment moved with nobody able to
     * answer.
     */
    reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(300),
  })
  .strict()

export const cancelAppointmentSchema = z
  .object({
    reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500),
  })
  .strict()

export const appointmentStatusQuerySchema = z
  .object({
    ...pageQuerySchema.shape,
    status: z.enum(APPOINTMENT_STATUSES).optional(),
    doctorUserId: objectIdSchema.optional(),
    patientId: objectIdSchema.optional(),
    /**
     * The hospital-local calendar day to show. Omit for the next seven days from now.
     */
    date: localDate.optional(),
    /** Calendar days to include when `date` is given. Capped at 31. */
    days: z.coerce.number().int().min(1).max(31).optional(),
  })
  .strict()

/**
 * The day view.
 *
 * `date` is the hospital's local calendar day. There is no default: a schedule screen
 * that guessed which day you meant would silently show yesterday's clinic to anyone whose
 * browser clock had rolled over.
 */
export const appointmentDayQuerySchema = z
  .object({
    date: localDate,
    doctorUserId: objectIdSchema.optional(),
    departmentId: objectIdSchema.optional(),
  })
  .strict()

export const appointmentListQuerySchema = z
  .object({
    ...pageQuerySchema.shape,
    ...searchQuerySchema.shape,
    status: z.enum(APPOINTMENT_STATUSES).optional(),
    doctorUserId: objectIdSchema.optional(),
    patientId: objectIdSchema.optional(),
    /** ISO 8601 instants bounding the search, with explicit offsets. */
    from: instantString.optional(),
    to: instantString.optional(),
  })
  .strict()

/**
 * Working hours, keyed by weekday 0–6.
 *
 * A value of `null` means CLOSED, which is the default reading for an absent day: a
 * booking system that assumes a hospital is open at 3am because nobody configured it
 * will happily take the appointment.
 */
const workingDaySchema = z
  .object({
    opensAtMinute: minuteOfDay,
    closesAtMinute: minuteOfDay,
  })
  .strict()
  .refine((value) => value.closesAtMinute > value.opensAtMinute, {
    message: 'Closing time must be after opening time',
    path: ['closesAtMinute'],
  })
  .nullable()

export const updateWorkingHoursSchema = z
  .object({
    workingHours: z
      .object({
        '0': workingDaySchema.optional(),
        '1': workingDaySchema.optional(),
        '2': workingDaySchema.optional(),
        '3': workingDaySchema.optional(),
        '4': workingDaySchema.optional(),
        '5': workingDaySchema.optional(),
        '6': workingDaySchema.optional(),
      })
      .strict(),
  })
  .strict()

/**
 * Availability for one doctor on one local date.
 *
 * Answers "which of these slot starts are free?" rather than returning free time and
 * making the client subtract overlapping bookings — the server already owns the truth,
 * and a client that recomputes it will eventually disagree.
 */
export const availabilityQuerySchema = z
  .object({
    date: localDate,
    doctorUserId: objectIdSchema.optional(),
    departmentId: objectIdSchema.optional(),
    durationMinutes: minuteOfDay.optional(),
  })
  .strict()

export { MAX_PAGE_SIZE }