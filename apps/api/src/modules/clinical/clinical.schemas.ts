import { z } from 'zod'

import { objectIdSchema, pageQuerySchema } from '@infinigrow/shared'

import { CONSULTATION_STATUSES } from './clinical.models.js'

/**
 * Clinical input validation.
 *
 * Every object is `.strict()`. In an ordinary CRUD module a dropped field is an
 * annoyance; here it could silently discard part of a medical record that a clinician
 * believes was saved. Refusing the request is recoverable; losing the record is not.
 *
 * ── On validating instants ────────────────────────────────────────────────────
 *
 * Timestamps arrive as ISO 8601 strings WITH an explicit offset, and are converted to
 * `Date` by the SERVICE, not by a Zod transform.
 *
 * A transform runs inside the schema, where throwing is awkward and a validation failure
 * is reported in the shape of a type error rather than a clinical one. Parsing in the
 * service means a bare `"09:00"` is refused by the same function that decides what a day
 * means, with the same explanation, and the rule lives in exactly one place. The schema
 * here only checks that it *looks* like an instant.
 */

/** An ISO 8601 instant carrying an explicit offset. Parsed and range-checked by the service. */
const instantString = z
  .string()
  .trim()
  .min(1, 'A date and time is required')
  .max(40)
  .refine(
    (value) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && !Number.isNaN(new Date(value).getTime()),
    'Send a full ISO 8601 instant with a UTC offset, for example 2026-10-11T09:00:00+05:30',
  )

/**
 * A clinician's free text.
 *
 * Length-bounded because it is stored and later rendered into a PDF, where an unbounded
 * value would overflow the page. This is a storage bound, not a judgement about content.
 */
const narrative = (max: number) => z.string().trim().max(max).optional()

export const createConsultationSchema = z
  .object({
    patientId: objectIdSchema,
    appointmentId: objectIdSchema.optional(),
    chiefComplaint: narrative(2000),
    symptoms: narrative(4000),
    assessment: narrative(8000),
    plan: narrative(8000),
    followUpAt: instantString.optional(),
  })
  .strict()

/**
 * Editing a consultation.
 *
 * `amendmentReason` is the whole design. A DRAFT is a clinician's own scratch work and is
 * freely editable. A FINALIZED consultation is a signed record, and changing one without
 * recording why would rewrite what the record said at the moment it was signed. So the
 * same endpoint accepts both, and the service requires a reason for the second.
 */
export const updateConsultationSchema = z
  .object({
    chiefComplaint: narrative(2000),
    symptoms: narrative(4000),
    assessment: narrative(8000),
    plan: narrative(8000),
    followUpAt: instantString.optional(),
    /**
     * Required by the SERVICE when the consultation is finalized. Declared optional here
     * because the schema cannot see the record's state, and a draft edit should not have
     * to carry a reason it does not need.
     */
    amendmentReason: z.string().trim().min(5).max(500).optional(),
  })
  .strict()

export const finalizeConsultationSchema = z
  .object({
    /**
     * A clinician attests that the record is accurate before it is sealed.
     *
     * Finalizing puts a signed, attributed document onto the clinical timeline. Making
     * that an explicit act — rather than the mere existence of a POST — is the difference
     * between signing a record and saving a form.
     */
    attestation: z.boolean().refine((value) => value === true, {
      message: 'Confirm that this record is accurate and complete',
    }),
  })
  .strict()

export const consultationListQuerySchema = pageQuerySchema
  .extend({
    patientId: objectIdSchema.optional(),
    appointmentId: objectIdSchema.optional(),
    doctorUserId: objectIdSchema.optional(),
    status: z.enum(CONSULTATION_STATUSES).optional(),
    from: instantString.optional(),
    to: instantString.optional(),
  })
  .strict()

/**
 * The clinician's queue.
 *
 * `date` is the HOSPITAL's local calendar day, not the caller's. See
 * `utilities/hospital-time.ts`: a request carrying an instant here would mean a different
 * day for a user in a different zone from the hospital, which is exactly the confusion
 * this policy exists to prevent.
 */
const localDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  }, 'That is not a real calendar date')

export const consultationQueueQuerySchema = z.object({ date: localDate }).strict()

/**
 * One prescribed item.
 *
 * `drugName`, `dose`, `route` and `frequency` are all REQUIRED.
 *
 * This is a completeness check, not a safety judgement. Nothing here can tell you
 * whether a drug is appropriate for a patient, and nothing tries. What it does prevent is
 * the commonest way a prescription becomes unusable: a drug name reaching a patient's
 * hands with no dose or no route, which is not a prescription at all.
 */
const prescriptionItem = z
  .object({
    drugName: z.string().trim().min(2, 'Name the medicine').max(200),
    dose: z.string().trim().min(1, 'A dose is required, for example "500 mg"').max(100),
    route: z.string().trim().min(2, 'A route is required, for example "oral"').max(100),
    frequency: z.string().trim().min(2, 'A frequency is required, for example "twice daily"').max(100),
    duration: z.string().trim().max(100).optional(),
    quantity: z.string().trim().max(60).optional(),
    instructions: z.string().trim().max(500).optional(),
  })
  .strict()

export const createPrescriptionSchema = z
  .object({
    consultationId: objectIdSchema,
    items: z
      .array(prescriptionItem)
      .min(1, 'A prescription with no medicines is not a prescription')
      .max(50),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()

export const finalizePrescriptionSchema = z
  .object({
    /**
     * The clinician takes responsibility for the document before it is issued.
     *
     * The generated PDF states on its face that it is a clinician-authored document and
     * names its author. Issuing it is an assertion, not a formality, so it is confirmed
     * explicitly.
     */
    attestation: z.boolean().refine((value) => value === true, {
      message: 'Confirm this prescription before issuing it',
    }),
  })
  .strict()