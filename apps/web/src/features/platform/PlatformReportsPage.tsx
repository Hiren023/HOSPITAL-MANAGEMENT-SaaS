import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Building2, TrendingUp } from 'lucide-react'
import { planLabel } from '@infinigrow/shared'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader, StatTile } from '../../components/ui/Card.js'
import { TableSkeleton } from '../../components/ui/DataTable.js'
import { Select } from '../../components/ui/Select.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'

import { fetchOperationalReport } from './api.js'

const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
]

/**
 * Operational report.
 *
 * Aggregate counts over `hospitals`, `users` and `memberships` only. There is no
 * patient, appointment or consultation figure here, and none is available to a platform
 * operator anywhere in this product — a hospital's clinical activity is its own business
 * and is answered by that hospital's console, where this role has no access at all.
 */
export function PlatformReportsPage() {
  const [days, setDays] = useState('30')

  const report = useQuery({
    queryKey: ['platform', 'report', { days }],
    queryFn: () => fetchOperationalReport(Number(days)),
  })

  const data = report.data
  const maxGrowth = Math.max(1, ...(data?.growth ?? []).map((point) => point.count))

  return (
    <AppShell
      title="Operational reports"
      breadcrumbs={[{ label: 'Platform' }, { label: 'Reports' }]}
    >
      <div className="space-y-5">
        {report.isError ? (
          <ErrorState
            title="Could not build the report"
            message={
              report.error instanceof ApiClientError
                ? report.error.message
                : 'The operational report could not be generated.'
            }
            onRetry={() => void report.refetch()}
            retrying={report.isFetching}
          />
        ) : null}

        <Card>
          <CardHeader
            title="Reporting window"
            description="Bounded so a query can never scan the whole history."
            actions={
              <div className="w-full sm:w-48">
                <label htmlFor="window" className="sr-only">
                  Reporting window
                </label>
                <Select
                  id="window"
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                  options={WINDOWS}
                />
              </div>
            }
          />
        </Card>

        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile
            label="Active tenants"
            value={report.isPending ? '—' : (data?.tenants.active ?? '—')}
            hint="Approved and able to sign in"
            icon={<Building2 aria-hidden="true" className="size-5" />}
            tone="success"
          />
          <StatTile
            label="New registrations"
            value={report.isPending ? '—' : (data?.tenants.registeredInWindow ?? '—')}
            hint={`In the last ${days} days`}
            icon={<TrendingUp aria-hidden="true" className="size-5" />}
          />
          <StatTile
            label="Pending approval"
            value={report.isPending ? '—' : (data?.tenants.byStatus['PENDING'] ?? 0)}
            hint="Awaiting a decision"
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Tenants by status" />
            <CardBody>
              {report.isPending ? (
                <TableSkeleton rows={3} columns={2} caption="Tenants by status" />
              ) : Object.keys(data?.tenants.byStatus ?? {}).length === 0 ? (
                <p className="text-sm text-body-muted">No tenants recorded yet.</p>
              ) : (
                <dl className="space-y-3">
                  {Object.entries(data?.tenants.byStatus ?? {}).map(([status, count]) => (
                    <div key={status} className="flex items-center justify-between gap-3">
                      <dt className="text-sm text-body-muted">{status}</dt>
                      <dd className="text-sm font-semibold tabular-nums text-ink-900">{count}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Tenants by plan"
              description="Assignment only — no revenue is tracked."
            />
            <CardBody>
              {report.isPending ? (
                <TableSkeleton rows={3} columns={2} caption="Tenants by plan" />
              ) : Object.keys(data?.tenants.byPlan ?? {}).length === 0 ? (
                <p className="text-sm text-body-muted">No tenants recorded yet.</p>
              ) : (
                <dl className="space-y-3">
                  {Object.entries(data?.tenants.byPlan ?? {}).map(([plan, count]) => (
                    <div key={plan} className="flex items-center justify-between gap-3">
                      <dt className="text-sm text-body-muted">{planLabel(plan)}</dt>
                      <dd className="text-sm font-semibold tabular-nums text-ink-900">{count}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Registration trend"
            description="Days on which at least one hospital registered."
          />
          <CardBody>
            {report.isPending ? (
              <TableSkeleton rows={4} columns={2} caption="Registration trend" />
            ) : (data?.growth.length ?? 0) === 0 ? (
              <p className="text-sm text-body-muted">
                No registrations in this window. Widen the reporting window to see earlier activity.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {data?.growth.map((point) => (
                  <li key={point.date} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 text-xs tabular-nums text-body-muted">
                      {point.date}
                    </span>
                    <div
                      className="h-5 rounded bg-infini-600"
                      style={{
                        width: `${Math.max(4, (point.count / maxGrowth) * 100)}%`,
                      }}
                      role="img"
                      aria-label={`${point.count} registrations on ${point.date}`}
                    />
                    <span className="text-xs font-medium tabular-nums text-body">{point.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Alert tone="info" title="Limits of this report">
          Counts of tenants and accounts only. Clinical activity is invisible here by design, and
          there is no permission that would reveal it.{' '}
          <Button variant="link" size="sm" onClick={() => void report.refetch()}>
            Refresh
          </Button>
        </Alert>
      </div>
    </AppShell>
  )
}
