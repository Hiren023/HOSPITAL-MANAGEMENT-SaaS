import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { UserPlus, Users } from 'lucide-react'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge, UserStatusBadge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { Modal } from '../../components/ui/Modal.js'
import { Pagination } from '../../components/ui/Pagination.js'
import { SearchInput } from '../../components/ui/SearchInput.js'
import { Select } from '../../components/ui/Select.js'
import { Textarea } from '../../components/ui/Textarea.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'

import {
  ASSIGNABLE_ROLES,
  changeStaffRole,
  createStaffAccount,
  fetchStaff,
  setStaffStatus,
  type StaffMember,
} from './api.js'

const PAGE_SIZE = 20

const ROLE_OPTIONS = ASSIGNABLE_ROLES.map((role) => ({ value: role, label: role }))

const STATUS_FILTER_OPTIONS = [
  { value: 'ACTIVE', label: 'Active membership' },
  { value: 'SUSPENDED', label: 'Suspended membership' },
  { value: 'REVOKED', label: 'Revoked membership' },
]

/**
 * Staff accounts.
 *
 * The role picker is built from `ASSIGNABLE_ROLES`, the same shared constant the server
 * validates against. That is not a convenience — it is what stops the interface offering
 * a role the API would refuse, and, more importantly, what makes it impossible to offer
 * SUPER_ADMIN here at all. The server rejects it independently; this just means the
 * refusal is never reached from a normal click.
 *
 * Creating an account sets a random password nobody ever sees, and the person must reset
 * it on first sign-in. That is the one honest option without an email service in scope,
 * and it is safer than shipping a default password.
 */
export function StaffPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const canWrite = user !== null && hasPermission(user, 'user:write')
  const canManage = user !== null && hasPermission(user, 'user:permissions:manage')
  const ownUserId = user?.userId ?? ''

  const q = searchParams.get('q') ?? ''
  const role = searchParams.get('role') ?? ''
  const membershipStatus = searchParams.get('membershipStatus') ?? ''
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)

  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [newRole, setNewRole] = useState<string>(ASSIGNABLE_ROLES[0] ?? 'STAFF')
  const [formError, setFormError] = useState<string | null>(null)

  const [roleTarget, setRoleTarget] = useState<StaffMember | null>(null)
  const [roleChoice, setRoleChoice] = useState<string>('')

  const [statusTarget, setStatusTarget] = useState<{
    member: StaffMember
    status: 'ACTIVE' | 'SUSPENDED'
  } | null>(null)
  const [reason, setReason] = useState('')

  const staff = useQuery({
    queryKey: ['hospital', 'staff', { page, q, role, membershipStatus }],
    queryFn: ({ signal }) =>
      fetchStaff(
        {
          page,
          pageSize: PAGE_SIZE,
          q: q || undefined,
          role: role || undefined,
          membershipStatus: membershipStatus || undefined,
        },
        signal,
      ),
  })

  useEffect(() => {
    if (page !== 1 && (q !== '' || role !== '' || membershipStatus !== '')) {
      const next = new URLSearchParams(searchParams)
      next.delete('page')
      setSearchParams(next, { replace: true })
    }
  }, [q, role, membershipStatus, page, searchParams, setSearchParams])

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (value === '') next.delete(key)
      else next.set(key, value)
    }
    next.delete('page')
    setSearchParams(next)
  }

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['hospital'] })

  const create = useMutation({
    mutationFn: () =>
      createStaffAccount({
        email,
        firstName,
        lastName,
        role: newRole,
      }),
    onSuccess: (created) => {
      setNotice(
        `${created.fullName} was added as ${created.role}. They set their own password on first sign-in.`,
      )
      setFormError(null)
      setCreating(false)
      setEmail('')
      setFirstName('')
      setLastName('')
      void invalidate()
    },
    onError: (error) => {
      setFormError(
        error instanceof ApiClientError ? error.message : 'The account could not be created.',
      )
    },
  })

  const changeRole = useMutation({
    mutationFn: () =>
      changeStaffRole(roleTarget?.userId ?? '', roleChoice),
    onSuccess: () => {
      setNotice(`${roleTarget?.fullName} is now a ${roleChoice}.`)
      setActionError(null)
      setRoleTarget(null)
      void invalidate()
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiClientError ? error.message : 'The role could not be changed.',
      )
      setRoleTarget(null)
    },
  })

  const changeStatus = useMutation({
    mutationFn: () =>
      setStaffStatus(statusTarget?.member.userId ?? '', statusTarget?.status ?? 'ACTIVE', reason),
    onSuccess: () => {
      setNotice(
        statusTarget?.status === 'SUSPENDED'
          ? `${statusTarget.member.fullName} can no longer sign in.`
          : `${statusTarget?.member.fullName} was reactivated.`,
      )
      setActionError(null)
      setStatusTarget(null)
      setReason('')
      void invalidate()
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiClientError ? error.message : 'The account could not be updated.',
      )
      setStatusTarget(null)
      setReason('')
    },
  })

  const rows = staff.data?.items ?? []
  const meta = staff.data?.page
  const hasFilters = q !== '' || role !== '' || membershipStatus !== ''

  const columns = useMemo<Column<StaffMember>[]>(() => {
    const base: Column<StaffMember>[] = [
      {
        key: 'name',
        header: 'Member',
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate font-medium">
              {row.fullName}
              {row.userId === ownUserId ? (
                <span className="ml-2 text-xs text-body-subtle">(you)</span>
              ) : null}
            </p>
            <p className="truncate text-xs text-body-subtle">{row.email}</p>
          </div>
        ),
      },
      {
        key: 'role',
        header: 'Role',
        cell: (row) => <Badge tone="info">{row.role ?? 'None'}</Badge>,
      },
      {
        key: 'status',
        header: 'Account',
        cell: (row) => <UserStatusBadge status={row.accountStatus} />,
      },
    ]

    if (canManage) {
      base.push({
        key: 'actions',
        header: <span className="sr-only">Actions</span>,
        cell: (row) => (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setRoleTarget(row)
                setRoleChoice(row.role ?? '')
              }}
            >
              Role
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStatusTarget({
                  member: row,
                  status: row.accountStatus === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED',
                })
                setReason('')
              }}
            >
              {row.accountStatus === 'SUSPENDED' ? 'Reactivate' : 'Suspend'}
            </Button>
          </div>
        ),
      })
    }

    return base
  }, [canManage, ownUserId])

  return (
    <AppShell
      title="Staff and users"
      breadcrumbs={[{ label: 'Operations' }, { label: 'Staff' }]}
      wide
      actions={
        canWrite ? (
          <Button
            leadingIcon={<UserPlus aria-hidden="true" className="size-4" />}
            onClick={() => {
              setCreating(true)
              setFormError(null)
            }}
          >
            New staff account
          </Button>
        ) : undefined
      }
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
            title="Staff"
            description={
              meta
                ? `${meta.total} ${meta.total === 1 ? 'person' : 'people'} match your filters.`
                : 'Everyone with access to this hospital.'
            }
            actions={
              <SearchInput
                value={q}
                onChange={(value) => update({ q: value })}
                placeholder="Search name or email…"
                label="Search staff"
                className="w-full sm:w-72"
              />
            }
          />

          <div
            role="group"
            aria-label="Filter staff"
            className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3"
          >
            <div className="w-full sm:w-48">
              <label htmlFor="role-filter" className="mb-1 block text-xs font-medium text-body-muted">
                Role
              </label>
              <Select
                id="role-filter"
                placeholder="All roles"
                options={ROLE_OPTIONS}
                value={role}
                onChange={(event) => update({ role: event.target.value })}
              />
            </div>

            <div className="w-full sm:w-52">
              <label
                htmlFor="membership-filter"
                className="mb-1 block text-xs font-medium text-body-muted"
              >
                Membership
              </label>
              <Select
                id="membership-filter"
                placeholder="Any membership"
                options={STATUS_FILTER_OPTIONS}
                value={membershipStatus}
                onChange={(event) => update({ membershipStatus: event.target.value })}
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

          {staff.isPending ? (
            <TableSkeleton
              rows={5}
              columns={canManage ? 4 : 3}
              caption="Staff accounts in this hospital, with role and status"
            />
          ) : staff.isError ? (
            <CardBody>
              <ErrorState
                title="Could not load staff"
                message={
                  staff.error instanceof ApiClientError
                    ? staff.error.message
                    : 'The staff list could not be retrieved.'
                }
                onRetry={() => void staff.refetch()}
                retrying={staff.isFetching}
              />
            </CardBody>
          ) : rows.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<Users aria-hidden="true" className="size-10" />}
                title={hasFilters ? 'Nobody matches these filters' : 'No staff accounts yet'}
                description={
                  hasFilters
                    ? 'Adjust the filters or clear them to see everyone.'
                    : 'Add reception, pharmacy, accounting and clinical staff here, and give each the role they need.'
                }
                action={
                  hasFilters ? (
                    <Button variant="secondary" onClick={() => setSearchParams(new URLSearchParams())}>
                      Clear filters
                    </Button>
                  ) : canWrite ? (
                    <Button onClick={() => setCreating(true)}>New staff account</Button>
                  ) : undefined
                }
              />
            </CardBody>
          ) : (
            <>
              <DataTable
                caption="Staff accounts in this hospital, with role and status"
                columns={columns}
                items={rows}
                rowKey={(row) => row.userId}
              />
              <div className="border-t border-line px-5 py-3">
                <Pagination
                  page={meta?.page ?? 1}
                  pageCount={meta?.totalPages ?? 1}
                  total={meta?.total}
                  onPageChange={(next) => {
                    const params = new URLSearchParams(searchParams)
                    params.set('page', String(next))
                    setSearchParams(params)
                  }}
                />
              </div>
            </>
          )}
        </Card>
      </div>

      <Modal
        open={creating}
        onClose={() => {
          setCreating(false)
          setFormError(null)
        }}
        title="New staff account"
        description="They set their own password the first time they sign in."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setCreating(false)
                setFormError(null)
              }}
            >
              Cancel
            </Button>
            <Button
              busy={create.isPending}
              disabled={
                email.trim() === '' || firstName.trim() === '' || lastName.trim() === ''
              }
              onClick={() => {
                setFormError(null)
                create.mutate()
              }}
            >
              Create account
            </Button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          {formError ? (
            <Alert tone="danger" title="Could not create the account">
              {formError}
            </Alert>
          ) : null}

          <FormField label="Email" required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="email"
                autoComplete="off"
                aria-describedby={describedBy}
                invalid={invalid}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="First name" required>
              {({ id, invalid }) => (
                <Input
                  id={id}
                  invalid={invalid}
                  value={firstName}
                  maxLength={100}
                  onChange={(event) => setFirstName(event.target.value)}
                />
              )}
            </FormField>

            <FormField label="Last name" required>
              {({ id, invalid }) => (
                <Input
                  id={id}
                  invalid={invalid}
                  value={lastName}
                  maxLength={100}
                  onChange={(event) => setLastName(event.target.value)}
                />
              )}
            </FormField>
          </div>

          {/*
            `ASSIGNABLE_ROLES` excludes SUPER_ADMIN and PATIENT, so there is no option to
            grant a platform role from here and no option that would be refused.
          */}
          <FormField label="Role" required>
            {({ id }) => (
              <Select
                id={id}
                options={ROLE_OPTIONS}
                value={newRole}
                onChange={(event) => setNewRole(event.target.value)}
              />
            )}
          </FormField>
        </form>
      </Modal>

      <Modal
        open={roleTarget !== null}
        onClose={() => setRoleTarget(null)}
        title="Change role"
        description={roleTarget ? `Change what ${roleTarget.fullName} may do.` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRoleTarget(null)}>
              Cancel
            </Button>
            <Button
              busy={changeRole.isPending}
              disabled={roleChoice === ''}
              onClick={() => changeRole.mutate()}
            >
              Change role
            </Button>
          </>
        }
      >
        <FormField label="Role" required>
          {({ id }) => (
            <Select
              id={id}
              options={ROLE_OPTIONS}
              value={roleChoice}
              onChange={(event) => setRoleChoice(event.target.value)}
            />
          )}
        </FormField>
      </Modal>

      {/*
        A Modal rather than ConfirmDialog: suspending needs a written reason, and the
        dialog component deliberately accepts only a description. The reason is not
        decoration — it goes into the audit trail and is the only record of why somebody
        lost access.
      */}
      <Modal
        open={statusTarget !== null}
        onClose={() => {
          setStatusTarget(null)
          setReason('')
        }}
        title={
          statusTarget?.status === 'SUSPENDED' ? 'Suspend this account' : 'Reactivate this account'
        }
        description={
          statusTarget?.status === 'SUSPENDED'
            ? `${statusTarget.member.fullName} will be refused at sign-in immediately. Their professional records are untouched.`
            : `${statusTarget?.member.fullName ?? 'This person'} will be able to sign in again.`
        }
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setStatusTarget(null)
                setReason('')
              }}
            >
              Cancel
            </Button>
            <Button
              variant={statusTarget?.status === 'SUSPENDED' ? 'danger' : 'primary'}
              busy={changeStatus.isPending}
              disabled={reason.trim().length < 10}
              onClick={() => {
                setActionError(null)
                changeStatus.mutate()
              }}
            >
              {statusTarget?.status === 'SUSPENDED' ? 'Suspend account' : 'Reactivate'}
            </Button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (reason.trim().length >= 10) changeStatus.mutate()
          }}
        >
          <FormField
            label="Reason"
            required
            hint="Recorded in the audit trail. At least 10 characters."
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={3}
                maxLength={500}
                aria-describedby={describedBy}
                invalid={invalid}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </FormField>
        </form>
      </Modal>
    </AppShell>
  )
}