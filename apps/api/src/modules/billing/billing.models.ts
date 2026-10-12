import mongoose, { Schema } from 'mongoose'
import { Types } from 'mongoose'

import { tenantScopedSchema } from '../../infrastructure/db/tenant-plugin.js'

/**
 * Billing: the service catalogue, invoices, and payments.
 *
 * ── Money ────────────────────────────────────────────────────────────────────
 *
 * Every amount is an integer count of the currency's minor unit. See
 * `packages/shared/src/types/money.ts` for the rounding rules and for the accounting
 * assumptions that need a professional's review — those are documented there rather than
 * buried, because they are decisions this codebase should not make on its own.
 *
 * The subtotal, tax and total on an invoice are STORED, not derived at read time, because
 * a financial record has to say what it said when it was issued. If a service price changes
 * tomorrow, yesterday's invoice must not change with it. They are recomputed on every write
 * and never accepted from a client.
 *
 * ── Issued invoices are not edited ───────────────────────────────────────────
 *
 * A `DRAFT` invoice is scratch work and edits freely. An `ISSUED` invoice is a document
 * somebody has handed to a patient, and changing one in place would mean the copy they were
 * given no longer matches the system. Voiding is recorded rather than deleted, and a
 * replacement is a new invoice.
 *
 * This is the same principle as amendments on a finalized clinical record, applied to money.
 */

/** One priced line on an invoice. Frozen at issue: the unit price is a historical fact. */
const invoiceLineSchema = new Schema(
  {
    serviceId: { type: Schema.Types.ObjectId, ref: 'Service' },
    /** Denormalised so the document still reads correctly if the catalogue changes. */
    code: { type: String, trim: true, maxlength: 40 },
    description: { type: String, required: true, trim: true, maxlength: 300 },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, validate: Number.isInteger },
    discountBps: { type: Number, required: true, default: 0, min: 0, max: 10_000 },
    taxBps: { type: Number, required: true, default: 0, min: 0, max: 10_000 },
    taxInclusive: { type: Boolean, default: false },

    // Computed server-side, stored so the printed document is reproducible.
    subtotalMinor: { type: Number, required: true, min: 0 },
    discountMinor: { type: Number, required: true, min: 0 },
    taxableMinor: { type: Number, required: true, min: 0 },
    taxMinor: { type: Number, required: true, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false },
)

export const SERVICE_CATEGORIES = [
  'CONSULTATION',
  'PROCEDURE',
  'LABORATORY',
  'IMAGING',
  'PHARMACY',
  'WARD',
  'OTHER',
] as const

const serviceSchema = tenantScopedSchema(
  'Service',
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 1000 },
    category: { type: String, enum: SERVICE_CATEGORIES, default: 'OTHER' },

    /** Catalogue price in minor units. Overridable per invoice line; the override is kept. */
    unitPriceMinor: { type: Number, required: true, min: 0 },
    taxBps: { type: Number, required: true, default: 0, min: 0, max: 10_000 },
    /** Whether the quoted price already contains tax. Mirrors the hospital setting. */
    taxInclusive: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// Unique per hospital, NOT globally: two hospitals legitimately both have a "CONS" code,
// and a global constraint would leak one hospital's catalogue size to every other.
serviceSchema.index({ hospitalId: 1, code: 1 }, { unique: true })
serviceSchema.index({ hospitalId: 1, isActive: 1, category: 1 })

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'VOID'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

const invoiceSchema = tenantScopedSchema(
  'Invoice',
  {
    /**
     * Human-facing reference, e.g. `INV-000042`.
     *
     * Unique per hospital, never globally. Allocated from an atomic counter, the same way
     * patient numbers are, so two receptionists invoicing at the same moment cannot collide.
     */
    number: { type: String, required: true, trim: true, maxlength: 40 },

    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    /** Optional link to the clinical encounter that gave rise to this invoice. */
    consultationId: { type: Schema.Types.ObjectId, ref: 'Consultation' },

    /** The hospital's LOCAL calendar day, `YYYY-MM-DD`. A bill belongs to a day, not an instant. */
    issueDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    currency: { type: String, required: true, uppercase: true, maxlength: 3 },

    lines: { type: [invoiceLineSchema], default: [] },

    // Stored, never derived at read time. See the header.
    subtotalMinor: { type: Number, required: true, default: 0, min: 0 },
    discountMinor: { type: Number, required: true, default: 0, min: 0 },
    taxableMinor: { type: Number, required: true, default: 0, min: 0 },
    taxMinor: { type: Number, required: true, default: 0, min: 0 },
    totalMinor: { type: Number, required: true, default: 0, min: 0 },

    status: { type: String, enum: INVOICE_STATUSES, default: 'DRAFT' },

    notes: { type: String, trim: true, maxlength: 2000 },

    issuedAt: { type: Date },
    issuedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },

    voidedAt: { type: Date },
    voidedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    voidReason: { type: String, trim: true, maxlength: 500 },

    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

invoiceSchema.index({ hospitalId: 1, number: 1 }, { unique: true })
// The receivables view: what is outstanding, oldest first.
invoiceSchema.index({ hospitalId: 1, status: 1, issueDate: -1 })
invoiceSchema.index({ hospitalId: 1, patientId: 1, issueDate: -1 })

export const PAYMENT_METHODS = [
  'CASH',
  'CARD',
  'UPI',
  'BANK_TRANSFER',
  'CHEQUE',
  'INSURANCE',
  'OTHER',
] as const

/**
 * Where a payment record came from.
 *
 * `MANUAL` is a person asserting that money changed hands. `GATEWAY` is a claim from a
 * payment provider that has not yet been reconciled.
 *
 * These are kept apart everywhere, including in reports. Collapsing them into one
 * "revenue" figure would present an unreconciled provider claim as settled cash, and a
 * receivables report built on that number would be wrong in the direction that hides money.
 */
export const PAYMENT_SOURCES = ['MANUAL', 'GATEWAY'] as const

/**
 * How much trust a payment record has earned.
 *
 * `MANUAL` payments are always `UNVERIFIED`: no system confirmed them, and pretending
 * otherwise would be dishonest. Gateway payments start `PENDING` and only become `VERIFIED`
 * through an explicit reconciliation step that names who did it.
 */
export const PAYMENT_VERIFICATIONS = ['UNVERIFIED', 'PENDING', 'VERIFIED'] as const

export const PAYMENT_KINDS = ['PAYMENT', 'REFUND'] as const

const paymentSchema = tenantScopedSchema(
  'Payment',
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },

    kind: { type: String, enum: PAYMENT_KINDS, default: 'PAYMENT' },

    /**
     * Always POSITIVE, whatever the kind.
     *
     * A refund is not a negative amount — it is money leaving, recorded as a refund, and
     * the invoice balance subtracts it. Encoding it as a negative number would make every
     * report that sums this field wrong unless it also remembered to special-case refunds,
     * and at least one of them would forget.
     */
    amountMinor: { type: Number, required: true, min: 1 },

    method: { type: String, enum: PAYMENT_METHODS, required: true },
    source: { type: String, enum: PAYMENT_SOURCES, default: 'MANUAL' },
    verification: { type: String, enum: PAYMENT_VERIFICATIONS, default: 'UNVERIFIED' },

    /**
     * A receipt number, UPI reference, cheque number or provider transaction id.
     *
     * NOT a card number, CVV, expiry or any other payment credential. There is no field for
     * one anywhere in this schema, and the request schema is `.strict()`, so sending one is
     * refused rather than silently dropped. See `SECURITY.md` — storing card data turns a
     * breach into a PCI-DSS problem rather than merely a data-protection one.
     */
    reference: { type: String, trim: true, maxlength: 200 },

    /**
     * Client-supplied key making a retry safe.
     *
     * A unique index turns a double-submitted "record payment" into a replay that returns
     * the original payment rather than a second charge. See the service for the semantics.
     */
    idempotencyKey: { type: String, trim: true, maxlength: 200 },

    /** Set for a refund: the payment being reversed, so the pair reconciles. */
    refundsPaymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },

    occurredAt: { type: Date, required: true, default: () => new Date() },
    recordedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    verifiedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// The idempotency guarantee. Partial: a manual payment with no key is always allowed, so
// only clients that opt in are protected.
paymentSchema.index(
  { hospitalId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
)
paymentSchema.index({ hospitalId: 1, invoiceId: 1, occurredAt: -1 })
// The revenue reports. Date-range queries over a date range are this index's whole purpose.
paymentSchema.index({ hospitalId: 1, occurredAt: -1, verification: 1 })

/**
 * The per-hospital invoice sequence.
 *
 * An atomic counter rather than "count the invoices and add one", which two concurrent
 * requests would both get wrong.
 */
const billingCounterSchema = tenantScopedSchema(
  'BillingCounter',
  {
    key: { type: String, required: true, enum: ['INVOICE'] },
    value: { type: Number, required: true, default: 0 },
  },
  { timestamps: false, strict: true, strictQuery: true },
)

billingCounterSchema.index({ hospitalId: 1, key: 1 }, { unique: true })

export const ServiceModel =
  (mongoose.models['Service'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('Service', serviceSchema)

export const InvoiceModel =
  (mongoose.models['Invoice'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('Invoice', invoiceSchema)

export const PaymentModel =
  (mongoose.models['Payment'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('Payment', paymentSchema)

export const BillingCounterModel =
  (mongoose.models['BillingCounter'] as mongoose.Model<unknown> | undefined) ??
  mongoose.model('BillingCounter', billingCounterSchema)

/** Re-exported so consumers need not import mongoose for an id cast. */
export { Types }