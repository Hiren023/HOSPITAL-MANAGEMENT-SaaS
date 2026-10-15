import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ShieldCheck, UserCog } from 'lucide-react'
import { PLANS, planLabel } from '@infinigrow/shared'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge, HospitalStatusBadge, RoleBadge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { FormField } from '../../components/ui/FormField.js'
import { Modal } from '../../components/ui/Modal.js'
import { Select } from '../../components/ui/Select.js'
import { Textarea } from '../../components/ui/Textarea.js'
import { Pagination } from '../../components/ui/Pagination.js'
import { SearchInput } from '../../components/ui/SearchInput.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'

import {
  approveHospital,
  assignPlan,
  changeUserStatus,
  fetchHospitalDetail,
  fetchTenantUsers,
  reactivateHospital,
  suspendHospital,
  type TenantUser,
} from './api.js'

const USER_PAGE_SIZE = 10

type PendingAction = 'suspend' | 'reactivate' | 'approve' | null

/**
 * Hospital detail.
 *
 * Reading this page is audited (`hospital.viewed`). An operator browsing tenants at scale
 * is exactly the access pattern a hospital would want to be able to review afterwards,
 * and a record that exists only in the database is no record at all.
 *
 * Every destructive action goes through a confirmation that names the hospital and states
 * the consequence. Suspending cuts a hospital off from its own data, so the wording says
 * so plainly rather than describing it as "updating the status".
 */
export function PlatformHospitalDetailPage() {
  const { hospitalId = '' } = useParams()
  const queryClient = useQueryClient()

  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAction>(null)
  const [planOpen, setPlanOpen] = useState(false)
  const [suspendOpen, setSuspendOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [userPage, setUserPage] = useState(1)
  const [userSearch, setUserSearch] = useState('')
  const [statusTarget, setStatusTarget] = useState<TenantUser | null>(null)
  const [statusChoice, setStatusChoice] = useState<'SUSPENDED' | 'ACTIVE'>('SUSPENDED')
  const [statusReason, setStatusReason] = useState('')

  const detail = useQuery({
    queryKey: ['platform', 'hospital', hospitalId],
    queryFn: () => fetchHospitalDetail(hospitalId),
    enabled: hospitalId !== '',
  })

  const users = useQuery({
    queryKey: ['platform', 'hospital', hospitalId, 'users', { userPage, userSearch }],
    queryFn: ({ signal }) =>
      fetchTenantUsers(
        hospitalId,
        {
          page: userPage,
          pageSize: USER_PAGE_SIZE,
          q: userSearch || undefined,
        },
        signal,
      ),
    enabled: hospitalId !== '',
  })

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['platform'] })

  const lifecycle = useMutation({
    mutationFn: async (action: 'suspend' | 'reactivate' | 'approve') => {
      if (action === 'suspend') {
        if (reason.trim().length < 10) throw new Error('Give a reason of at least 10 characters.')
        return suspendHospital(hospitalId, reason.trim())
      }
      if (action === 'approve') return approveHospital(hospitalId)
      return reactivateHospital(hospitalId, 'Reactivated from the platform console')
    },
    onSuccess: (_result, action) => {
      setNotice(
        action === 'suspend'
          ? 'Hospital suspended. Its staff can no longer sign in.'
          : action === 'approve'
            ? 'Hospital approved. Its administrator can now sign in.'
            : 'Hospital reactivated. Its staff can sign in again.',
      )
      setActionError(null)
      setPending(null)
      setSuspendOpen(false)
      setReason('')
      invalidate()
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'The action could not be completed.',
      )
      setPending(null)
      setSuspendOpen(false)
    },
  })

  const planMutation = useMutation({
    mutationFn: (input: { plan: string; reason?: string }) =>
      assignPlan(hospitalId, input.plan, input.reason),
    onSuccess: (result) => {
      setNotice(`Plan changed to ${result.planLabel}.`)
      setActionError(null)
      setPlanOpen(false)
      invalidate()
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiClientError ? error.message : 'The plan could not be changed.',
      )
    },
  })

  const statusMutation = useMutation({
    mutationFn: ({
      user,
      status,
      why,
    }: {
      user: TenantUser
      status: 'ACTIVE' | 'SUSPENDED'
      why: string
    }) => changeUserStatus(user.userId, status, why),
    onSuccess: (result) => {
      setNotice(
        result.status === 'SUSPENDED'
          ? `${result.email} is suspended across every hospital they belong to.`
          : `${result.email} can sign in again.`,
      )
      setActionError(null)
      setStatusTarget(null)
      setStatusReason('')
      invalidate()
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiClientError ? error.message : 'The status could not be changed.',
      )
    },
  })

  const hospital = detail.data

  const userColumns = useMemo<Column<TenantUser>[]>(
    () => [
      {
        key: 'person',
        header: 'Person',
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate font-medium text-body">
              {row.firstName} {row.lastName}
            </p>
            <p className="truncate text-xs text-body-subtle">{row.email}</p>
          </div>
        ),
      },
      {
        key: 'role',
        header: 'Role',
        cell: (row) =>
          row.role ? <RoleBadge role={row.role} /> : <span className="text-body-subtle">—</span>,
      },
      {
        key: 'status',
        header: 'Account',
        cell: (row) => (
          <Badge tone={row.status === 'ACTIVE' ? 'success' : 'danger'} dot>
            {row.status === 'ACTIVE' ? 'Active' : row.status}
          </Badge>
        ),
      },
      {
        key: 'actions',
        header: <span className="sr-only">Actions</span>,
        cell: (row) => (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setStatusTarget(row)
              setStatusChoice(row.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE')
              setStatusReason('')
            }}
          >
            {row.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
          </Button>
        ),
      },
    ],
    [],
  )

  return (
    <AppShell
      title={hospital?.name ?? 'Hospital'}
      breadcrumbs={[
        { label: 'Platform' },
        { label: 'Hospitals', to: '/platform/hospitals' },
        { label: hospital?.name ?? '…' },
      ]}
      wide
    >
      <div className="space-y-5">
        <Link
          to="/platform/hospitals"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-infini-700 underline-offset-4 hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All hospitals
        </Link>

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

        {detail.isError ? (
          <ErrorState
            title="Could not load this hospital"
            message={
              detail.error instanceof ApiClientError
                ? detail.error.message
                : 'The hospital record could not be retrieved.'
            }
            onRetry={() => void detail.refetch()}
            retrying={detail.isFetching}
          />
        ) : null}

        {detail.isPending ? (
          <Card>
            <TableSkeleton rows={5} columns={2} caption="Hospital details" />
          </Card>
        ) : hospital ? (
          <>
            <Card>
              <CardHeader
                title="Tenant record"
                description={hospital.slug}
                actions={<HospitalStatusBadge status={hospital.status} />}
              />
              <CardBody>
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Detail label="Registration number" value={hospital.registrationNumber ?? '—'} />
                  <Detail label="Contact email" value={hospital.contactEmail ?? '—'} />
                  <Detail
                    label="Location"
                    value={[hospital.city, hospital.state].filter(Boolean).join(', ') || '—'}
                  />
                  <Detail label="Registered" value={formatDate(hospital.createdAt)} />
                  <Detail
                    label="Approved"
                    value={hospital.approvedAt ? formatDate(hospital.approvedAt) : '—'}
                  />
                  <Detail
                    label="Last reactivated"
                    value={hospital.reactivatedAt ? formatDate(hospital.reactivatedAt) : '—'}
                  />
                </dl>

                {hospital.suspensionReason ? (
                  <Alert tone="warning" title="Suspension reason" className="mt-5">
                    {hospital.suspensionReason}
                  </Alert>
                ) : null}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Subscription plan"
                description="Assignment only — nothing is charged."
              />
              <CardBody className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-ink-900">{hospital.planLabel}</p>
                  <p className="mt-0.5 text-xs text-body-muted">
                    {hospital.seatLimit === null ? 'Unlimited' : hospital.seatLimit} staff seats ·{' '}
                    {hospital.departmentLimit === null ? 'unlimited' : hospital.departmentLimit}{' '}
                    departments
                    {hospital.planChangedAt
                      ? ` · changed ${formatDate(hospital.planChangedAt)}`
                      : ''}
                  </p>
                </div>
                <Button variant="secondary" onClick={() => setPlanOpen(true)}>
                  Change plan
                </Button>
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Lifecycle"
                description="Approving enables sign-in. Suspending cuts the tenant off from its own data."
              />
              <CardBody className="flex flex-wrap gap-2">
                {hospital.status === 'PENDING' ? (
                  <Button
                    variant="primary"
                    leadingIcon={<ShieldCheck aria-hidden="true" className="size-4" />}
                    onClick={() => setPending('approve')}
                    busy={lifecycle.isPending && pending === 'approve'}
                  >
                    Approve hospital
                  </Button>
                ) : null}

                {hospital.status === 'SUSPENDED' ? (
                  <Button
                    variant="primary"
                    onClick={() => setPending('reactivate')}
                    busy={lifecycle.isPending && pending === 'reactivate'}
                  >
                    Reactivate hospital
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    onClick={() => {
                      setReason('')
                      setSuspendOpen(true)
                    }}
                  >
                    Suspend hospital
                  </Button>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Staff accounts"
                description={`${hospital.totalUsers} ${hospital.totalUsers === 1 ? 'person' : 'people'} hold a membership here.`}
                actions={
                  <SearchInput
                    value={userSearch}
                    onChange={(value) => {
                      setUserSearch(value)
                      setUserPage(1)
                    }}
                    placeholder="Search staff…"
                    label="Search staff"
                    className="w-full sm:w-64"
                  />
                }
              />

              {users.isPending ? (
                <TableSkeleton rows={4} columns={4} caption="Staff accounts at this hospital" />
              ) : users.isError ? (
                <CardBody>
                  <ErrorState
                    title="Could not load staff"
                    message={
                      users.error instanceof ApiClientError
                        ? users.error.message
                        : 'The staff list could not be retrieved.'
                    }
                    onRetry={() => void users.refetch()}
                  />
                </CardBody>
              ) : (users.data?.items.length ?? 0) === 0 ? (
                <CardBody>
                  <EmptyState
                    icon={<UserCog aria-hidden="true" className="size-10" />}
                    title={userSearch ? 'No staff match that search' : 'No staff accounts yet'}
                    description={
                      userSearch
                        ? 'Try a different name or email address.'
                        : 'Accounts appear here once the hospital invites its first staff member.'
                    }
                  />
                </CardBody>
              ) : (
                <>
                  <DataTable
                    caption="Staff accounts at this hospital, with role and account status"
                    columns={userColumns}
                    items={users.data?.items ?? []}
                    rowKey={(row) => row.userId}
                  />
                  <div className="border-t border-line px-5 py-3">
                    <Pagination
                      page={users.data?.page.page ?? 1}
                      pageCount={users.data?.page.totalPages ?? 1}
                      onPageChange={setUserPage}
                      total={users.data?.page.total}
                    />
                  </div>
                </>
              )}
            </Card>

            <Alert tone="info" title="Scope">
              This view covers identity and lifecycle only. Clinical records belonging to this
              hospital are not visible from the platform console.
            </Alert>
          </>
        ) : null}
      </div>

      {/* ── suspend: requires a reason, because the tenant cannot appeal otherwise ── */}
      <Modal
        open={suspendOpen}
        onClose={() => setSuspendOpen(false)}
        title="Suspend this hospital?"
        description="This takes effect immediately."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSuspendOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              busy={lifecycle.isPending}
              busyLabel="Suspending, please wait"
              onClick={() => {
                if (reason.trim().length < 10) {
                  setActionError('Give a reason of at least 10 characters.')
                  return
                }
                setPending('suspend')
                lifecycle.mutate('suspend')
              }}
            >
              Suspend hospital
            </Button>
          </>
        }
      >
        <p className="text-sm text-body-muted">
          <strong className="font-medium text-body">{hospital?.name}</strong> and all of its staff
          lose access immediately. They will be refused at sign-in until it is reactivated.
        </p>

        <div className="mt-4">
          <FormField
            label="Reason"
            required
            error={
              reason.length > 0 && reason.trim().length < 10 ? 'At least 10 characters' : undefined
            }
            hint="Recorded in the audit trail. The hospital has no other way to find out why."
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={3}
                invalid={invalid}
                aria-describedby={describedBy}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Registration documents could not be verified"
              />
            )}
          </FormField>
        </div>
      </Modal>

      {/* ── plan assignment ── */}
      <PlanDialog
        open={planOpen}
        currentPlan={hospital?.plan ?? ''}
        busy={planMutation.isPending}
        onClose={() => setPlanOpen(false)}
        onSubmit={(plan, why) => planMutation.mutate({ plan, reason: why })}
      />

      {/* ── user status ── */}
      <Modal
        open={statusTarget !== null}
        onClose={() => setStatusTarget(null)}
        title={statusChoice === 'SUSPENDED' ? 'Suspend this account?' : 'Reactivate this account?'}
        description={
          statusChoice === 'SUSPENDED'
            ? 'A global change — this affects every hospital they belong to.'
            : undefined
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setStatusTarget(null)}>
              Cancel
            </Button>
            <Button
              variant={statusChoice === 'SUSPENDED' ? 'danger' : 'primary'}
              busy={statusMutation.isPending}
              busyLabel="Saving, please wait"
              onClick={() => {
                if (statusReason.trim().length < 10) {
                  setActionError('Give a reason of at least 10 characters.')
                  return
                }
                if (statusTarget) {
                  statusMutation.mutate({
                    user: statusTarget,
                    status: statusChoice,
                    why: statusReason.trim(),
                  })
                }
              }}
            >
              {statusChoice === 'SUSPENDED' ? 'Suspend account' : 'Reactivate account'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-body-muted">
          <strong className="font-medium text-body">{statusTarget?.email}</strong>
          {statusChoice === 'SUSPENDED'
            ? ' will be refused at sign-in for every hospital they belong to, not only this one.'
            : ' will be able to sign in again.'}
        </p>

        <div className="mt-4">
          <FormField label="Reason" required hint="Recorded in the audit trail.">
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                rows={3}
                aria-describedby={describedBy}
                value={statusReason}
                onChange={(event) => setStatusReason(event.target.value)}
                placeholder="Shared credentials found during a review"
              />
            )}
          </FormField>
        </div>
      </Modal>

      <ConfirmDialog
        open={pending === 'reactivate'}
        title="Reactivate this hospital?"
        confirmLabel="Reactivate hospital"
        busy={lifecycle.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => lifecycle.mutate('reactivate')}
        description={
          <>
            <strong className="font-medium text-body">{hospital?.name}</strong> will return to
            approved status and its staff will be able to sign in again.
          </>
        }
      />

      <ConfirmDialog
        open={pending === 'approve'}
        title="Approve this hospital?"
        confirmLabel="Approve hospital"
        busy={lifecycle.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => lifecycle.mutate('approve')}
        description={
          <>
            <strong className="font-medium text-body">{hospital?.name}</strong> will be able to sign
            in and its administrator will gain full access to that hospital.
          </>
        }
      />
    </AppShell>
  )
}

function PlanDialog({
  open,
  currentPlan,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean
  currentPlan: string
  busy: boolean
  onClose: () => void
  onSubmit: (plan: string, reason?: string) => void
}) {
  const [plan, setPlan] = useState(currentPlan)
  const [why, setWhy] = useState('')

  /**
   * Re-seed whenever the dialog opens, so a previous selection never silently carries
   * over to the next hospital.
   *
   * Done during render using React's documented "adjust state when props change"
   * pattern, not in an effect: an effect here would render once with the stale plan
   * first, and the lint rule is right to treat `setState` inside `useMemo` as a
   * potential infinite loop.
   */
  const [lastOpenedFor, setLastOpenedFor] = useState<string | null>(open ? currentPlan : null)
  if (open && lastOpenedFor !== currentPlan) {
    setLastOpenedFor(currentPlan)
    setPlan(currentPlan)
    setWhy('')
  }
  if (!open && lastOpenedFor !== null) {
    setLastOpenedFor(null)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change subscription plan"
      description="Assignment only. Nothing is charged and no payment is taken."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={busy}
            busyLabel="Saving, please wait"
            disabled={plan === currentPlan || plan === ''}
            onClick={() => onSubmit(plan, why.trim() || undefined)}
          >
            Save plan
          </Button>
        </>
      }
    >
      <FormField label="Plan" required hint="Seat limits are enforced by the API, not the browser.">
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            placeholder="Select a plan"
            value={plan}
            onChange={(event) => setPlan(event.target.value)}
            options={PLANS.map((value) => ({
              value,
              label: planLabel(value),
            }))}
          />
        )}
      </FormField>

      <div className="mt-4">
        <FormField label="Reason" hint="Optional, but useful when the change is later questioned.">
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              rows={2}
              aria-describedby={describedBy}
              value={why}
              onChange={(event) => setWhy(event.target.value)}
              placeholder="Contract upgraded after the pilot"
            />
          )}
        </FormField>
      </div>
    </Modal>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-body-subtle">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-body">{value}</dd>
    </div>
  )
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}
