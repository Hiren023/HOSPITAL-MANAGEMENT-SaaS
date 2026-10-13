import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { currencySpec, objectIdSchema } from '@infinigrow/shared'

import { createTenantRouter } from '../../infrastructure/tenant-router.js'
import { requirePermission } from '../../middleware/auth.js'
import { validate } from '../../validation/validate.js'

import {
  createInvoiceSchema,
  createServiceSchema,
  invoiceListQuerySchema,
  paymentListQuerySchema,
  recordPaymentSchema,
  serviceListQuerySchema,
  updateServiceSchema,
  verifyPaymentSchema,
  voidInvoiceSchema,
} from './billing.schemas.js'
import {
  createInvoice,
  createService,
  issueInvoice,
  listInvoices,
  listPayments,
  listServices,
  readInvoice,
  recordPayment,
  updateService,
  verifyPayment,
  voidInvoice,
  type BillingActor,
  type Meta,
} from './billing.service.js'
import { generateInvoiceDocument } from './invoice-pdf.js'
import { ClinicalDocumentModel } from '../clinical/clinical.models.js'
import { localFileStore } from '../clinical/file-store.js'

/**
 * Billing routes.
 *
 * Tenant-scoped by the registrar, like every other hospital surface.
 *
 * `billing:read` to look, `billing:write` to charge. Payment recording needs
 * `payment:write` — deliberately a different permission from `billing:write`, so a role
 * can be allowed to raise an invoice without being allowed to record that it was paid.
 * Conflating them would mean anyone who can bill can also write off a balance by marking
 * it settled.
 */
const { router: billingRouter, route } = createTenantRouter({ module: 'BILLING' })

export { billingRouter }

function actorOf(req: Request): BillingActor {
  const auth = req.auth as unknown as BillingActor
  return {
    userId: auth.userId,
    role: auth.role,
    hospitalId: auth.hospitalId,
    permissions: auth.permissions,
  }
}

function metaOf(req: Request): Meta {
  return { ip: req.ip ?? '', requestId: req.requestId }
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next)
  }
}

function paramOf(req: Request, key: string): string {
  return String(req.params[key] ?? '')
}

function queryOf<T>(req: Request): T {
  return (req as Request & { validatedQuery?: T }).validatedQuery ?? ({} as T)
}

/**
 * `validate()` replaces `req.body` in place rather than writing a side channel — unlike
 * the query, which Express 5 makes a getter. Reading a `validatedBody` property would
 * silently be `undefined`.
 */
function bodyOf<T>(req: Request): T {
  return req.body as T
}

const serviceIdParams = z.object({ serviceId: objectIdSchema }).passthrough()
const invoiceIdParams = z.object({ invoiceId: objectIdSchema }).passthrough()
const paymentIdParams = z.object({ paymentId: objectIdSchema }).passthrough()

// ───────────────────────────── catalogue ─────────────────────────────

route(
  'get',
  '/services',
  requirePermission('billing:read'),
  validate({ query: serviceListQuerySchema }),
  handle(async (req, res) => {
    res.json({ data: await listServices(actorOf(req), metaOf(req), queryOf(req)) })
  }),
)

route(
  'post',
  '/services',
  requirePermission('billing:write'),
  validate({ body: createServiceSchema }),
  handle(async (req, res) => {
    const data = await createService(actorOf(req), metaOf(req), bodyOf(req))
    res.status(201).json({ data })
  }),
)

route(
  'patch',
  '/services/:serviceId',
  requirePermission('billing:write'),
  validate({ params: serviceIdParams, body: updateServiceSchema }),
  handle(async (req, res) => {
    const data = await updateService(actorOf(req), metaOf(req), paramOf(req, 'serviceId'), bodyOf(req))
    res.json({ data })
  }),
)

// ───────────────────────────── invoices ─────────────────────────────

route(
  'get',
  '/invoices',
  requirePermission('billing:read'),
  validate({ query: invoiceListQuerySchema }),
  handle(async (req, res) => {
    res.json({ data: await listInvoices(actorOf(req), metaOf(req), queryOf(req)) })
  }),
)

route(
  'post',
  '/invoices',
  requirePermission('billing:write'),
  validate({ body: createInvoiceSchema }),
  handle(async (req, res) => {
    const data = await createInvoice(actorOf(req), metaOf(req), bodyOf(req))
    res.status(201).json({ data })
  }),
)

route(
  'get',
  '/invoices/:invoiceId',
  requirePermission('billing:read'),
  validate({ params: invoiceIdParams }),
  handle(async (req, res) => {
    const data = await readInvoice(actorOf(req), metaOf(req), paramOf(req, 'invoiceId'))
    res.json({ data })
  }),
)

route(
  'post',
  '/invoices/:invoiceId/issue',
  requirePermission('billing:write'),
  validate({ params: invoiceIdParams }),
  handle(async (req, res) => {
    res.json({ data: await issueInvoice(actorOf(req), metaOf(req), paramOf(req, 'invoiceId')) })
  }),
)

route(
  'post',
  '/invoices/:invoiceId/void',
  requirePermission('billing:write'),
  validate({ params: invoiceIdParams, body: voidInvoiceSchema }),
  handle(async (req, res) => {
    const data = await voidInvoice(actorOf(req), metaOf(req), paramOf(req, 'invoiceId'), bodyOf(req))
    res.json({ data })
  }),
)

/**
 * Generate and download the printable invoice.
 *
 * A single route rather than "generate" then "download", so the document on disk is always
 * the one the caller was authorised to see at the moment they saw it. Generating on every
 * fetch also means a stale PDF cannot outlive a corrected invoice.
 *
 * Private, authorized download: `private, no-store` so an invoice does not linger in a
 * shared cache or a browser disk, and `attachment` so the browser does not render it
 * inline. See `docs/ARCHITECTURE.md` §3.9.
 */
route(
  'get',
  '/invoices/:invoiceId/document',
  requirePermission('billing:read'),
  validate({ params: invoiceIdParams }),
  handle(async (req, res) => {
    const actor = actorOf(req)
    const invoiceId = paramOf(req, 'invoiceId')

    const invoice = (await readInvoice(actor, metaOf(req), invoiceId)) as Record<string, unknown>
    const hospital = await (await import('../identity/models.js')).HospitalModel
    const hospitalRow = await (
      hospital as unknown as {
        findById(id: unknown): { lean(): { exec(): Promise<Record<string, unknown> | null> } }
      }
    )
      .findById(actor.hospitalId)
      .lean()
      .exec()

    const spec = currencySpec(String(invoice['currency']))

    const { documentId, byteSize } = await generateInvoiceDocument({
      hospitalId: actor.hospitalId,
      userId: actor.userId,
      invoiceId,
      invoice: {
        number: String(invoice['number']),
        issueDate: String(invoice['issueDate']),
        currency: String(invoice['currency']),
        patientLabel: (invoice['patientLabel'] as string | null) ?? null,
        status: String(invoice['status']),
        lines: (invoice['lines'] ?? []) as Record<string, unknown>[],
        subtotalMinor: Number(invoice['subtotalMinor'] ?? 0),
        discountMinor: Number(invoice['discountMinor'] ?? 0),
        taxableMinor: Number(invoice['taxableMinor'] ?? 0),
        taxMinor: Number(invoice['taxMinor'] ?? 0),
        totalMinor: Number(invoice['totalMinor'] ?? 0),
        paidMinor: Number(invoice['paidMinor'] ?? 0),
        balanceMinor: Number(invoice['balanceMinor'] ?? 0),
        notes: (invoice['notes'] as string | null) ?? null,
        hospitalName: (hospitalRow?.['name'] as string | undefined) ?? null,
      },
      spec,
    })

    const document = await (
      ClinicalDocumentModel as unknown as {
        findById(id: unknown): { lean(): { exec(): Promise<Record<string, unknown> | null> } }
      }
    )
      .findById(documentId)
      .lean()
      .exec()

    const bytes = await localFileStore.get(String(document?.['storageKey']))

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Length', String(bytes.byteLength))
    res.setHeader('Cache-Control', 'private, no-store, max-age=0')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="invoice-${String(invoice['number'])}.pdf"`,
    )
    void byteSize
    res.status(200).end(Buffer.from(bytes))
  }),
)

// ───────────────────────────── payments ─────────────────────────────

route(
  'get',
  '/payments',
  requirePermission('payment:read'),
  validate({ query: paymentListQuerySchema }),
  handle(async (req, res) => {
    res.json({ data: await listPayments(actorOf(req), metaOf(req), queryOf(req)) })
  }),
)

/**
 * Record a payment.
 *
 * Send an `Idempotency-Key` header and a retry becomes a replay: the original payment is
 * returned with `replayed: true` and nothing is charged twice. That is the difference
 * between a network hiccup and a double charge, and it is why the key is honoured here
 * rather than left to the client to manage.
 *
 * Returns 201 for a new payment and 200 for a replay, so the client can tell them apart
 * without inspecting the body.
 */
route(
  'post',
  '/payments',
  requirePermission('payment:write'),
  validate({ body: recordPaymentSchema }),
  handle(async (req, res) => {
    const idempotencyKey = req.get('Idempotency-Key')

    const result = (await recordPayment(
      actorOf(req),
      metaOf(req),
      bodyOf(req),
      idempotencyKey,
    )) as Record<string, unknown>

    res.status(result['replayed'] ? 200 : 201).json({ data: result })
  }),
)

/**
 * Mark a gateway payment as reconciled.
 *
 * A separate verb so that "verified" is always an event somebody performed, always names
 * who performed it, and can never be set by the same request that created the payment.
 */
route(
  'post',
  '/payments/:paymentId/verify',
  requirePermission('payment:write'),
  validate({ params: paymentIdParams, body: verifyPaymentSchema }),
  handle(async (req, res) => {
    const data = await verifyPayment(actorOf(req), metaOf(req), paramOf(req, 'paymentId'), bodyOf(req))
    res.json({ data })
  }),
)