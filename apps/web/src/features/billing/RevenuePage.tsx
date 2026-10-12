import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Download, TrendingUp } from 'lucide-react'
import { formatMinorUnits } from '@infinigrow/shared'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { Input } from '../../components/ui/Input.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'

import { downloadCsv, fetchRevenue } from './api.js'

/**
 * Revenue.
 *
 * ── The split is the point of this screen ────────────────────────────────────
 *
 * There is no single "revenue" number, and that is deliberate. Three different facts are on
 * this page and collapsing them into one figure would be how a hospital ends up believing it
 * has money it does not:
 *
 * - **Recorded by staff** — a person asserted cash changed hands. Real money, not
 *   confirmed by any system.
 * - **Verified gateway** — a provider settlement a named person reconciled against a bank
 *   file. This is the only figure that is money in hand.
 * - **Unreconciled gateway** — a provider claims it; nobody has checked. Not yet revenue in
 *   any sense a treasurer would accept.
 *
 * The sum of the first two, minus refunds, is labelled `settled` rather than `revenue` so
 * its meaning is not in doubt.
 */
export function RevenuePage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const today = new Date()
  const defaultFrom = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  const granularity = (searchParams.get('granularity') ?? 'daily') as 'daily' | 'monthly'
  const from = searchParams.get('from') ?? defaultFrom
  const to = searchParams.get('to') ?? today.toISOString().slice(0, 10)

  const [exportError, setExportError] = useState<string | null>(null)

  const revenue = useQuery({
    queryKey: ['hospital', 'report', 'revenue', granularity, from, to],
    queryFn: ({ signal }) => fetchRevenue({ granularity, from, to }, signal),
  })

  const setParam = (changes: Record<string, string>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (value === '') next.delete(key)
      else next.set(key, value)
    }
    setSearchParams(next)
  }

  const exportCsv = useMutation({
    mutationFn: () =>
      downloadCsv(
        `/reports/revenue.csv?granularity=${granularity}&from=${from}&to=${to}`,
        `revenue-${from}-to-${to}.csv`,
      ),
    onSuccess: () => setExportError(null),
    onError: (cause) =>
      setExportError(
        cause instanceof ApiClientError ? cause.message : 'The export could not be generated.',
      ),
  })

  const data = revenue.data
  const series = data?.series ?? []

  return (
    <AppShell
      title="Revenue"
      breadcrumbs={[{ label: 'Finance' }, { label: 'Revenue' }]}
      wide
    >
      <div className="space-y-5">
        <Card>
          <CardHeader
            title="Revenue"
            description="Money taken, broken down by how it was recorded and whether it was verified."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="revenue-from" className="sr-only">
                  From
                </label>
                <Input
                  id="revenue-from"
                  type="date"
                  value={from}
                  aria-label="From date"
                  onChange={(event) => setParam({ from: event.target.value })}
                  className="w-auto"
                />
                <span className="text-sm text-ink-subtle">to</span>
                <label htmlFor="revenue-to" className="sr-only">
                  To
                </label>
                <Input
                  id="revenue-to"
                  type="date"
                  value={to}
                  aria-label="To date"
                  onChange={(event) => setParam({ to: event.target.value })}
                  className="w-auto"
                />

                <Button
                  size="sm"
                  variant={granularity === 'daily' ? 'primary' : 'secondary'}
                  onClick={() => setParam({ granularity: 'daily' })}
                >
                  Daily
                </Button>
                <Button
                  size="sm"
                  variant={granularity === 'monthly' ? 'primary' : 'secondary'}
                  onClick={() => setParam({ granularity: 'monthly' })}
                >
                  Monthly
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  busy={exportCsv.isPending}
                  onClick={() => exportCsv.mutate()}
                  leadingIcon={<Download aria-hidden="true" className="size-4" />}
                >
                  Export CSV
                </Button>
              </div>
            }
          />
          <CardBody>
            {exportError ? (
              <Alert tone="danger" title="Export failed" onDismiss={() => setExportError(null)}>
                {exportError}
              </Alert>
            ) : null}

            {revenue.isPending ? (
              <div className="py-8 text-center text-sm text-ink-subtle">Loading…</div>
            ) : revenue.isError ? (
              <ErrorState
                title="Could not load the revenue report"
                message={
                  revenue.error instanceof ApiClientError
                    ? revenue.error.message
                    : 'The report could not be retrieved.'
                }
                onRetry={() => void revenue.refetch()}
                retrying={revenue.isFetching}
              />
            ) : !data ? null : (
              <>
                {series.length === 0 ? (
                  <EmptyState
                    icon={<TrendingUp aria-hidden="true" className="size-8" />}
                    title="Nothing in that range"
                    description="Either no payments were taken, or the range runs backwards."
                  />
                ) : (
                  <>
                    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <Money
                        label="Settled"
                        hint="Recorded by staff plus verified gateway, less refunds. The only figure that is money in hand."
                        amount={data.totals.settledTotalMinor}
                        currency={data.currency}
                        emphasis
                      />
                      <Money
                        label="Recorded by staff"
                        hint="A person asserted cash changed hands. Real, but not confirmed by a system."
                        amount={data.totals.manualTotalMinor}
                        currency={data.currency}
                      />
                      <Money
                        label="Verified gateway"
                        hint="A provider settlement reconciled by a named person."
                        amount={data.totals.verifiedGatewayTotalMinor}
                        currency={data.currency}
                      />
                      <Money
                        label="Unreconciled gateway"
                        hint="A provider claim nobody has checked. Not yet revenue in any sense a treasurer would accept."
                        amount={data.totals.pendingGatewayTotalMinor}
                        currency={data.currency}
                        warn={data.totals.pendingGatewayTotalMinor > 0}
                      />
                    </dl>

                    <div className="mt-6 overflow-x-auto">
                      <table className="w-full text-sm">
                        <caption className="sr-only">
                          Revenue by {granularity === 'monthly' ? 'month' : 'day'}, split by
                          verification status
                        </caption>
                        <thead className="border-b border-line bg-canvas text-left text-xs uppercase tracking-wide text-ink-subtle">
                          <tr>
                            <th scope="col" className="px-3 py-2 font-medium">Period</th>
                            <th scope="col" className="px-3 py-2 text-right font-medium">Staff</th>
                            <th scope="col" className="px-3 py-2 text-right font-medium">Verified</th>
                            <th scope="col" className="px-3 py-2 text-right font-medium">Unreconciled</th>
                            <th scope="col" className="px-3 py-2 text-right font-medium">Payments</th>
                          </tr>
                        </thead>
                        <tbody>
                          {series.map((bucket) => (
                            <tr key={bucket.key} className="border-b border-line last:border-0">
                              <td className="px-3 py-2 font-medium">{bucket.key}</td>
                              <td className="px-3 py-2 text-right">
                                {formatMinorUnits(bucket.manualTotalMinor, data.currency)}
                              </td>
                              <td className="px-3 py-2 text-right">
                                {formatMinorUnits(bucket.verifiedGatewayTotalMinor, data.currency)}
                              </td>
                              <td
                                className={`px-3 py-2 text-right ${
                                  bucket.pendingGatewayTotalMinor > 0
                                    ? 'font-medium text-warning-700'
                                    : 'text-ink-subtle'
                                }`}
                              >
                                {formatMinorUnits(bucket.pendingGatewayTotalMinor, data.currency)}
                              </td>
                              <td className="px-3 py-2 text-right text-ink-muted">
                                {bucket.paymentCount}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <Alert tone="info" title="What these numbers mean">
                      {data.note} Buckets follow the hospital&rsquo;s own calendar day
                      ({data.timezone}), not UTC, so a day&rsquo;s takings stay in one column.
                    </Alert>
                  </>
                )}
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </AppShell>
  )
}

function Money({
  label,
  hint,
  amount,
  currency,
  emphasis,
  warn,
}: {
  label: string
  hint: string
  amount: number
  currency: string
  emphasis?: boolean
  warn?: boolean
}) {
  return (
    <div className={`rounded-lg border p-4 ${warn ? 'border-warning-300 bg-warning-50' : 'border-line'}`}>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className={`mt-1 ${emphasis ? 'text-2xl font-semibold' : 'text-lg font-medium'}`}>
        {formatMinorUnits(amount, currency)}
      </dd>
      <p className="mt-1 text-xs text-ink-subtle">{hint}</p>
    </div>
  )
}