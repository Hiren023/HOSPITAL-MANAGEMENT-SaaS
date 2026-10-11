import { useQuery } from '@tanstack/react-query'
import { Building2, Clock, ShieldAlert, UserCog, Users } from 'lucide-react'
import { Link } from 'react-router-dom'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Card, CardBody, CardHeader, StatTile } from '../../components/ui/Card.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { TableSkeleton } from '../../components/ui/DataTable.js'
import { planLabel } from '@infinigrow/shared'

import { fetchPlatformOverview, type PlatformOverview } from './api.js'

/**
 * Platform overview.
 *
 * Every figure comes from `GET /platform/overview`, which counts tenants and accounts.
 * There is deliberately no patient, appointment or consultation figure anywhere on this
 * screen — a `SUPER_ADMIN` is the SaaS operator, not a clinician, and the API exposes no
 * capability that would let them read clinical data (docs/SECURITY.md R14).
 *
 * Counts are shown as `—` while loading rather than as zero. A dashboard that briefly
 * claims "0 patients" during a fetch is worse than one that admits it is still asking.
 */
export function PlatformOverviewPage() {
  const overview = useQuery({
    queryKey: ['platform', 'overview'],
    queryFn: fetchPlatformOverview,
  })

  const data = overview.data

  return (
    <AppShell title="Platform overview" breadcrumbs={[{ label: 'Platform' }]} wide>
      <div className="space-y-5">
        {overview.isError ? (
          <ErrorState
            title="Could not load platform metrics"
            message={
              overview.error instanceof Error
                ? overview.error.message
                : 'The platform overview could not be retrieved.'
            }
            onRetry={() => void overview.refetch()}
            retrying={overview.isFetching}
          />
        ) : null}

        <section aria-labelledby="tenant-heading">
          <h2 id="tenant-heading" className="sr-only">
            Tenant metrics
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label="Hospitals on platform"
              value={value(data?.tenants.total)}
              hint="Every registered tenant"
              icon={<Building2 aria-hidden="true" className="size-5" />}
            />
            <StatTile
              label="Pending approval"
              value={value(data?.tenants.pending)}
              hint={data && data.tenants.pending > 0 ? 'Awaiting a decision' : 'Nothing waiting'}
              tone={data && data.tenants.pending > 0 ? 'warning' : 'default'}
            />
            <StatTile
              label="Approved"
              value={value(data?.tenants.approved)}
              hint="May sign in"
              tone="success"
            />
            <StatTile
              label="Suspended"
              value={value(data?.tenants.suspended)}
              hint="Access cut off"
              tone={data && data.tenants.suspended > 0 ? 'warning' : 'default'}
            />
          </div>
        </section>

        <div className="grid gap-5 lg:grid-cols-3">
          <Card>
            <CardHeader title="Accounts" description="Identities across every tenant." />
            <CardBody>
              {overview.isPending ? (
                <TableSkeleton rows={2} columns={2} caption="Account metrics" />
              ) : (
                <dl className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="flex items-center gap-2 text-sm text-ink-muted">
                      <Users aria-hidden="true" className="size-4 text-ink-subtle" />
                      Total users
                    </dt>
                    <dd className="text-sm font-semibold tabular-nums text-navy-900">
                      {data?.identity.totalUsers ?? '—'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="flex items-center gap-2 text-sm text-ink-muted">
                      <UserCog aria-hidden="true" className="size-4 text-ink-subtle" />
                      Active memberships
                    </dt>
                    <dd className="text-sm font-semibold tabular-nums text-navy-900">
                      {data?.identity.activeMemberships ?? '—'}
                    </dd>
                  </div>
                </dl>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Subscription plans"
              description="Assignment only — nothing is charged."
            />
            <CardBody>
              {overview.isPending ? (
                <TableSkeleton rows={3} columns={2} caption="Plan distribution" />
              ) : Object.keys(data?.plans ?? {}).length === 0 ? (
                <p className="text-sm text-ink-muted">No tenants assigned yet.</p>
              ) : (
                <dl className="space-y-3">
                  {Object.entries(data?.plans ?? {}).map(([plan, count]) => (
                    <div key={plan} className="flex items-center justify-between gap-3">
                      <dt className="text-sm text-ink-muted">{planLabel(plan)}</dt>
                      <dd className="text-sm font-semibold tabular-nums text-navy-900">{count}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Platform activity" description="Audit volume, not content." />
            <CardBody>
              {overview.isPending ? (
                <TableSkeleton rows={2} columns={2} caption="Activity metrics" />
              ) : (
                <dl className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="flex items-center gap-2 text-sm text-ink-muted">
                      <Clock aria-hidden="true" className="size-4 text-ink-subtle" />
                      Events, last 24h
                    </dt>
                    <dd className="text-sm font-semibold tabular-nums text-navy-900">
                      {data?.recentActivity.last24h ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-ink-muted">Most recent</dt>
                    <dd className="mt-0.5 text-sm font-medium text-navy-900">
                      {data?.recentActivity.mostRecentAt
                        ? new Date(data.recentActivity.mostRecentAt).toLocaleString('en-IN', {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : 'No activity recorded'}
                    </dd>
                  </div>
                </dl>
              )}
            </CardBody>
          </Card>
        </div>

        <Alert tone="info" title="What a platform operator can see">
          Hospitals exist and are healthy, which accounts they employ, which plan they are on, and
          what has happened in the audit trail.{' '}
          <strong className="font-medium text-ink">Patient records are not visible here</strong> and
          no permission in this product grants access to them.
        </Alert>

        <Card>
          <CardHeader title="Quick actions" />
          <CardBody className="flex flex-wrap gap-2">
            <Link
              to="/platform/hospitals?status=PENDING"
              className="text-sm font-medium text-brand-700 underline underline-offset-4 hover:text-brand-800"
            >
              Review pending hospitals
            </Link>
            <span aria-hidden="true" className="text-line-strong">
              ·
            </span>
            <Link
              to="/platform/audit"
              className="text-sm font-medium text-brand-700 underline underline-offset-4 hover:text-brand-800"
            >
              Open the audit trail
            </Link>
            <span aria-hidden="true" className="text-line-strong">
              ·
            </span>
            <Link
              to="/platform/reports"
              className="text-sm font-medium text-brand-700 underline underline-offset-4 hover:text-brand-800"
            >
              Operational reports
            </Link>
          </CardBody>
        </Card>

        {data && data.tenants.suspended > 0 ? (
          <Card>
            <CardHeader
              title="Suspended tenants"
              actions={
                <Badge tone="warning">
                  <ShieldAlert aria-hidden="true" className="size-3" />
                  Access cut off
                </Badge>
              }
            />
            <CardBody>
              <p className="text-sm text-ink-muted">
                {data.tenants.suspended}{' '}
                {data.tenants.suspended === 1 ? 'hospital is' : 'hospitals are'} suspended. Their
                staff cannot sign in, and the reason recorded at suspension is the only record they
                will see.
              </p>
              <Link
                to="/platform/hospitals?status=SUSPENDED"
                className="mt-3 inline-block text-sm font-medium text-brand-700 underline underline-offset-4"
              >
                Review suspended tenants
              </Link>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </AppShell>
  )
}

/** `—` while loading, so a pending fetch never reads as a real zero. */
function value(count: number | undefined): string {
  return count === undefined ? '—' : String(count)
}

export type { PlatformOverview }
