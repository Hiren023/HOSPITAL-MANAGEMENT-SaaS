import { z } from 'zod'

import { objectIdSchema, pageQuerySchema } from '@infinigrow/shared'

/**
 * Attendance input validation.
 *
 * Check-in and check-out accept NO body and take NO time parameter — they are declared
 * here by their absence. A staff member records that they are present, not when they would
 * like it to appear that they were.
 *
 * The only way to change a timestamp is the correction workflow, which needs a reason and
 * a second person, and is enforced in the service because it depends on the record's
 * current state rather than on the shape of the request.
 */

/** A calendar date in the HOSPITAL's local zone, `YYYY-MM-DD`. */
const localDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  }, 'That is not a real calendar date')

export const attendanceListQuerySchema = pageQuerySchema
  .extend({
    workDate: localDate.optional(),
    userId: objectIdSchema.optional(),
    status: z.enum(['OPEN', 'CLOSED', 'CORRECTED']).optional(),
  })
  .strict()

export const myAttendanceQuerySchema = pageQuerySchema.extend({
  workDate: localDate.optional(),
}).strict()

/**
 * A requested correction to a check-in or check-out time.
 *
 * The value is an ISO 8601 instant WITH an explicit offset, same rule as everywhere else.
 * A bare local time is refused rather than guessed at — and on a time record a wrong guess
 * is exactly the kind of error nobody notices until it is in a report.
 *
 * Parsed to a `Date` by the service, which is where `parseInstant` lives.
 */
export const attendanceCorrectionSchema = z
  .object({
    field: z.enum(['checkInAt', 'checkOutAt']),
    value: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .refine(
        (value) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && !Number.isNaN(new Date(value).getTime()),
        'Send a full ISO 8601 instant with a UTC offset, for example 2026-10-11T09:00:00+05:30',
      ),
    /**
     * 10 characters, not 5. This correction is auditable and will be read by somebody
     * deciding whether to accept it; "oops" is not a reason.
     */
    reason: z
      .string()
      .trim()
      .min(10, 'Give a reason of at least 10 characters — this correction is auditable')
      .max(500),
  })
  .strict()

export const attendanceDecisionSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
  })
  .strict()