import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Building2 } from 'lucide-react'
import { planLabel } from '@infinigrow/shared'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog.js'
import { HospitalStatusBadge } from '../../components/ui/Badge.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { Pagination } from '../../components/ui/Pagination.js'
import { SearchInput } from '../../components/ui/SearchInput.js'
import { Select } from '../../components/ui/Select.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'

import { approveHospital, fetchHospitals, suspendHospital, type HospitalSummary } from './api.js'

const PAGE_SIZE = 20

const STATUS_OPTIONS = [
  { value: 'PENDING', label: 'Pending approval' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'REJECTED', label: 'Rejected' },
]

/**
 * Tenant list.
 *
 * Search, filtering and paging are **server-side**: the query string carries `page`,
 * `pageSize`, `q`, `status` and `plan` to the API, and the response supplies the true
 * total. The previous console shape — fetch 100 rows, filter them in the browser — was
 * quietly wrong as soon as a platform had more than 100 tenants, because page 2 came back
 * empty while the header still claimed a hundred existed.
 *
 * Filter state lives in the URL. That makes a filtered view shareable and survives a
 * reload, and it means the back button behaves the way a person expects.
 */
export function PlatformHospitalsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()

  const status = searchParams.get('status') ?? ''
  const plan = searchParams.get('plan') ?? ''
  const q = searchParams.get('q') ?? ''
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)

  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<{
    hospital: HospitalSummary
    action: 'approve' | 'suspend'
  } | null>(null)

  const hospitals = useQuery({
    queryKey: ['platform', 'hospitals', { page, q, status, plan }],
    queryFn: ({ signal }) =>
      fetchHospitals(
        {
          page,
          pageSize: PAGE_SIZE,
          q: q || undefined,
          status: status || undefined,
          plan: plan || undefined,
        },
        signal,
      ),
  })

  /**
   * Any filter change resets to page one.
   *
   * Without this, filtering while on page 4 leaves you on a page that may not exist —
   * the console would show "no results" for a search that does have matches, which reads
   * as "this hospital is gone" rather than "you are past the end of the list".
   */
  useEffect(() => {
    if (page !== 1 && (q !== '' || status !== '' || plan !== '')) {
      const next = new URLSearchParams(searchParams)
      next.delete('page')
      setSearchParams(next, { replace: true })
    }
  }, [q, status, plan, page, searchParams, setSearchParams])

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (value === '') next.delete(key)
      else next.set(key, value)
    }
    next.delete('page')
    setSearchParams(next)
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['platform'] })

  const lifecycle = useMutation({
    mutationFn: ({
      hospital,
      action,
    }: {
      hospital: HospitalSummary
      action: 'approve' | 'suspend'
    }) =>
      action === 'approve'
        ? approveHospital(hospital.id)
        : suspendHospital(hospital.id, 'Administrative action from the platform console'),
    onSuccess: (_result, variables) => {
      setNotice(
        variables.action === 'approve'
          ? `${variables.hospital.name} was approved. Its administrator can now sign in.`
          : `${variables.hospital.name} was suspended. Its staff can no longer sign in.`,
      )
      setActionError(null)
      setConfirming(null)
      void invalidate()
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiClientError ? error.message : 'The action could not be completed.',
      )
      setConfirming(null)
    },
  })

  const rows = hospitals.data?.items ?? []

  const columns = useMemo<Column<HospitalSummary>[]>(() => {
    const canApprove = true

    return [
      {
        key: 'name',
        header: 'Hospital',
        cell: (row) => (
          <div className="min-w-0">
            <a
              href={`/platform/hospitals/${row.id}`}
              className="truncate font-medium text-brand-700 underline-offset-4 hover:underline"
            >
              {row.name}
            </a>
            <p className="truncate font-mono text-xs text-ink-subtle">{row.slug}</p>
          </div>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => <HospitalStatusBadge status={row.status} />,
      },
      {
        key: 'plan',
        header: 'Plan',
        cell: (row) => (
          <span className="whitespace-nowrap text-sm text-ink-muted">{row.planLabel}</span>
        ),
        secondary: true,
      },
      {
        key: 'location',
        header: 'Location',
        cell: (row) => (
          <span className="whitespace-nowrap text-sm text-ink-muted">
            {[row.city, row.state].filter(Boolean).join(', ') || '—'}
          </span>
        ),
        secondary: true,
      },
      {
        key: 'registered',
        header: 'Registered',
        cell: (row) => (
          <span className="whitespace-nowrap text-ink-muted">
            {new Date(row.createdAt).toLocaleDateString('en-IN', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            })}
          </span>
        ),
        secondary: true,
      },
      {
        key: 'actions',
        header: <span className="sr-only">Actions</span>,
        cell: (row) =>
          row.status === 'PENDING' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canApprove || lifecycle.isPending}
              onClick={() => setConfirming({ hospital: row, action: 'approve' })}
            >
              Approve
            </Button>
          ) : row.status === 'SUSPENDED' ? (
            <a
              href={`/platform/hospitals/${row.id}`}
              className="text-sm font-medium text-brand-700 underline underline-offset-4"
            >
              Reactivate
            </a>
          ) : (
            <span className="text-xs text-ink-subtle">—</span>
          ),
      },
    ]
  }, [lifecycle.isPending])

  const hasFilters = q !== '' || status !== '' || plan !== ''
  const meta = hospitals.data?.page

  return (
    <AppShell title="Hospitals" breadcrumbs={[{ label: 'Platform' }, { label: 'Hospitals' }]} wide>
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
            title="Tenant hospitals"
            description={
              meta
                ? `${meta.total} ${meta.total === 1 ? 'hospital' : 'hospitals'} match your filters.`
                : 'Registered organisations and their lifecycle state.'
            }
            actions={
              <SearchInput
                value={q}
                onChange={(value) => update({ q: value })}
                placeholder="Search name, slug or registration…"
                label="Search hospitals"
                className="w-full sm:w-72"
              />
            }
          />

          {/* Filters sit in a labelled group so a screen reader announces them together. */}
          <div
            role="group"
            aria-label="Filter hospitals"
            className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3"
          >
            <div className="w-full sm:w-48">
              <label
                htmlFor="status-filter"
                className="mb-1 block text-xs font-medium text-ink-muted"
              >
                Status
              </label>
              <Select
                id="status-filter"
                placeholder="All statuses"
                options={STATUS_OPTIONS}
                value={status}
                onChange={(event) => update({ status: event.target.value })}
              />
            </div>

            <div className="w-full sm:w-48">
              <label
                htmlFor="plan-filter"
                className="mb-1 block text-xs font-medium text-ink-muted"
              >
                Plan
              </label>
              <Select
                id="plan-filter"
                placeholder="All plans"
                options={['STARTER', 'HOSPITAL', 'ENTERPRISE'].map((value) => ({
                  value,
                  label: planLabel(value),
                }))}
                value={plan}
                onChange={(event) => update({ plan: event.target.value })}
              />
            </div>

            {hasFilters ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSearchParams(new URLSearchParams())}
              >
                Clear filters
              </Button>
            ) : null}
          </div>

          {hospitals.isPending ? (
            <TableSkeleton
              rows={6}
              columns={6}
              caption="Hospitals registered on the platform, with approval status and registration date"
            />
          ) : hospitals.isError ? (
            <CardBody>
              <ErrorState
                title="Could not load hospitals"
                message={
                  hospitals.error instanceof ApiClientError
                    ? hospitals.error.message
                    : 'The hospital list could not be retrieved.'
                }
                onRetry={() => void hospitals.refetch()}
                retrying={hospitals.isFetching}
              />
            </CardBody>
          ) : rows.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<Building2 aria-hidden="true" className="size-10" />}
                title={
                  hasFilters ? 'No hospitals match these filters' : 'No hospitals registered yet'
                }
                description={
                  hasFilters
                    ? 'Adjust the search or clear the filters to see every tenant.'
                    : 'Hospitals appear here once they register through the public sign-up form.'
                }
                action={
                  hasFilters ? (
                    <Button
                      variant="secondary"
                      onClick={() => setSearchParams(new URLSearchParams())}
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </CardBody>
          ) : (
            <>
              <DataTable
                caption="Hospitals registered on the platform, with approval status, plan and registration date"
                columns={columns}
                items={rows}
                rowKey={(row) => row.id}
              />
              <div className="border-t border-line px-5 py-3">
                <Pagination
                  page={meta?.page ?? 1}
                  pageCount={meta?.totalPages ?? 1}
                  onPageChange={(next) => {
                    const params = new URLSearchParams(searchParams)
                    params.set('page', String(next))
                    setSearchParams(params)
                  }}
                  total={meta?.total}
                />
              </div>
            </>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirming !== null}
        destructive={confirming?.action === 'suspend'}
        title={
          confirming?.action === 'approve' ? 'Approve this hospital?' : 'Suspend this hospital?'
        }
        confirmLabel={confirming?.action === 'approve' ? 'Approve hospital' : 'Suspend hospital'}
        busy={lifecycle.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) lifecycle.mutate(confirming)
        }}
        description={
          confirming?.action === 'approve' ? (
            <>
              <strong className="font-medium text-ink">{confirming?.hospital.name}</strong> will be
              able to sign in and its administrator will gain full access to that hospital.
            </>
          ) : (
            <>
              <strong className="font-medium text-ink">{confirming?.hospital.name}</strong> will
              lose access immediately. Every member of that hospital will be refused at sign-in
              until it is reactivated.
            </>
          )
        }
      />
    </AppShell>
  )
}
