import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, CheckCircle2, ShieldAlert } from 'lucide-react'

import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'
import { apiClient, ApiClientError } from '../../lib/api-client.js'
import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge, HospitalStatusBadge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader, StatTile } from '../../components/ui/Card.js'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { Pagination } from '../../components/ui/Pagination.js'
import { SearchInput } from '../../components/ui/SearchInput.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'

interface HospitalRow {
  id: string
  name: string
  slug: string
  status: string
  createdAt: string
}

const PAGE_SIZE = 10

/**
 * Platform administration dashboard.
 *
 * Reads `GET /platform/hospitals` — the real endpoint, guarded server-side by
 * `platform:hospital:read` — and approves tenants through the real approve route. The
 * numbers on the tiles are counted from that response rather than fabricated, so the
 * screen cannot drift from the database.
 *
 * The list endpoint returns at most 100 hospitals and has no server-side pagination yet,
 * so search and paging here are client-side over that set. That is stated in the UI
 * rather than implied; presenting a client-side page number as if it were a server page
 * total would mislead once a tenant count grows.
 */
export function SuperAdminDashboard() {
  const { user } = useAuth()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pendingApproval, setPendingApproval] = useState<HospitalRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const hospitals = useQuery({
    queryKey: ['platform', 'hospitals'],
    queryFn: () => apiClient.get<HospitalRow[]>('/platform/hospitals'),
  })

  const approve = useMutation({
    mutationFn: (hospital: HospitalRow) =>
      apiClient.post<{ status: string }>(`/platform/hospitals/${hospital.id}/approve`, {}),
    onSuccess: (_result, hospital) => {
      setNotice(`${hospital.name} was approved. Its administrator can now sign in.`)
      setActionError(null)
      setPendingApproval(null)
      void queryClient.invalidateQueries({ queryKey: ['platform', 'hospitals'] })
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiClientError ? error.message : 'Approval failed. Please try again.',
      )
    },
  })

  const rows = useMemo(() => hospitals.data ?? [], [hospitals.data])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (term === '') return rows
    return rows.filter(
      (row) => row.name.toLowerCase().includes(term) || row.slug.toLowerCase().includes(term),
    )
  }, [rows, search])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const counts = useMemo(
    () => ({
      total: rows.length,
      pending: rows.filter((row) => row.status === 'PENDING').length,
      approved: rows.filter((row) => row.status === 'APPROVED').length,
      suspended: rows.filter((row) => row.status === 'SUSPENDED').length,
    }),
    [rows],
  )

  const canApprove = user ? hasPermission(user, 'platform:hospital:approve') : false

  const columns: Column<HospitalRow>[] = [
    {
      key: 'name',
      header: 'Hospital',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{row.name}</p>
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
            disabled={!canApprove || approve.isPending}
            onClick={() => setPendingApproval(row)}
            leadingIcon={<CheckCircle2 aria-hidden="true" className="size-4" />}
          >
            Approve
          </Button>
        ) : (
          <span className="text-xs text-ink-subtle">—</span>
        ),
    },
  ]

  return (
    <AppShell title="Platform overview" breadcrumbs={[{ label: 'Platform' }]} wide>
      <div className="space-y-5">
        {notice ? (
          <Alert tone="success" title="Tenant updated" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        ) : null}

        {actionError ? (
          <Alert
            tone="danger"
            title="Could not approve tenant"
            onDismiss={() => setActionError(null)}
          >
            {actionError}
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Hospitals"
            value={hospitals.isPending ? '—' : counts.total}
            hint="All tenants on the platform"
            icon={<Building2 aria-hidden="true" className="size-5" />}
          />
          <StatTile
            label="Pending approval"
            value={hospitals.isPending ? '—' : counts.pending}
            hint={counts.pending > 0 ? 'Awaiting a decision' : 'Nothing waiting'}
            tone={counts.pending > 0 ? 'warning' : 'default'}
          />
          <StatTile
            label="Approved"
            value={hospitals.isPending ? '—' : counts.approved}
            hint="May sign in"
            tone="success"
          />
          <StatTile
            label="Suspended"
            value={hospitals.isPending ? '—' : counts.suspended}
            hint="Access revoked"
            tone={counts.suspended > 0 ? 'warning' : 'default'}
          />
        </div>

        <Card>
          <CardHeader
            title="Tenant hospitals"
            description="Registered organisations and their approval state."
            actions={
              <SearchInput
                value={search}
                onChange={(value) => {
                  setSearch(value)
                  setPage(1)
                }}
                placeholder="Search hospitals…"
                label="Search hospitals"
                className="w-full sm:w-64"
              />
            }
          />

          {hospitals.isPending ? (
            <TableSkeleton
              rows={5}
              columns={4}
              caption="Hospitals registered on the platform, with approval status and registration date"
            />
          ) : hospitals.isError ? (
            <CardBody>
              <ErrorState
                title="Could not load hospitals"
                message={
                  hospitals.error instanceof ApiClientError
                    ? hospitals.error.message
                    : 'The list of hospitals could not be retrieved.'
                }
                onRetry={() => void hospitals.refetch()}
                retrying={hospitals.isFetching}
              />
            </CardBody>
          ) : filtered.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<ShieldAlert aria-hidden="true" className="size-10" />}
                title={search ? 'No hospitals match your search' : 'No hospitals registered yet'}
                description={
                  search
                    ? 'Try a different name or clear the search to see every tenant.'
                    : 'Hospitals appear here once they register through the public sign-up form.'
                }
                action={
                  search ? (
                    <Button variant="secondary" onClick={() => setSearch('')}>
                      Show all hospitals
                    </Button>
                  ) : undefined
                }
              />
            </CardBody>
          ) : (
            <>
              <DataTable
                caption="Hospitals registered on the platform, with approval status and registration date"
                columns={columns}
                items={visible}
                rowKey={(row) => row.id}
              />
              <div className="border-t border-line px-5 py-3">
                <Pagination
                  page={page}
                  pageCount={pageCount}
                  onPageChange={setPage}
                  total={filtered.length}
                />
              </div>
            </>
          )}
        </Card>

        <Card>
          <CardHeader title="Your platform scope" />
          <CardBody>
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-ink-subtle">Signed in as</dt>
                <dd className="mt-0.5 text-sm font-medium text-ink">{user?.email}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-subtle">Tenant scope</dt>
                <dd className="mt-0.5">
                  <Badge tone="brand">All hospitals — no hospital membership</Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-subtle">Clinical access</dt>
                <dd className="mt-0.5 text-sm text-ink-muted">
                  None. Platform operators cannot read patient records.
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      </div>

      <ConfirmDialog
        open={pendingApproval !== null}
        title="Approve this hospital?"
        destructive={false}
        confirmLabel="Approve hospital"
        busy={approve.isPending}
        onCancel={() => setPendingApproval(null)}
        onConfirm={() => {
          if (pendingApproval) approve.mutate(pendingApproval)
        }}
        description={
          <>
            <strong className="font-medium text-ink">{pendingApproval?.name}</strong> will be able
            to sign in and its administrator will gain full access to that hospital. This action is
            recorded in the audit trail.
          </>
        }
      />
    </AppShell>
  )
}
