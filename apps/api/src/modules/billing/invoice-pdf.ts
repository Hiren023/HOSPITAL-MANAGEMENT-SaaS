import { formatMinorUnits, type CurrencySpec } from '@infinigrow/shared'

import { renderPdf, wrap, type PdfLine } from '../clinical/pdf.js'
import { localFileStore } from '../clinical/file-store.js'

import { ClinicalDocumentModel } from '../clinical/clinical.models.js'

/**
 * Printable invoice.
 *
 * ── It is a legal document, so it shows everything a reader needs to check it ─────
 *
 * The invoice number, the date, the patient, every line with its own arithmetic, the
 * totals, the amount settled, the balance due, and the currency. An invoice that shows a
 * total without showing how it was reached is not something anyone can query when it is
 * wrong — and it will be wrong eventually.
 *
 * The currency code is printed on EVERY line, not only in the header. A line that reads
 * "₹ 250.00" next to "Tax 18%" is ambiguous if the reader does not know the currency, and
 * an ambiguous invoice is how a pharmacy order for the wrong drug happens.
 *
 * Private storage, authorized download — the same arrangement as a prescription. See
 * `docs/ARCHITECTURE.md` §3.9 for why a URL would be the wrong answer.
 */

interface InvoiceForPdf {
  number: string
  issueDate: string
  currency: string
  patientLabel: string | null
  status: string
  lines: Record<string, unknown>[]
  subtotalMinor: number
  discountMinor: number
  taxableMinor: number
  taxMinor: number
  totalMinor: number
  paidMinor: number
  balanceMinor: number
  notes: string | null
  hospitalName: string | null
}

const LINE_WIDTH = 78

function money(amountMinor: number, spec: CurrencySpec): string {
  // The bare number and the code, not a symbol. On a document that may be photocopied,
  // printed on a fax machine, or read by someone whose system lacks the symbol font, a
  // currency CODE is unambiguous where a symbol is not.
  const formatted = formatMinorUnits(amountMinor, spec.code)
  return `${formatted} ${spec.code}`
}

export function buildInvoicePdf(invoice: InvoiceForPdf, spec: CurrencySpec): PdfLine[] {
  const lines: PdfLine[] = []
  const emit = (text: string, bold = false, gapAfter = 2, size = 10) => {
    for (const chunk of wrap(text, LINE_WIDTH)) lines.push({ text: chunk, bold, gapAfter, size })
  }

  emit(invoice.hospitalName ?? 'Hospital', true, 2, 16)
  emit('INVOICE', true, 6, 20)
  emit(`Invoice number: ${invoice.number}`, false, 2)
  emit(`Date: ${invoice.issueDate}`, false, 2)
  emit(`Status: ${invoice.status}`, false, 2)
  emit(`Patient: ${invoice.patientLabel ?? '—'}`, false, 2)
  emit(`Currency: ${spec.code}`, false, 10)

  emit('Charges', true, 6, 12)

  for (const [index, line] of invoice.lines.entries()) {
    const description = String(line['description'] ?? '')
    const quantity = Number(line['quantity'] ?? 1)
    const unitPrice = Number(line['unitPriceMinor'] ?? 0)
    const discountBps = Number(line['discountBps'] ?? 0)
    const taxBps = Number(line['taxBps'] ?? 0)

    emit(`${index + 1}. ${description}`, true, 2)

    emit(
      `   ${quantity} x ${money(unitPrice, spec)}  =  ${money(Number(line['subtotalMinor'] ?? 0), spec)}`,
      false,
      2,
    )

    if (discountBps > 0) {
      emit(
        `   Discount ${(discountBps / 100).toFixed(2)}%  -  ${money(Number(line['discountMinor'] ?? 0), spec)}`,
        false,
        2,
      )
    }

    if (taxBps > 0) {
      const inclusive = Boolean(line['taxInclusive'])
      emit(
        `   Tax ${(taxBps / 100).toFixed(2)}%${inclusive ? ' (included)' : ''}  =  ${money(Number(line['taxMinor'] ?? 0), spec)}`,
        false,
        2,
      )
    }

    emit(`   Line total: ${money(Number(line['totalMinor'] ?? 0), spec)}`, false, 6)
  }

  emit('Totals', true, 6, 12)
  emit(`Subtotal: ${money(invoice.subtotalMinor, spec)}`)
  emit(`Discount: ${money(invoice.discountMinor, spec)}`)
  emit(`Taxable: ${money(invoice.taxableMinor, spec)}`)
  emit(`Tax: ${money(invoice.taxMinor, spec)}`)
  emit(`TOTAL: ${money(invoice.totalMinor, spec)}`, true, 6, 12)
  emit(`Paid: ${money(invoice.paidMinor, spec)}`)
  emit(`Balance due: ${money(invoice.balanceMinor, spec)}`, true, 10, 12)

  if (invoice.notes) {
    emit('Notes', true, 6, 11)
    emit(invoice.notes, false, 10)
  }

  emit('Amounts are shown in whole currency units. This document is a record of charges', false, 2, 8)
  emit('issued by the hospital above and is not a payment credential.', false, 8, 8)

  return lines
}

export function renderInvoicePdf(invoice: InvoiceForPdf, spec: CurrencySpec): Uint8Array {
  return renderPdf(buildInvoicePdf(invoice, spec))
}

/**
 * Generate and store an invoice PDF.
 *
 * Stored under a private key like any other clinical document, and referenced by id. No
 * URL is returned; bytes leave through an authorized route that re-checks permission.
 */
export async function generateInvoiceDocument(input: {
  hospitalId: string
  userId: string
  invoiceId: string
  invoice: InvoiceForPdf
  spec: CurrencySpec
}): Promise<{ documentId: string; byteSize: number }> {
  const pdf = renderInvoicePdf(input.invoice, input.spec)
  const stored = await localFileStore.put({
    hospitalId: input.hospitalId,
    contentType: 'application/pdf',
    body: pdf,
  })

  const document = await (
    ClinicalDocumentModel as unknown as {
      create(input: Record<string, unknown>): Promise<{ _id: unknown }>
    }
  ).create({
    hospitalId: input.hospitalId,
    resourceType: 'INVOICE',
    resourceId: input.invoiceId,
    storageKey: stored.storageKey,
    fileName: `invoice-${input.invoice.number}.pdf`,
    contentType: 'application/pdf',
    byteSize: stored.byteSize,
    generatedByUserId: input.userId,
    generatedAt: new Date(),
  })

  return { documentId: String(document._id), byteSize: stored.byteSize }
}

export { localFileStore }