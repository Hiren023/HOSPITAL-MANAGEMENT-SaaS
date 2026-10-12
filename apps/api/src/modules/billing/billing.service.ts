import { Types, type Model } from 'mongoose'
import type { Permission } from '@infinigrow/shared'
import {
  DEFAULT_CURRENCY,
  HOSPITAL_DEFAULTS,
  calculateLine,
  isSupportedCurrency,
  parseAmountToMinorUnits,
  sumLines,
} from '@infinigrow/shared'

import { ApiError } from '../../infrastructure/api-error.js'
import {
  countViaAggregate,
  findManyViaAggregate,
  findPageViaAggregate,
} from '../../utilities/mongo-compat.js'
import { localDayBounds, localDateKey, parseInstant } from '../../utilities/hospital-time.js'

import { AUDIT_ACTIONS, type AuditAction } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'
import { HospitalModel, UserModel } from '../identity/models.js'
import { PatientModel } from '../patients/patients.models.js'

import {
  BillingCounterModel,
  InvoiceModel,
  PaymentModel,
  ServiceModel,
} from './billing.models.js'

/**
 * Billing.
 *
 * Three properties this module is built around:
 *
 * 1. **The server computes every total.** A request carries line items and nothing else.
 *    There is no field in which a client's arithmetic could arrive, so there is nothing to
 *    forget to ignore.
 * 2. **Amounts are integers.** No float touches a monetary value. See
 *    `packages/shared/src/types/money.ts` for the rounding rules and for the accounting
 *    assumptions that need a professional's review.
 * 3. **Manual and gateway payments stay apart.** A person recording cash is not the same
 *    fact as a provider claiming a settlement. Reports show them separately rather than
 *    summing them into a single number that reads as cash in hand.
 *
 * Issued invoices are never edited — void and reissue, with the reason recorded. That is the
 * billing equivalent of amending a signed clinical record rather than rewriting it.
 */

export interface BillingActor {
  userId: string
  role: string
  hospitalId: string
  permissions: Permission[]
}

export interface Meta {
  ip: string
  requestId: string
}

type Row = Record<string, unknown>

const serviceModel = () => ServiceModel as unknown as Model<Row>
const invoiceModel = () => InvoiceModel as unknown as Model<Row>
const paymentModel = () => PaymentModel as unknown as Model<Row>
const counterModel = () => BillingCounterModel as unknown as Model<Row>
const patientModel = () => PatientModel as unknown as Model<Row>
const userModel = () => UserModel as unknown as Model<Row>

/**
 * `findManyViaAggregate` takes POSITIONAL arguments. Wrapped once so the options-object
 * mistake — which compiles and silently matches nothing — cannot be repeated.
 */
function findMany(model: Model<Row>, match: Row, limit = 1000): Promise<Row[]> {
  return findManyViaAggregate<Row>(model, match, limit)
}

function can(actor: BillingActor, permission: Permission): boolean {
  return actor.permissions.includes(permission)
}

function safeId(value: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw ApiError.notFound()
  return new Types.ObjectId(value)
}

function toRow(doc: unknown): Row {
  return (doc as { toObject?: () => Row }).toObject?.() ?? (doc as Row)
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

/** The computed part of a stored line, which is all sumLines needs. */
function toLineTotals(line: Row) {
  return {
    subtotalMinor: num(line['subtotalMinor']),
    discountMinor: num(line['discountMinor']),
    taxableMinor: num(line['taxableMinor']),
    taxMinor: num(line['taxMinor']),
    totalMinor: num(line['totalMinor']),
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

async function audit(
  action: AuditAction,
  actor: BillingActor,
  meta: Meta,
  resourceId: string,
  extra: Row = {},
): Promise<void> {
  await recordAudit({
    hospitalId: actor.hospitalId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action,
    resourceType: 'Billing',
    resourceId,
    outcome: 'SUCCESS',
    ip: meta.ip,
    requestId: meta.requestId,
    // Amounts are recorded; nothing identifying about a patient is. A financial trail
    // readable by `audit:read` should not become a second copy of the patient register.
    metadata: extra,
  })
}

interface HospitalBillingSettings {
  currency: string
  invoicePrefix: string
  timezone: string
}

async function loadSettings(hospitalId: string): Promise<HospitalBillingSettings> {
  const hospital = await (
    HospitalModel as unknown as {
      findById(id: Types.ObjectId): { lean(): { exec(): Promise<Row | null> } }
    }
  )
    .findById(new Types.ObjectId(hospitalId))
    .lean()
    .exec()

  const settings = (hospital?.['settings'] ?? {}) as Partial<HospitalBillingSettings>

  const currency = (settings.currency ?? HOSPITAL_DEFAULTS.currency).toUpperCase()
  if (!isSupportedCurrency(currency)) {
    throw ApiError.badRequest(
      `This hospital's currency (${currency}) has no known minor-unit exponent, so amounts cannot be priced correctly.`,
    )
  }

  return {
    currency,
    invoicePrefix: settings.invoicePrefix ?? HOSPITAL_DEFAULTS.invoicePrefix,
    timezone: settings.timezone ?? HOSPITAL_DEFAULTS.timezone,
  }
}

// ───────────────────────────── catalogue ─────────────────────────────

export async function listServices(
  _actor: BillingActor,
  _meta: Meta,
  query: Row,
): Promise<unknown> {
  const page = Number(query['page'] ?? 1)
  const pageSize = Number(query['pageSize'] ?? 20)

  const match: Row = {}
  if (query['category']) match['category'] = String(query['category'])
  if (query['isActive'] !== undefined) match['isActive'] = String(query['isActive']) === 'true'
  if (query['q']) {
    // A regex on a small per-hospital catalogue, not a full-text index. The catalogue is
    // bounded by what one hospital actually charges for, and an unindexed $regex there is
    // cheaper than the index maintenance a text index would cost.
    const escaped = String(query['q']).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    match['$or'] = [
      { name: { $regex: escaped, $options: 'i' } },
      { code: { $regex: escaped, $options: 'i' } },
    ]
  }

  const rows = await findPageViaAggregate<Row>(serviceModel(), {
    match,
    sort: { name: 1 },
    skip: (page - 1) * pageSize,
    limit: pageSize,
  })
  const total = await countViaAggregate(serviceModel(), match)

  return {
    items: rows.map(toService),
    page: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}

function toService(row: Row): Row {
  return {
    id: String(row['_id']),
    code: row['code'],
    name: row['name'],
    description: row['description'] ?? null,
    category: row['category'],
    unitPriceMinor: num(row['unitPriceMinor']),
    taxBps: num(row['taxBps']),
    taxInclusive: Boolean(row['taxInclusive']),
    isActive: Boolean(row['isActive']),
  }
}

export async function createService(actor: BillingActor, meta: Meta, input: Row): Promise<unknown> {
  const created = await serviceModel().create({
    hospitalId: safeId(actor.hospitalId),
    code: String(input['code']).toUpperCase(),
    name: input['name'],
    description: input['description'],
    category: input['category'] ?? 'OTHER',
    unitPriceMinor: input['unitPriceMinor'],
    taxBps: input['taxBps'] ?? 0,
    taxInclusive: input['taxInclusive'] ?? false,
  })

  await audit(AUDIT_ACTIONS.SERVICE_CREATED, actor, meta, String(created['_id']))

  return toService(toRow(created))
}

export async function updateService(
  actor: BillingActor,
  meta: Meta,
  serviceId: string,
  input: Row,
): Promise<unknown> {
  const existing = await loadService(actor, serviceId)

  await serviceModel().updateOne(
    { _id: safeId(serviceId) },
    {
      $set: {
        ...input,
        updatedAt: new Date(),
      },
    },
  )

  await audit(AUDIT_ACTIONS.SERVICE_UPDATED, actor, meta, serviceId)

  const [row] = await findMany(serviceModel(), { _id: existing['_id'] }, 1)
  return toService(row ?? existing)
}

async function loadService(_actor: BillingActor, serviceId: string): Promise<Row> {
  const [row] = await findMany(serviceModel(), { _id: safeId(serviceId) }, 1)
  if (!row) throw ApiError.notFound()
  return row
}

// ───────────────────────────── invoices ─────────────────────────────

/**
 * Allocate the next invoice number for this hospital.
 *
 * An atomic counter, not "count the invoices and add one". Two receptionists invoicing at
 * the same moment would both read the same count and produce the same number — and the
 * unique index on `{hospitalId, number}` would then turn one legitimate bill into a 409
 * failure at the customer.
 */
async function allocateInvoiceNumber(actor: BillingActor, prefix: string): Promise<string> {
  const counter = await counterModel().findOneAndUpdate(
    { hospitalId: safeId(actor.hospitalId), key: 'INVOICE' },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  )

  const value = num((counter as unknown as Row)?.['value'] ?? 0)
  return `${prefix}-${String(value).padStart(6, '0')}`
}

export async function createInvoice(
  actor: BillingActor,
  meta: Meta,
  input: {
    patientId: string
    consultationId?: string
    issueDate?: string
    currency?: string
    lines: Row[]
    notes?: string
  },
): Promise<unknown> {
  const settings = await loadSettings(actor.hospitalId)
  await requirePatient(input.patientId)

  const currency = input.currency ?? settings.currency
  const issueDate = input.issueDate ?? localDateKey(new Date(), settings.timezone)

  const lines = await resolveLines(actor, input.lines, currency)

  if (lines.length === 0) {
    throw ApiError.badRequest('An invoice needs at least one line with a price')
  }

  const totals = sumLines(lines.map(toLineTotals))

  const created = await invoiceModel().create({
    hospitalId: safeId(actor.hospitalId),
    number: await allocateInvoiceNumber(actor, settings.invoicePrefix),
    patientId: safeId(input.patientId),
    consultationId: input.consultationId ? safeId(input.consultationId) : undefined,
    issueDate,
    currency,
    lines,
    ...totals,
    status: 'DRAFT',
    notes: input.notes,
    createdByUserId: safeId(actor.userId),
    updatedByUserId: safeId(actor.userId),
  })

  await audit(AUDIT_ACTIONS.INVOICE_CREATED, actor, meta, String(created['_id']), {
    totalMinor: totals.totalMinor,
    currency,
  })

  return await presentInvoice(actor, toRow(created))
}

/**
 * Turn requested lines into priced lines.
 *
 * This is the only place a price becomes a number. A line either names a catalogue service
 * (taking its price and tax rate) or states its own description and price, which is how a
 * one-off charge is recorded. Either way the arithmetic happens here, on integers.
 */
async function resolveLines(
  _actor: BillingActor,
  requested: Row[],
  _currency: string,
): Promise<Row[]> {
  const serviceIds = requested
    .map((line) => line['serviceId'])
    .filter((id): id is string => typeof id === 'string')

  const services = serviceIds.length
    ? await findMany(serviceModel(), { _id: { $in: serviceIds.map(safeId) } }, 500)
    : []

  const byId = new Map(services.map((row) => [String(row['_id']), row]))

  return requested.map((line) => {
    const service = line['serviceId'] ? byId.get(String(line['serviceId'])) : undefined

    if (line['serviceId'] && !service) {
      // Scoped by the tenant plugin, so this covers both "no such service" and "not yours".
      throw ApiError.badRequest('That service is not in this hospital’s catalogue')
    }

    // An explicit price overrides the catalogue, and that is allowed — a hospital
    // discounts, a patient is insured, a price list is out of date. What is NOT allowed is
    // the override being invisible: the line keeps `code` and `description` from the
    // catalogue so the document still reconciles against it.
    const unitPriceMinor =
      line['unitPriceMinor'] !== undefined
        ? Number(line['unitPriceMinor'])
        : service
          ? num(service['unitPriceMinor'])
          : null

    if (unitPriceMinor === null) {
      throw ApiError.badRequest(
        'Each line needs either a service from the catalogue or its own price',
      )
    }

    const description =
      str(line['description']) ?? (service ? str(service['name']) : null)

    if (!description) {
      throw ApiError.badRequest('Each line needs a description')
    }

    const totals = calculateLine({
      unitPriceMinor,
      quantity: Number(line['quantity']),
      discountBps: Number(line['discountBps'] ?? 0),
      taxBps: Number(line['taxBps'] ?? service?.['taxBps'] ?? 0),
      taxInclusive: Boolean(line['taxInclusive'] ?? service?.['taxInclusive'] ?? false),
    })

    return {
      serviceId: service ? service['_id'] : undefined,
      code: service ? service['code'] : undefined,
      description,
      unitPriceMinor,
      quantity: Number(line['quantity']),
      discountBps: Number(line['discountBps'] ?? 0),
      taxBps: Number(line['taxBps'] ?? service?.['taxBps'] ?? 0),
      taxInclusive: Boolean(line['taxInclusive'] ?? service?.['taxInclusive'] ?? false),
      ...totals,
    }
  })
}

/**
 * Issue a draft.
 *
 * One-way, like finalizing a consultation: an invoice somebody has been handed is a
 * document, and editing it in place would mean the copy they hold no longer matches the
 * system. A mistake is corrected by voiding (recorded, with a reason) and issuing again.
 */
export async function issueInvoice(
  actor: BillingActor,
  meta: Meta,
  invoiceId: string,
): Promise<unknown> {
  const invoice = await loadInvoice(actor, invoiceId)

  if (invoice['status'] !== 'DRAFT') {
    throw ApiError.conflict(`This invoice is already ${invoice['status']}`)
  }

  const lines = Array.isArray(invoice['lines']) ? (invoice['lines'] as Row[]) : []
  if (lines.length === 0) {
    throw ApiError.badRequest('An invoice needs at least one line before it can be issued')
  }

  await invoiceModel().updateOne(
    { _id: safeId(invoiceId), status: 'DRAFT' },
    {
      $set: {
        status: 'ISSUED',
        issuedAt: new Date(),
        issuedByUserId: safeId(actor.userId),
        updatedByUserId: safeId(actor.userId),
      },
    },
  )

  await audit(AUDIT_ACTIONS.INVOICE_ISSUED, actor, meta, invoiceId, {
    totalMinor: num(invoice['totalMinor']),
  })

  return await presentInvoice(actor, (await loadInvoice(actor, invoiceId)) as Row)
}

/**
 * Void an issued invoice.
 *
 * Recorded rather than deleted, with a mandatory reason. A voided invoice is still in the
 * ledger: the money may already have been reported on, and removing the document would make
 * a previously-true report false retroactively.
 */
export async function voidInvoice(
  actor: BillingActor,
  meta: Meta,
  invoiceId: string,
  input: { reason: string },
): Promise<unknown> {
  const invoice = await loadInvoice(actor, invoiceId)

  if (invoice['status'] !== 'ISSUED') {
    throw ApiError.conflict('Only an issued invoice can be voided')
  }

  const payments = await paymentsFor(actor, invoiceId)
  const settled = payments.filter((payment) => payment['kind'] === 'PAYMENT')
  if (settled.length > 0) {
    throw ApiError.conflict(
      'This invoice has payments recorded against it. Refund them first — voiding an invoice with money on it would leave the payment pointing at nothing.',
    )
  }

  await invoiceModel().updateOne(
    { _id: safeId(invoiceId), status: 'ISSUED' },
    {
      $set: {
        status: 'VOID',
        voidedAt: new Date(),
        voidedByUserId: safeId(actor.userId),
        voidReason: input.reason,
        updatedByUserId: safeId(actor.userId),
      },
    },
  )

  await audit(AUDIT_ACTIONS.INVOICE_VOIDED, actor, meta, invoiceId, { reason: input.reason })

  return await presentInvoice(actor, (await loadInvoice(actor, invoiceId)) as Row)
}

export async function listInvoices(
  actor: BillingActor,
  _meta: Meta,
  query: Row,
): Promise<unknown> {
  const page = Number(query['page'] ?? 1)
  const pageSize = Number(query['pageSize'] ?? 20)

  const match: Row = {}
  if (query['patientId']) match['patientId'] = new Types.ObjectId(String(query['patientId']))
  if (query['status']) match['status'] = String(query['status'])

  if (query['from'] || query['to']) {
    // `issueDate` is a local calendar date, so a plain string comparison is correct and
    // correct — no timezone conversion, and no boundary instants to get wrong.
    const range: Row = {}
    if (query['from']) range['$gte'] = String(query['from'])
    if (query['to']) range['$lte'] = String(query['to'])
    match['issueDate'] = range
  }

  const rows = await findPageViaAggregate<Row>(invoiceModel(), {
    match,
    sort: { issueDate: -1, number: -1 },
    skip: (page - 1) * pageSize,
    limit: pageSize,
  })
  const total = await countViaAggregate(invoiceModel(), match)

  const items = await Promise.all(rows.map((row) => presentInvoice(actor, row)))

  return {
    items,
    page: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}

export async function readInvoice(actor: BillingActor, meta: Meta, invoiceId: string): Promise<unknown> {
  const invoice = await loadInvoice(actor, invoiceId)
  await audit(AUDIT_ACTIONS.INVOICE_VIEWED, actor, meta, invoiceId)

  return await presentInvoice(actor, invoice)
}

async function loadInvoice(_actor: BillingActor, invoiceId: string): Promise<Row> {
  const [row] = await findMany(invoiceModel(), { _id: safeId(invoiceId) }, 1)
  if (!row) throw ApiError.notFound()
  return row
}

/**
 * Attach the money facts to an invoice: what was paid, and what is still owed.
 *
 * A refund is subtracted, so an overpaid invoice shows a NEGATIVE balance rather than a
 * clamped zero. Clamping hides the overpayment and makes the refund that should follow it
 * impossible to reconcile.
 */
async function presentInvoice(actor: BillingActor, invoice: Row): Promise<Row> {
  const invoiceId = String(invoice['_id'])
  const payments = await paymentsFor(actor, invoiceId)

  const paidMinor = payments
    .filter((payment) => payment['kind'] === 'PAYMENT')
    .reduce((sum, payment) => sum + num(payment['amountMinor']), 0)

  const refundedMinor = payments
    .filter((payment) => payment['kind'] === 'REFUND')
    .reduce((sum, payment) => sum + num(payment['amountMinor']), 0)

  const settledMinor = paidMinor - refundedMinor
  const totalMinor = num(invoice['totalMinor'])

  const patientIds = uniqueIds([invoice['patientId']])
  const patients = patientIds.length
    ? await findMany(patientModel(), { _id: { $in: patientIds } }, 10)
    : []

  const patient = patients[0]

  return {
    id: invoiceId,
    number: invoice['number'],
    patientId: String(invoice['patientId']),
    patientLabel: patient
      ? `${patient['patientNumber']} — ${[patient['firstName'], patient['lastName']]
          .filter(Boolean)
          .join(' ')}`
      : null,
    consultationId: invoice['consultationId'] ? String(invoice['consultationId']) : null,
    issueDate: invoice['issueDate'],
    currency: invoice['currency'],
    status: invoice['status'],
    lines: invoice['lines'] ?? [],
    subtotalMinor: num(invoice['subtotalMinor']),
    discountMinor: num(invoice['discountMinor']),
    taxableMinor: num(invoice['taxableMinor']),
    taxMinor: num(invoice['taxMinor']),
    totalMinor,
    paidMinor: settledMinor,
    refundedMinor,
    balanceMinor: totalMinor - settledMinor,
    notes: invoice['notes'] ?? null,
    issuedAt: invoice['issuedAt'] instanceof Date ? (invoice['issuedAt'] as Date).toISOString() : null,
    voidReason: invoice['voidReason'] ?? null,
    payments: payments.map(toPayment),
    createdByUserId: String(invoice['createdByUserId']),
    createdAt: invoice['createdAt'] instanceof Date ? (invoice['createdAt'] as Date).toISOString() : null,
  }
}

// ───────────────────────────── payments ─────────────────────────────

async function paymentsFor(_actor: BillingActor, invoiceId: string): Promise<Row[]> {
  return findMany(
    paymentModel(),
    { invoiceId: safeId(invoiceId) },
    500,
  )
}

function toPayment(row: Row): Row {
  return {
    id: String(row['_id']),
    invoiceId: String(row['invoiceId']),
    patientId: String(row['patientId']),
    kind: row['kind'],
    amountMinor: num(row['amountMinor']),
    method: row['method'],
    source: row['source'],
    verification: row['verification'],
    reference: row['reference'] ?? null,
    refundsPaymentId: row['refundsPaymentId'] ? String(row['refundsPaymentId']) : null,
    occurredAt: (row['occurredAt'] as Date)?.toISOString(),
    recordedByUserId: String(row['recordedByUserId']),
    recordedByName: null,
    verifiedByUserId: row['verifiedByUserId'] ? String(row['verifiedByUserId']) : null,
    verifiedAt: row['verifiedAt'] instanceof Date ? (row['verifiedAt'] as Date).toISOString() : null,
    createdAt: row['createdAt'] instanceof Date ? (row['createdAt'] as Date).toISOString() : null,
  }
}

/**
 * Record a payment.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *
 * A client may supply an `idempotencyKey`. If one is already recorded against this
 * hospital, the ORIGINAL payment is returned — with `replayed: true` — rather than a second
 * one being created. That is the difference between a network retry and a double charge.
 *
 * If the same key arrives with a DIFFERENT payload, that is a `409`, not a replay. Silently
 * returning the first payment would tell a receptionist "recorded" about money that was
 * never taken. Two genuinely different payments must use different keys.
 *
 * The unique index makes this safe under concurrency; the pre-check is only there to give a
 * better answer and a clearer message.
 */
export async function recordPayment(
  actor: BillingActor,
  meta: Meta,
  input: {
    invoiceId: string
    amountMinor: number
    method: string
    kind?: string
    reference?: string
    source?: string
    occurredAt?: string
    refundsPaymentId?: string
  },
  idempotencyKey?: string,
): Promise<unknown> {
  const invoice = await loadInvoice(actor, input.invoiceId)

  if (invoice['status'] === 'VOID') {
    throw ApiError.conflict('This invoice has been voided')
  }

  const kind = input.kind ?? 'PAYMENT'
  const source = input.source ?? 'MANUAL'
  const amountMinor = Number(input.amountMinor)

  if (kind === 'REFUND') {
    await validateRefund(actor, input, amountMinor)
  } else {
    await validatePaymentAgainstInvoice(invoice, amountMinor, actor)
  }

  const fingerprint = {
    invoiceId: String(invoice['_id']),
    kind,
    amountMinor,
    method: input.method,
    reference: input.reference ?? null,
  }

  if (idempotencyKey) {
    const [existing] = await findMany(
      paymentModel(),
      { idempotencyKey },
      1,
    )

    if (existing) {
      if (!samePayload(existing, fingerprint)) {
        throw ApiError.conflict(
          'This idempotency key was already used for a different payment. Use a new key for a genuinely new payment — replaying this one would not record it.',
        )
      }

      return { ...(await presentInvoice(actor, invoice)), replayed: true, payment: toPayment(existing) }
    }
  }

  const inserted = await insertPayment(actor, invoice, {
    kind,
    source,
    amountMinor,
    method: input.method,
    reference: input.reference,
    occurredAt: input.occurredAt ? parseInstant(input.occurredAt) : new Date(),
    refundsPaymentId: input.refundsPaymentId ? safeId(input.refundsPaymentId) : undefined,
    idempotencyKey,
  })

  // A replay is not a new payment, so it is not audited as one. The original already was.
  if (!inserted.replayed) {
    await audit(
      kind === 'REFUND' ? AUDIT_ACTIONS.PAYMENT_REFUNDED : AUDIT_ACTIONS.PAYMENT_RECORDED,
      actor,
      meta,
      String(inserted.row['_id']),
      { amountMinor, method: input.method, source },
    )
  }

  const updated = await presentInvoice(actor, (await loadInvoice(actor, input.invoiceId)) as Row)
  return { ...updated, replayed: inserted.replayed, payment: toPayment(inserted.row) }
}

/**
 * Insert, translating a lost race into a replay rather than a duplicate charge.
 *
 * Returns whether the row is genuinely new. That matters: the caller reports 201 for a new
 * payment and 200 for a replay, and a client that retries cannot tell the difference
 * otherwise. Under concurrency BOTH requests pass the pre-check, one insert wins the
 * unique index, and the loser must come back as a replay rather than as a second charge.
 */
async function insertPayment(
  actor: BillingActor,
  invoice: Row,
  input: Row,
): Promise<{ row: Row; replayed: boolean }> {
  // A manual payment is a person's assertion, and calling it anything else would be
  // dishonest. A gateway claim starts PENDING and only becomes VERIFIED through the
  // explicit reconciliation step.
  const verification = input['source'] === 'GATEWAY' ? 'PENDING' : 'UNVERIFIED'

  try {
    const created = await paymentModel().create({
      hospitalId: safeId(actor.hospitalId),
      invoiceId: invoice['_id'],
      patientId: invoice['patientId'],
      kind: input['kind'],
      amountMinor: input['amountMinor'],
      method: input['method'],
      source: input['source'],
      verification,
      reference: input['reference'],
      idempotencyKey: input['idempotencyKey'],
      refundsPaymentId: input['refundsPaymentId'],
      occurredAt: input['occurredAt'],
      recordedByUserId: safeId(actor.userId),
    })

    return { row: toRow(created), replayed: false }
  } catch (error) {
    const duplicate =
      typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000

    if (duplicate && input['idempotencyKey']) {
      const [existing] = await findMany(
        paymentModel(),
        { idempotencyKey: input['idempotencyKey'] },
        1,
      )
      if (existing) return { row: existing, replayed: true }
    }

    throw error
  }
}

function samePayload(existing: Row, fingerprint: Row): boolean {
  return (
    String(existing['invoiceId']) === String(fingerprint['invoiceId']) &&
    String(existing['kind']) === String(fingerprint['kind']) &&
    num(existing['amountMinor']) === num(fingerprint['amountMinor']) &&
    String(existing['method']) === String(fingerprint['method']) &&
    (existing['reference'] ?? null) === fingerprint['reference']
  )
}

/**
 * A payment may not exceed what is outstanding.
 *
 * Allowed to exactly settle, refused beyond it. An overpayment is almost always a typo, and
 * accepting it silently means the next refund has to reconcile against a balance nobody
 * expected.
 */
async function validatePaymentAgainstInvoice(
  invoice: Row,
  amountMinor: number,
  actor: BillingActor,
): Promise<void> {
  const payments = await paymentsFor(actor, String(invoice['_id']))

  const settled = payments
    .filter((payment) => payment['kind'] === 'PAYMENT')
    .reduce((sum, payment) => sum + num(payment['amountMinor']), 0)
  const refunded = payments
    .filter((payment) => payment['kind'] === 'REFUND')
    .reduce((sum, payment) => sum + num(payment['amountMinor']), 0)

  const outstanding = num(invoice['totalMinor']) - (settled - refunded)

  if (amountMinor > outstanding) {
    throw ApiError.badRequest(
      `That is more than the outstanding balance of ${outstanding}. Record the exact amount, or refund first if this is a correction.`,
      [{ path: 'amountMinor', message: `Outstanding balance is ${outstanding} minor units` }],
    )
  }
}

async function validateRefund(
  _actor: BillingActor,
  input: { refundsPaymentId?: string },
  amountMinor: number,
): Promise<void> {
  if (!input.refundsPaymentId) {
    throw ApiError.badRequest('A refund must name the payment it reverses')
  }

  const [original] = await findMany(paymentModel(), { _id: safeId(input.refundsPaymentId) }, 1)
  if (!original) throw ApiError.notFound()
  if (original['kind'] !== 'PAYMENT') {
    throw ApiError.badRequest('Only a payment can be refunded, not another refund')
  }

  const priorRefunds = await findMany(paymentModel(), { refundsPaymentId: safeId(input.refundsPaymentId) }, 100)
  const already = priorRefunds.reduce((sum, payment) => sum + num(payment['amountMinor']), 0)

  if (already + amountMinor > num(original['amountMinor'])) {
    throw ApiError.badRequest(
      'That would refund more than the original payment received',
    )
  }
}

/**
 * Mark a gateway payment as reconciled.
 *
 * A separate verb, never a field on the create call, so "verified" is always an event
 * somebody performed and always names who performed it.
 */
export async function verifyPayment(
  actor: BillingActor,
  meta: Meta,
  paymentId: string,
  input: { reference?: string },
): Promise<unknown> {
  const [payment] = await findMany(paymentModel(), { _id: safeId(paymentId) }, 1)
  if (!payment) throw ApiError.notFound()

  if (payment['verification'] === 'VERIFIED') {
    throw ApiError.conflict('This payment is already verified')
  }

  await paymentModel().updateOne(
    { _id: safeId(paymentId) },
    {
      $set: {
        verification: 'VERIFIED',
        verifiedByUserId: safeId(actor.userId),
        verifiedAt: new Date(),
        ...(input.reference ? { reference: input.reference } : {}),
      },
    },
  )

  await audit(AUDIT_ACTIONS.PAYMENT_VERIFIED, actor, meta, paymentId)

  const [row] = await findMany(paymentModel(), { _id: safeId(paymentId) }, 1)
  return toPayment(row ?? payment)
}

export async function listPayments(
  _actor: BillingActor,
  _meta: Meta,
  query: Row,
): Promise<unknown> {
  const page = Number(query['page'] ?? 1)
  const pageSize = Number(query['pageSize'] ?? 20)

  const match: Row = {}
  if (query['invoiceId']) match['invoiceId'] = new Types.ObjectId(String(query['invoiceId']))
  if (query['patientId']) match['patientId'] = new Types.ObjectId(String(query['patientId']))
  if (query['method']) match['method'] = String(query['method'])
  if (query['source']) match['source'] = String(query['source'])
  if (query['verification']) match['verification'] = String(query['verification'])

  if (query['from'] || query['to']) {
    const range: Row = {}
    if (query['from']) range['$gte'] = new Date(`${String(query['from'])}T00:00:00.000Z`)
    if (query['to']) range['$lte'] = new Date(`${String(query['to'])}T23:59:59.999Z`)
    match['occurredAt'] = range
  }

  const rows = await findPageViaAggregate<Row>(paymentModel(), {
    match,
    sort: { occurredAt: -1 },
    skip: (page - 1) * pageSize,
    limit: pageSize,
  })
  const total = await countViaAggregate(paymentModel(), match)

  return {
    items: await decoratePayments(rows),
    page: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}

async function decoratePayments(rows: Row[]): Promise<Row[]> {
  const ids = uniqueIds(rows.map((row) => row['recordedByUserId']))
  const users = ids.length ? await findMany(userModel(), { _id: { $in: ids } }, 500) : []

  const names = new Map(
    users.map((row) => [
      String(row['_id']),
      [row['firstName'], row['lastName']].filter(Boolean).join(' '),
    ]),
  )

  return rows.map((row) => ({
    ...toPayment(row),
    recordedByName: names.get(String(row['recordedByUserId'])) ?? null,
  }))
}

// ───────────────────────────── helpers ─────────────────────────────

async function requirePatient(patientId: string): Promise<void> {
  const [patient] = await findMany(patientModel(), { _id: safeId(patientId) }, 1)
  // 404 rather than 403: the tenant plugin has already scoped this, so "not found" covers
  // both "no such patient" and "not your patient" and tells a prober nothing.
  if (!patient) throw ApiError.notFound()
}

function uniqueIds(values: unknown[]): Types.ObjectId[] {
  const seen = new Set<string>()
  const ids: Types.ObjectId[] = []

  for (const value of values) {
    const id = String(value)
    if (id === 'null' || id === 'undefined' || seen.has(id)) continue
    if (!Types.ObjectId.isValid(id)) continue
    seen.add(id)
    ids.push(new Types.ObjectId(id))
  }

  return ids
}

/**
 * Day bounds in the hospital's zone, for report queries.
 *
 * Exported so the reports module derives its ranges the same way billing does, rather than
 * each guessing where a local day starts.
 */
export function dayBounds(dateKey: string, timezone: string): { start: Date; end: Date } {
  return localDayBounds(new Date(`${dateKey}T00:00:00.000Z`), timezone)
}

export { DEFAULT_CURRENCY, parseAmountToMinorUnits, can, loadSettings }