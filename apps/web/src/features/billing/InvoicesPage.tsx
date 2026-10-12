import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Download, Plus, Receipt } from 'lucide-react'
import { formatMinorUnits } from '@infinigrow/shared'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { Modal } from '../../components/ui/Modal.js'
import { Select } from '../../components/ui/Select.js'
import { Textarea } from '../../components/ui/Textarea.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { LoadingState } from '../../components/states/LoadingState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'
import { useParams } from 'react-router-dom'

import {
  createInvoice,
  downloadDocument,
  fetchInvoice,
  fetchInvoices,
  fetchServices,
  issueInvoice,
  PAYMENT_METHOD_OPTIONS,
  paymentIdempotencyKey,
  recordPayment,
  voidInvoice,
  type Invoice,
} from './api.js'

/**
 * Invoices.
 *
 * Two things this screen refuses to do:
 *
 * 1. **It never computes a total.** Amounts are entered in whole currency units and
 *    converted by a rounding-free shift; every total shown comes from the server. A UI
 *    that adds up line items itself will eventually disagree with the invoice it is
 *    previewing, and the person checking the figure will trust the screen.
 * 2. **It never offers a card number field.** `reference` takes a receipt or UPI reference.
 *    Nothing this system needs requires storing card data, and storing it would turn a
 *    breach into a PCI-DSS scope problem.
 */

export function InvoicesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const canWrite = user !== null && hasPermission(user, 'billing:write')

  const status = searchParams.get('status') ?? ''
  const [creating, setCreating] = useState(false)

  const invoices = useQuery({
    queryKey: ['hospital', 'invoices', status],
    queryFn: ({ signal }) =>
      fetchInvoices({ status: status || undefined, pageSize: 25 }, signal),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['hospital'] })
  }

  const rows = invoices.data?.items ?? []

  const columns: Column<Invoice>[] = [
    {
      key: 'number',
      header: 'Invoice',
      cell: (row) => (
        <div className="min-w-0">
          <a
            href={`/invoices/${row.id}`}
            className="truncate font-medium text-brand-700 underline-offset-4 hover:underline"
          >
            {row.number}
          </a>
          <p className="truncate text-xs text-ink-subtle">{row.issueDate}</p>
        </div>
      ),
    },
    {
      key: 'patient',
      header: 'Patient',
      cell: (row) => (
        <span className="truncate text-sm text-ink-muted">{row.patientLabel ?? '—'}</span>
      ),
    },
    {
      key: 'total',
      header: 'Total',
      cell: (row) => (
        <span className="whitespace-nowrap font-medium">
          {formatMinorUnits(row.totalMinor, row.currency)}
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Balance',
      cell: (row) => (
        <span
          className={`whitespace-nowrap ${
            row.balanceMinor === 0 ? 'text-ink-subtle' : 'font-medium'
          }`}
        >
          {row.balanceMinor === 0
            ? 'Settled'
            : formatMinorUnits(row.balanceMinor, row.currency)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge tone={row.status === 'ISSUED' ? 'success' : row.status === 'VOID' ? 'danger' : 'info'}>
          {row.status === 'ISSUED' ? 'Issued' : row.status === 'VOID' ? 'Void' : 'Draft'}
        </Badge>
      ),
    },
  ]

  return (
    <AppShell
      title="Invoices"
      breadcrumbs={[{ label: 'Finance' }, { label: 'Invoices' }]}
      wide
      actions={
        canWrite ? (
          <Button leadingIcon={<Plus aria-hidden="true" className="size-4" />} onClick={() => setCreating(true)}>
            New invoice
          </Button>
        ) : undefined
      }
    >
      <Card>
        <CardHeader
          title="Every invoice this hospital has raised"
          description="Totals are computed by the server, not by this screen."
          actions={
            <>
              <label htmlFor="invoice-status" className="sr-only">
                Status
              </label>
              <select
                id="invoice-status"
                value={status}
                onChange={(event) => {
                  const next = new URLSearchParams(searchParams)
                  if (event.target.value === '') next.delete('status')
                  else next.set('status', event.target.value)
                  setSearchParams(next)
                }}
                className="rounded-md border border-line px-3 py-2 text-sm"
              >
                <option value="">All statuses</option>
                <option value="DRAFT">Draft</option>
                <option value="ISSUED">Issued</option>
                <option value="VOID">Void</option>
              </select>
            </>
          }
        />

        {invoices.isPending ? (
          <TableSkeleton rows={5} columns={columns.length} caption="Invoices raised by this hospital" />
        ) : invoices.isError ? (
          <CardBody>
            <ErrorState
              title="Could not load invoices"
              message={
                invoices.error instanceof ApiClientError
                  ? invoices.error.message
                  : 'The invoices could not be retrieved.'
              }
              onRetry={() => void invoices.refetch()}
              retrying={invoices.isFetching}
            />
          </CardBody>
        ) : rows.length === 0 ? (
          <CardBody>
            <EmptyState
              icon={<Receipt aria-hidden="true" className="size-10" />}
              title={status ? 'Nothing with that status' : 'No invoices yet'}
              description={
                status
                  ? 'Try a different status.'
                  : 'Raise an invoice against services from the catalogue.'
              }
              action={
                canWrite && !status ? <Button onClick={() => setCreating(true)}>New invoice</Button> : undefined
              }
            />
          </CardBody>
        ) : (
          <DataTable
            caption="Invoices raised by this hospital, with totals and outstanding balances"
            columns={columns}
            items={rows}
            rowKey={(row) => row.id}
          />
        )}
      </Card>

      {creating ? (
        <NewInvoiceDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            refresh()
          }}
        />
      ) : null}
    </AppShell>
  )
}

// ───────────────────────── new invoice ─────────────────────────

function NewInvoiceDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [patientId, setPatientId] = useState('')
  const [patientQuery, setPatientQuery] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const patients = useQuery({
    queryKey: ['hospital', 'patients', 'invoice-picker', patientQuery],
    queryFn: async ({ signal }) => {
      const { fetchPatients } = await import('../clinic/api.js')
      return fetchPatients({ pageSize: 20, q: patientQuery || undefined }, signal)
    },
  })

  const services = useQuery({
    queryKey: ['hospital', 'services', 'invoice-picker'],
    queryFn: ({ signal }) => fetchServices({ isActive: true, pageSize: 50 }, signal),
  })

  const create = useMutation({
    mutationFn: () =>
      createInvoice({
        patientId,
        // Only line items. No total — the server computes every figure, and there is
        // nothing here that could be mistaken for one.
        lines: [{ serviceId, quantity: Math.max(1, Number(quantity) || 1) }],
        notes: notes.trim() || undefined,
      }),
    onSuccess: onCreated,
    onError: (cause) =>
      setError(
        cause instanceof ApiClientError ? cause.message : 'The invoice could not be created.',
      ),
  })

  const valid = patientId !== '' && serviceId !== ''

  return (
    <Modal
      open
      onClose={onClose}
      title="New invoice"
      description="One line for now. The total is worked out by the server."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={create.isPending} disabled={!valid} onClick={() => create.mutate()}>
            Create draft
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" title="Could not create the invoice">
          {error}
        </Alert>
      ) : null}

      <div className="space-y-4">
        <FormField label="Patient" required>
          {({ id }) => (
            <>
              <Input
                id={id}
                value={patientQuery}
                placeholder="Filter patients…"
                onChange={(event) => setPatientQuery(event.target.value)}
                className="mb-2"
              />
              <Select
                aria-label="Choose a patient"
                placeholder={patients.isPending ? 'Loading patients…' : 'Select a patient'}
                options={(patients.data?.items ?? []).map((patient) => ({
                  value: patient.id,
                  label: `${patient.patientNumber} — ${patient.firstName} ${patient.lastName}`,
                }))}
                value={patientId}
                onChange={(event) => setPatientId(event.target.value)}
              />
            </>
          )}
        </FormField>

        <FormField label="Service" required>
          {({ id }) => (
            <Select
              id={id}
              placeholder={services.isPending ? 'Loading services…' : 'Select a service'}
              options={(services.data?.items ?? []).map((service) => ({
                value: service.id,
                label: `${service.name} — ${formatMinorUnits(service.unitPriceMinor, 'INR')}`,
              }))}
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
            />
          )}
        </FormField>

        <FormField label="Quantity" required>
          {({ id }) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={1000}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          )}
        </FormField>

        <FormField label="Notes">
          {({ id }) => (
            <Textarea
              id={id}
              rows={2}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </FormField>
      </div>
    </Modal>
  )
}

// ───────────────────────── one invoice ─────────────────────────

export function InvoiceDetailPage() {
  const { invoiceId = '' } = useParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const canBill = user !== null && hasPermission(user, 'billing:write')
  const canPay = user !== null && hasPermission(user, 'payment:write')

  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [voiding, setVoiding] = useState(false)

  const invoice = useQuery({
    queryKey: ['hospital', 'invoice', invoiceId],
    queryFn: ({ signal }) => fetchInvoice(invoiceId, signal),
    enabled: invoiceId !== '',
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['hospital'] })
  }

  const issue = useMutation({
    mutationFn: () => issueInvoice(invoiceId),
    onSuccess: () => {
      setNotice('Invoice issued. It can no longer be edited — void it and raise a new one to correct it.')
      refresh()
    },
    onError: (cause) =>
      setActionError(
        cause instanceof ApiClientError ? cause.message : 'The invoice could not be issued.',
      ),
  })

  const download = useMutation({
    mutationFn: () =>
      downloadDocument(`/invoices/${invoiceId}/document`, `invoice-${invoiceId}.pdf`),
    onSuccess: () => setNotice('Invoice downloaded.'),
    onError: (cause) =>
      setActionError(
        cause instanceof ApiClientError ? cause.message : 'The document could not be downloaded.',
      ),
  })

  if (invoice.isPending) {
    return (
      <AppShell title="Invoice" breadcrumbs={[{ label: 'Invoices' }, { label: 'Loading' }]}>
        <LoadingState label="Loading the invoice…" />
      </AppShell>
    )
  }

  if (invoice.isError) {
    return (
      <AppShell title="Invoice" breadcrumbs={[{ label: 'Invoices' }, { label: 'Not found' }]}>
        <Card>
          <CardBody>
            <ErrorState
              title="Could not load this invoice"
              message={
                invoice.error instanceof ApiClientError
                  ? invoice.error.message
                  : 'The invoice could not be retrieved.'
              }
              onRetry={() => void invoice.refetch()}
              retrying={invoice.isFetching}
            />
          </CardBody>
        </Card>
      </AppShell>
    )
  }

  const data = invoice.data
  const issued = data.status === 'ISSUED'
  const voided = data.status === 'VOID'

  return (
    <AppShell
      title={data.number}
      breadcrumbs={[{ label: 'Invoices', to: '/invoices' }, { label: data.number }]}
      wide
    >
      <div className="space-y-5">
        {notice ? (
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        ) : null}
        {actionError ? (
          <Alert tone="danger" title="Action failed" onDismiss={() => setActionError(null)}>
            {actionError}
          </Alert>
        ) : null}

        <Card>
          <CardHeader
            title={`${data.number} — ${data.patientLabel ?? 'Unknown patient'}`}
            description={`${data.issueDate} · ${data.currency}`}
            actions={
              <div className="flex flex-wrap gap-2">
                <Badge tone={issued ? 'success' : voided ? 'danger' : 'info'}>
                  {issued ? 'Issued' : voided ? 'Void' : 'Draft'}
                </Badge>
                {canBill && !issued && !voided ? (
                  <Button busy={issue.isPending} onClick={() => issue.mutate()}>
                    Issue
                  </Button>
                ) : null}
                {canBill && issued ? (
                  <Button busy={download.isPending} onClick={() => download.mutate()} leadingIcon={<Download aria-hidden="true" className="size-4" />}>
                    Download PDF
                  </Button>
                ) : null}
                {canBill && issued ? (
                  <Button variant="outline" onClick={() => setVoiding(true)}>
                    Void
                  </Button>
                ) : null}
              </div>
            }
          />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
              <Figure label="Subtotal" value={formatMinorUnits(data.subtotalMinor, data.currency)} />
              {data.discountMinor > 0 ? (
                <Figure label="Discount" value={`- ${formatMinorUnits(data.discountMinor, data.currency)}`} />
              ) : null}
              <Figure label="Tax" value={formatMinorUnits(data.taxMinor, data.currency)} />
              <Figure label="Total" value={formatMinorUnits(data.totalMinor, data.currency)} emphasis />
              <Figure label="Paid" value={formatMinorUnits(data.paidMinor, data.currency)} />
              <Figure
                label="Balance due"
                value={
                  data.balanceMinor === 0
                    ? 'Settled'
                    : formatMinorUnits(data.balanceMinor, data.currency)
                }
                emphasis
              />
            </dl>

            {voided && data.voidReason ? (
              <Alert tone="warning" title="This invoice was voided">
                {data.voidReason}
              </Alert>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Charges" description="As priced by the server." />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Charges on this invoice, with the quantity, unit price, discount, tax and line total
              </caption>
              <thead className="border-b border-line bg-canvas text-left text-xs uppercase tracking-wide text-ink-subtle">
                <tr>
                  <th scope="col" className="px-5 py-2 font-medium">Description</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Qty</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Unit</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Tax</th>
                  <th scope="col" className="px-5 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((line, index) => (
                  <tr key={`${line.description}-${index}`} className="border-b border-line last:border-0">
                    <td className="px-5 py-2">
                      {line.description}
                      {line.code ? (
                        <span className="ml-2 font-mono text-xs text-ink-subtle">{line.code}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">{line.quantity}</td>
                    <td className="px-3 py-2 text-right">
                      {formatMinorUnits(line.unitPriceMinor, data.currency)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {formatMinorUnits(line.taxMinor, data.currency)}
                    </td>
                    <td className="px-5 py-2 text-right font-medium">
                      {formatMinorUnits(line.totalMinor, data.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Payments"
            description="What was recorded, and how it was verified."
            actions={
              canPay && issued && data.balanceMinor > 0 ? (
                <Button onClick={() => setPaying(true)}>Record a payment</Button>
              ) : undefined
            }
          />
          <CardBody>
            {data.payments.length === 0 ? (
              <EmptyState title="Nothing recorded" description="No payment has been taken against this invoice." />
            ) : (
              <ul className="space-y-3">
                {data.payments.map((payment) => (
                  <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3 last:border-0 last:pb-0">
                    <div>
                      <p className="text-sm font-medium">
                        {payment.kind === 'REFUND' ? 'Refund' : 'Payment'} —{' '}
                        {formatMinorUnits(payment.amountMinor, data.currency)}
                      </p>
                      <p className="text-xs text-ink-subtle">
                        {payment.method.replace('_', ' ').toLowerCase()} ·{' '}
                        {new Date(payment.occurredAt).toLocaleString()}
                        {payment.reference ? ` · ${payment.reference}` : ''}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Badge tone={payment.source === 'GATEWAY' ? 'info' : 'neutral'}>
                        {payment.source === 'GATEWAY' ? 'Gateway claim' : 'Recorded by staff'}
                      </Badge>
                      <Badge
                        tone={
                          payment.verification === 'VERIFIED'
                            ? 'success'
                            : payment.verification === 'PENDING'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {payment.verification === 'VERIFIED' ? 'Verified' : payment.verification === 'PENDING' ? 'Unreconciled' : 'Unverified'}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {paying ? (
        <RecordPaymentDialog
          invoice={data}
          onClose={() => setPaying(false)}
          onDone={(message) => {
            setPaying(false)
            setNotice(message)
            refresh()
          }}
        />
      ) : null}

      {voiding ? (
        <VoidDialog
          invoice={data}
          onClose={() => setVoiding(false)}
          onDone={(message) => {
            setVoiding(false)
            setNotice(message)
            refresh()
          }}
        />
      ) : null}
    </AppShell>
  )
}

function Figure({
  label,
  value,
  emphasis,
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className={`mt-1 ${emphasis ? 'text-base font-semibold' : 'text-sm'}`}>{value}</dd>
    </div>
  )
}

// ───────────────────────── record a payment ─────────────────────────

function RecordPaymentDialog({
  invoice,
  onClose,
  onDone,
}: {
  invoice: Invoice
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [amount, setAmount] = useState(String(invoice.balanceMinor / 100))
  const [method, setMethod] = useState('CASH')
  const [reference, setReference] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const amountMinor = Math.round(Number(amount) * 100)

  /**
   * ONE key per invoice+amount, not per submit.
   *
   * Regenerating on every attempt would make the idempotency key protect against nothing —
   * a double-click would produce two keys and two charges. Stable here means a retry of the
   * same logical payment replays, while a different amount is a different payment.
   */
  const idempotencyKey = paymentIdempotencyKey(invoice.id, amountMinor)

  const pay = useMutation({
    mutationFn: () =>
      recordPayment(
        invoice.id,
        {
          amountMinor,
          method,
          // A receipt or UPI reference — never a card number, which this system has no
          // field for and must not acquire.
          reference: reference.trim() || undefined,
        },
        idempotencyKey,
      ),
    onSuccess: (result) =>
      onDone(
        result.replayed
          ? 'That payment was already recorded — nothing was charged twice.'
          : 'Payment recorded.',
      ),
    onError: (cause) =>
      setLocalError(
        cause instanceof ApiClientError ? cause.message : 'The payment could not be recorded.',
      ),
  })

  const valid = Number.isFinite(amountMinor) && amountMinor > 0 && amountMinor <= invoice.balanceMinor

  return (
    <Modal
      open
      onClose={onClose}
      title="Record a payment"
      description={`Outstanding: ${formatMinorUnits(invoice.balanceMinor, invoice.currency)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={pay.isPending} disabled={!valid} onClick={() => pay.mutate()}>
            Record payment
          </Button>
        </>
      }
    >
      {localError ? (
        <Alert tone="danger" title="Could not record the payment">
          {localError}
        </Alert>
      ) : null}

      <div className="space-y-4">
        <FormField
          label="Amount"
          required
          hint={`Whole currency units. At most ${formatMinorUnits(invoice.balanceMinor, invoice.currency)}.`}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          )}
        </FormField>

        <FormField label="Method" required>
          {({ id }) => (
            <Select
              id={id}
              options={PAYMENT_METHOD_OPTIONS}
              value={method}
              onChange={(event) => setMethod(event.target.value)}
            />
          )}
        </FormField>

        <FormField
          label="Reference"
          hint="Receipt number, UPI reference or cheque number. Never a card number."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={reference}
              maxLength={200}
              onChange={(event) => setReference(event.target.value)}
            />
          )}
        </FormField>

        <Alert tone="info" title="This will be marked unverified">
          A payment recorded by staff is somebody&rsquo;s assertion that money changed hands.
          It is not a confirmed settlement, and reports keep it separate from reconciled
          gateway money.
        </Alert>
      </div>
    </Modal>
  )
}

function VoidDialog({
  invoice,
  onClose,
  onDone,
}: {
  invoice: Invoice
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [reason, setReason] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const void_ = useMutation({
    mutationFn: () => voidInvoice(invoice.id, reason),
    onSuccess: () => onDone('Invoice voided. The record is kept, with your reason.'),
    onError: (cause) =>
      setLocalError(
        cause instanceof ApiClientError ? cause.message : 'The invoice could not be voided.',
      ),
  })

  return (
    <Modal
      open
      onClose={onClose}
      title="Void this invoice?"
      description="The record is kept, with your reason. It is not deleted."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            busy={void_.isPending}
            disabled={reason.trim().length < 10}
            onClick={() => void_.mutate()}
          >
            Void invoice
          </Button>
        </>
      }
    >
      {localError ? (
        <Alert tone="danger" title="Could not void the invoice">
          {localError}
        </Alert>
      ) : null}

      <FormField
        label="Why is it being voided?"
        required
        hint="Recorded permanently. At least 10 characters."
      >
        {({ id, describedBy, invalid }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </FormField>
    </Modal>
  )
}