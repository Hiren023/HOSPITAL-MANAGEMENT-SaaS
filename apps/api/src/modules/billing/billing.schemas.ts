import { z } from 'zod'

import {
  BPS_DENOMINATOR,
  CURRENCIES,
  DEFAULT_CURRENCY,
  assertMinorUnits,
  objectIdSchema,
  pageQuerySchema,
} from '@infinigrow/shared'

import { INVOICE_STATUSES, PAYMENT_KINDS, PAYMENT_METHODS, SERVICE_CATEGORIES } from './billing.models.js'

/**
 * Billing input validation.
 *
 * Every object is `.strict()`, and that is load-bearing in one place above all others:
 *
 * **A client cannot send a total.** `InvoiceTotalsInput` does not exist, and no invoice
 * field accepts `subtotalMinor`, `taxMinor` or `totalMinor` from a request. The strongest
 * form of "never trust the frontend's total" is making it unrepresentable — a strict schema
 * that refuses it is better than a schema that accepts it and then ignores it, because the
 * second version invites somebody to "fix" it by using the client's value.
 *
 * Amounts are validated as safe integers here as well as in the money module, so a float
 * arriving from JSON is refused at the edge rather than after a round of arithmetic.
 */

const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine(
    (value) => Object.prototype.hasOwnProperty.call(CURRENCIES, value),
    'That currency is not supported. Add its minor-unit exponent to CURRENCIES rather than guessing: a wrong exponent mis-prices every invoice.',
  )

/** A whole, safe, non-negative number of minor units. */
const minorUnits = z
  .number()
  .int('Amounts must be whole units of the currency, not decimals')
  .min(0)
  .max(Number.MAX_SAFE_INTEGER, 'That amount is beyond exact arithmetic')
  .refine((value) => assertMinorUnits(value) === value)

/** A positive whole number of minor units, for something that must be greater than zero. */
const positiveMinorUnits = z
  .number()
  .int('Amounts must be whole units of the currency, not decimals')
  .positive('An amount must be greater than zero')
  .max(Number.MAX_SAFE_INTEGER, 'That amount is beyond exact arithmetic')

/** Basis points: an integer, 0 to 10000. */
const basisPoints = z.number().int().min(0).max(BPS_DENOMINATOR)

/** A local calendar date in the HOSPITAL's zone, `YYYY-MM-DD`. */
const localDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  }, 'That is not a real calendar date')

// ───────────────────────────── catalogue ─────────────────────────────

export const createServiceSchema = z
  .object({
    code: z.string().trim().min(2).max(40).toUpperCase(),
    name: z.string().trim().min(2).max(200),
    description: z.string().trim().max(1000).optional(),
    category: z.enum(SERVICE_CATEGORIES).optional(),
    unitPriceMinor: minorUnits,
    taxBps: basisPoints.optional(),
    taxInclusive: z.boolean().optional(),
  })
  .strict()

export const updateServiceSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(1000).optional(),
    category: z.enum(SERVICE_CATEGORIES).optional(),
    unitPriceMinor: minorUnits.optional(),
    taxBps: basisPoints.optional(),
    taxInclusive: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

export const serviceListQuerySchema = pageQuerySchema
  .extend({
    category: z.enum(SERVICE_CATEGORIES).optional(),
    isActive: z.enum(['true', 'false']).optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict()

// ───────────────────────────── invoices ─────────────────────────────

/**
 * One requested line.
 *
 * `unitPriceMinor` is optional: omit it to take the catalogue price. Supply it to override,
 * and the override is recorded on the line — an invoice that quietly differs from the price
 * list is one nobody can reconcile later.
 *
 * There is deliberately NO field for a line total, a discount amount or a tax amount.
 */
const invoiceLineInput = z
  .object({
    serviceId: objectIdSchema.optional(),
    description: z.string().trim().min(1).max(300).optional(),
    unitPriceMinor: minorUnits.optional(),
    quantity: z.number().int().min(1).max(1000),
    discountBps: basisPoints.optional(),
    taxBps: basisPoints.optional(),
    taxInclusive: z.boolean().optional(),
  })
  .strict()

export const createInvoiceSchema = z
  .object({
    patientId: objectIdSchema,
    consultationId: objectIdSchema.optional(),
    issueDate: localDate.optional(),
    currency: currencyCode.optional(),
    lines: z.array(invoiceLineInput).min(1, 'An invoice with no lines is not an invoice').max(100),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()

export const updateInvoiceSchema = z
  .object({
    lines: z.array(invoiceLineInput).min(1).max(100).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()

export const voidInvoiceSchema = z
  .object({
    /**
     * Mandatory. Voiding is how a mistake in an issued document is corrected, and "no
     * reason given" is how a fraud becomes hard to spot.
     */
    reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500),
  })
  .strict()

export const invoiceListQuerySchema = pageQuerySchema
  .extend({
    patientId: objectIdSchema.optional(),
    status: z.enum(INVOICE_STATUSES).optional(),
    from: localDate.optional(),
    to: localDate.optional(),
  })
  .strict()

// ───────────────────────────── payments ─────────────────────────────

/**
 * Record a payment.
 *
 * Note what is NOT here: `cardNumber`, `cvv`, `expiry`, `pan`, `accountNumber`,
 * `cardToken`. There is no field for a payment credential anywhere in this module, and
 * because the schema is strict, sending one is refused rather than quietly ignored. Storing
 * card data would turn a data breach into a PCI-DSS scope problem, and nothing this system
 * needs requires it: a receipt number or provider reference is what reconciliation wants.
 *
 * `reference` is free text for exactly that, and is capped so it cannot be used to smuggle
 * a full card number into a text field.
 */
export const recordPaymentSchema = z
  .object({
    invoiceId: objectIdSchema,
    amountMinor: positiveMinorUnits,
    method: z.enum(PAYMENT_METHODS),
    kind: z.enum(PAYMENT_KINDS).optional(),
    reference: z.string().trim().max(200).optional(),
    source: z.enum(['MANUAL', 'GATEWAY']).optional(),
    /** ISO 8601 with an explicit offset, parsed by the service. See docs/TIMEZONE.md. */
    occurredAt: z.string().trim().min(1).max(40).optional(),
    /** For a refund: the payment being reversed. */
    refundsPaymentId: objectIdSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'REFUND' && !value.refundsPaymentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['refundsPaymentId'],
        message: 'A refund must name the payment it reverses, so the pair can be reconciled',
      })
    }
  })

/**
 * Mark a gateway payment as reconciled.
 *
 * A separate verb rather than a field on the payment, so that "verified" is always an
 * event somebody performed and always names who performed it. Nothing in this MVP calls a
 * payment gateway; a human confirms a settlement file matched, and the system records that
 * they said so.
 */
export const verifyPaymentSchema = z
  .object({
    reference: z.string().trim().max(200).optional(),
  })
  .strict()

export const paymentListQuerySchema = pageQuerySchema
  .extend({
    invoiceId: objectIdSchema.optional(),
    patientId: objectIdSchema.optional(),
    method: z.enum(PAYMENT_METHODS).optional(),
    source: z.enum(['MANUAL', 'GATEWAY']).optional(),
    verification: z.enum(['UNVERIFIED', 'PENDING', 'VERIFIED']).optional(),
    from: localDate.optional(),
    to: localDate.optional(),
  })
  .strict()

// ───────────────────────────── reports ─────────────────────────────

export const revenueQuerySchema = z
  .object({
    /**
     * `daily` | `monthly` | `range`.
     *
     * `daily` and `monthly` bucket by the hospital's local calendar day and month, which is
     * how a hospital's books close — not by UTC, which would split a day's takings across
     * two dates for anyone not on UTC.
     */
    granularity: z.enum(['daily', 'monthly', 'range']).default('daily'),
    from: localDate,
    to: localDate,
    currency: currencyCode.optional(),
  })
  .strict()
  .refine((value) => value.from <= value.to, {
    // Applies to EVERY granularity, not just `range`. A reversed range is a mistake under
    // all of them, and letting it through returns an empty series — which reads as "no
    // takings" rather than "you asked for a backwards range". Those are very different
    // things to somebody reconciling a month.
    message: 'The start of the range must not be after its end',
    path: ['from'],
  })

export const appointmentReportQuerySchema = z
  .object({ from: localDate, to: localDate })
  .strict()
  .refine((value) => value.from <= value.to, {
    message: 'The start of the range must not be after its end',
    path: ['from'],
  })

export const attendanceReportQuerySchema = z
  .object({ from: localDate, to: localDate })
  .strict()
  .refine((value) => value.from <= value.to, {
    message: 'The start of the range must not be after its end',
    path: ['from'],
  })

export { DEFAULT_CURRENCY }