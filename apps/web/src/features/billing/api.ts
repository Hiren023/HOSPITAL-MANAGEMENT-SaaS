import { apiClient, ApiClientError } from '../../lib/api-client.js'

/**
 * Billing and reporting.
 *
 * ── Amounts cross this boundary as integers ───────────────────────────────────
 *
 * `*Minor` fields are whole units of the currency's minor unit — paise for INR. There is
 * no float on this interface, and the UI formats for display with `formatMinorUnits`
 * rather than doing arithmetic. The server recomputes every total; nothing here sends one.
 *
 * The PDF and CSV are fetched with the access token rather than navigated to, because a
 * link or `window.open` would either drop the Authorization header or require a token in
 * the URL — and a token in a URL lands in browser history and proxy logs.
 */

export interface PageMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface Service {
  id: string
  code: string
  name: string
  description: string | null
  category: string
  unitPriceMinor: number
  taxBps: number
  taxInclusive: boolean
  isActive: boolean
}

export interface InvoiceLine {
  serviceId?: string
  code?: string
  description: string
  unitPriceMinor: number
  quantity: number
  discountBps: number
  taxBps: number
  taxInclusive: boolean
  subtotalMinor: number
  discountMinor: number
  taxableMinor: number
  taxMinor: number
  totalMinor: number
}

export interface Payment {
  id: string
  invoiceId: string
  patientId: string
  kind: 'PAYMENT' | 'REFUND'
  amountMinor: number
  method: string
  source: 'MANUAL' | 'GATEWAY'
  verification: 'UNVERIFIED' | 'PENDING' | 'VERIFIED'
  reference: string | null
  refundsPaymentId: string | null
  occurredAt: string
  recordedByUserId: string
  recordedByName: string | null
  verifiedByUserId: string | null
  verifiedAt: string | null
  createdAt: string
}

export interface Invoice {
  id: string
  number: string
  patientId: string
  patientLabel: string | null
  consultationId: string | null
  issueDate: string
  currency: string
  status: 'DRAFT' | 'ISSUED' | 'VOID'
  lines: InvoiceLine[]
  subtotalMinor: number
  discountMinor: number
  taxableMinor: number
  taxMinor: number
  totalMinor: number
  paidMinor: number
  refundedMinor: number
  balanceMinor: number
  notes: string | null
  issuedAt: string | null
  voidReason: string | null
  payments: Payment[]
  createdByUserId: string
  createdAt: string
}

/** The result of recording a payment: the invoice, plus whether this was a replay. */
export interface RecordPaymentResult extends Invoice {
  replayed: boolean
  payment: Payment
}

export interface RevenueBucket {
  key: string
  manualTotalMinor: number
  verifiedGatewayTotalMinor: number
  pendingGatewayTotalMinor: number
  refundedMinor: number
  paymentCount: number
  refundCount: number
}

export interface RevenueReport {
  granularity: 'daily' | 'monthly' | 'range'
  from: string
  to: string
  currency: string
  timezone: string
  series: RevenueBucket[]
  totals: {
    manualTotalMinor: number
    verifiedGatewayTotalMinor: number
    pendingGatewayTotalMinor: number
    refundedMinor: number
    settledTotalMinor: number
  }
  note: string
}

// ───────────────────────────── catalogue ─────────────────────────────

export function fetchServices(
  query: { q?: string; category?: string; isActive?: boolean; pageSize?: number },
  signal?: AbortSignal,
): Promise<{ items: Service[]; page: PageMeta }> {
  return apiClient.get('/services', {
    query: {
      ...query,
      isActive: query.isActive === undefined ? undefined : String(query.isActive),
    },
    signal,
  })
}

export function createService(input: {
  code: string
  name: string
  description?: string
  category?: string
  unitPriceMinor: number
  taxBps?: number
}): Promise<Service> {
  return apiClient.post('/services', input)
}

export function updateService(
  serviceId: string,
  input: Partial<Pick<Service, 'name' | 'description' | 'unitPriceMinor' | 'taxBps' | 'isActive'>>,
): Promise<Service> {
  return apiClient.patch(`/services/${serviceId}`, input)
}

// ───────────────────────────── invoices ─────────────────────────────

export function fetchInvoices(
  query: { patientId?: string; status?: string; pageSize?: number },
  signal?: AbortSignal,
): Promise<{ items: Invoice[]; page: PageMeta }> {
  return apiClient.get('/invoices', { query: { ...query }, signal })
}

export function fetchInvoice(invoiceId: string, signal?: AbortSignal): Promise<Invoice> {
  return apiClient.get(`/invoices/${invoiceId}`, { signal })
}

/**
 * Create an invoice from line items.
 *
 * Deliberately has no total parameter. The server recomputes every figure, and there is
 * nothing here that could be mistaken for a total the client believes in.
 */
export function createInvoice(input: {
  patientId: string
  lines: {
    serviceId?: string
    description?: string
    unitPriceMinor?: number
    quantity: number
    discountBps?: number
  }[]
  notes?: string
}): Promise<Invoice> {
  return apiClient.post('/invoices', input)
}

export function issueInvoice(invoiceId: string): Promise<Invoice> {
  return apiClient.post(`/invoices/${invoiceId}/issue`, {})
}

export function voidInvoice(invoiceId: string, reason: string): Promise<Invoice> {
  return apiClient.post(`/invoices/${invoiceId}/void`, { reason })
}

// ───────────────────────────── payments ─────────────────────────────

/**
 * Record a payment.
 *
 * Pass an idempotency key and a retry becomes a replay rather than a second charge. The
 * key is generated once per form, NOT per submit, so pressing the button twice is safe —
 * a key regenerated on each attempt would protect against nothing.
 */
export function recordPayment(
  invoiceId: string,
  input: {
    amountMinor: number
    method: string
    reference?: string
    kind?: 'PAYMENT' | 'REFUND'
    refundsPaymentId?: string
    source?: 'MANUAL' | 'GATEWAY'
  },
  idempotencyKey: string,
): Promise<RecordPaymentResult> {
  return apiClient.post(
    '/payments',
    { invoiceId, ...input },
    { headers: { 'Idempotency-Key': idempotencyKey } },
  )
}

export function verifyPayment(paymentId: string, reference?: string): Promise<Payment> {
  return apiClient.post(`/payments/${paymentId}/verify`, { reference })
}

/**
 * Download a generated PDF.
 *
 * Not a link. A URL for a financial document is a capability that outlives the permission
 * decision behind it, and a token in a query string leaks into history and referrers.
 */
export async function downloadDocument(path: string, fileName: string): Promise<void> {
  const token = apiClient.accessToken()

  const response = await fetch(`${apiClient.baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

  if (!response.ok) {
    throw new ApiClientError(
      response.status === 403
        ? 'FORBIDDEN'
        : response.status === 404
          ? 'NOT_FOUND'
          : 'INTERNAL_ERROR',
      response.status === 403 || response.status === 404
        ? 'You are not allowed to download this document.'
        : 'The document could not be downloaded.',
      response.status,
    )
  }

  saveBlob(await response.blob(), fileName)
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * A stable key for one payment attempt.
 *
 * Derived from the invoice and the amount, so the SAME logical payment retries with the
 * SAME key while two genuinely different payments get different ones. `crypto.randomUUID`
 * alone would be wrong: regenerating on every submit protects against nothing.
 */
export function paymentIdempotencyKey(invoiceId: string, amountMinor: number): string {
  const seed = `${invoiceId}:${amountMinor}:${Math.trunc(Date.now() / 60_000)}`
  return `web-${seed}`
}

// ───────────────────────────── reports ─────────────────────────────

export function fetchRevenue(
  query: { granularity: 'daily' | 'monthly' | 'range'; from: string; to: string },
  signal?: AbortSignal,
): Promise<RevenueReport> {
  return apiClient.get('/reports/revenue', { query: { ...query }, signal })
}

export async function downloadCsv(path: string, fileName: string): Promise<void> {
  const token = apiClient.accessToken()

  const response = await fetch(`${apiClient.baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

  if (!response.ok) {
    throw new ApiClientError(
      response.status === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
      response.status === 403
        ? 'You are not allowed to export this report.'
        : 'The export could not be generated.',
      response.status,
    )
  }

  saveBlob(await response.blob(), fileName)
}

export const PAYMENT_METHOD_OPTIONS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'UPI', label: 'UPI' },
  { value: 'CARD', label: 'Card' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'INSURANCE', label: 'Insurance' },
  { value: 'OTHER', label: 'Other' },
]

export const SERVICE_CATEGORY_OPTIONS = [
  { value: 'CONSULTATION', label: 'Consultation' },
  { value: 'PROCEDURE', label: 'Procedure' },
  { value: 'LABORATORY', label: 'Laboratory' },
  { value: 'IMAGING', label: 'Imaging' },
  { value: 'PHARMACY', label: 'Pharmacy' },
  { value: 'WARD', label: 'Ward' },
  { value: 'OTHER', label: 'Other' },
]

export { ApiClientError }