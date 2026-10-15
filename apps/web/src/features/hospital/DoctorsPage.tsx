import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Stethoscope, UserPlus } from 'lucide-react'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { Modal } from '../../components/ui/Modal.js'
import { Pagination } from '../../components/ui/Pagination.js'
import { SearchInput } from '../../components/ui/SearchInput.js'
import { Select } from '../../components/ui/Select.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'

import {
  createDoctorProfile,
  fetchDepartments,
  fetchDoctors,
  fetchStaff,
  formatInr,
  parseInr,
  type DoctorProfile,
} from './api.js'

const PAGE_SIZE = 20

/**
 * Doctors.
 *
 * A doctor profile is *attached to* a staff account rather than created with one. The
 * profile holds professional data — council registration, specialities, fee — while the
 * account holds identity and access. Splitting them means suspending access does not
 * destroy a doctor's registration details, and the registration number has one owner.
 *
 * Because of that split, "new doctor" here means "attach a profile to an existing
 * DOCTOR account", and the picker lists those accounts from the real staff endpoint. It
 * does not offer a free-text user id, which would be a field a person has to go and look
 * up in a database.
 */
export function DoctorsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const canWrite = user !== null && hasPermission(user, 'doctor:write')
  const canReadDepartments = user !== null && hasPermission(user, 'department:read')

  const q = searchParams.get('q') ?? ''
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)

  const [notice, setNotice] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [userId, setUserId] = useState('')
  const [registrationNumber, setRegistrationNumber] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [fee, setFee] = useState('')

  const doctors = useQuery({
    queryKey: ['hospital', 'doctors', { page, q }],
    queryFn: ({ signal }) => fetchDoctors({ page, pageSize: PAGE_SIZE, q: q || undefined }, signal),
  })

  // Only fetched when the caller may read departments; a doctor-viewer without that
  // permission gets the list without the department column rather than a failed request.
  const departments = useQuery({
    queryKey: ['hospital', 'departments', 'picker'],
    queryFn: ({ signal }) => fetchDepartments({ pageSize: 100 }, signal),
    enabled: canReadDepartments,
  })

  const doctorUserIds = useMemo(
    () => new Set((doctors.data?.items ?? []).map((row) => row.userId)),
    [doctors.data],
  )

  // Only the unprofiled accounts are offered, so the form cannot submit a duplicate.
  const candidates = useQuery({
    queryKey: ['hospital', 'staff', 'doctor-candidates'],
    queryFn: ({ signal }) => fetchStaff({ page: 1, pageSize: 100, role: 'DOCTOR' }, signal),
    enabled: adding && canWrite,
  })

  useEffect(() => {
    if (page !== 1 && q !== '') {
      const next = new URLSearchParams(searchParams)
      next.delete('page')
      setSearchParams(next, { replace: true })
    }
  }, [q, page, searchParams, setSearchParams])

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (value === '') next.delete(key)
      else next.set(key, value)
    }
    next.delete('page')
    setSearchParams(next)
  }

  const create = useMutation({
    mutationFn: () =>
      createDoctorProfile({
        userId,
        registrationNumber,
        departmentId: departmentId || undefined,
        consultationFeeInPaise: parseInr(fee) ?? undefined,
      }),
    onSuccess: (created) => {
      setNotice(
        `A profile was created for ${created.fullName ?? created.email ?? 'the doctor'}. Add their schedule next.`,
      )
      setFormError(null)
      setAdding(false)
      setUserId('')
      setRegistrationNumber('')
      setDepartmentId('')
      setFee('')
      void queryClient.invalidateQueries({ queryKey: ['hospital'] })
    },
    onError: (error) => {
      setFormError(
        error instanceof ApiClientError ? error.message : 'The profile could not be created.',
      )
    },
  })

  const rows = doctors.data?.items ?? []
  const meta = doctors.data?.page
  const departmentName = useMemo(
    () => new Map((departments.data?.items ?? []).map((d) => [d.id, d.name])),
    [departments.data],
  )

  const columns = useMemo<Column<DoctorProfile>[]>(() => {
    const base: Column<DoctorProfile>[] = [
      {
        key: 'name',
        header: 'Doctor',
        cell: (row) => (
          <div className="min-w-0">
            <a
              href={`/doctors/${row.id}`}
              className="truncate font-medium text-infini-700 underline-offset-4 hover:underline"
            >
              {row.fullName ?? 'Unnamed account'}
            </a>
            <p className="truncate text-xs text-body-subtle">{row.email ?? '—'}</p>
          </div>
        ),
      },
      {
        key: 'speciality',
        header: 'Speciality',
        cell: (row) => (
          <span className="text-sm text-body-muted">{row.specialities[0] ?? '—'}</span>
        ),
        secondary: true,
      },
    ]

    if (canReadDepartments) {
      base.push({
        key: 'department',
        header: 'Department',
        cell: (row) => (
          <span className="whitespace-nowrap text-sm text-body-muted">
            {row.departmentId ? (departmentName.get(row.departmentId) ?? '—') : 'Unassigned'}
          </span>
        ),
        secondary: true,
      })
    }

    base.push({
      key: 'registration',
      header: 'Registration',
      // The server already masked this for anyone without doctor:write. Showing the
      // raw value here would be safe, but rendering it as a masked string keeps the
      // interface honest about what the person is actually looking at.
      cell: (row) =>
        row.registrationNumber ? (
          <span className="whitespace-nowrap font-mono text-xs text-body-muted">
            {row.registrationNumber}
          </span>
        ) : (
          <span className="text-xs text-body-subtle">—</span>
        ),
    })

    base.push({
      key: 'fee',
      header: 'Consultation',
      cell: (row) => (
        <span className="whitespace-nowrap text-sm text-body-muted">
          {row.consultationFeeInPaise > 0 ? formatInr(row.consultationFeeInPaise) : '—'}
        </span>
      ),
      secondary: true,
    })

    base.push({
      key: 'accepting',
      header: 'Booking',
      cell: (row) => (
        <Badge tone={row.isAcceptingNewPatients ? 'success' : 'neutral'}>
          {row.isAcceptingNewPatients ? 'Accepting' : 'Closed'}
        </Badge>
      ),
    })

    return base
  }, [canReadDepartments, departmentName])

  const available = (candidates.data?.items ?? []).filter(
    (member) => !doctorUserIds.has(member.userId),
  )

  return (
    <AppShell
      title="Doctors"
      breadcrumbs={[{ label: 'Clinical' }, { label: 'Doctors' }]}
      wide
      actions={
        canWrite ? (
          <Button
            leadingIcon={<UserPlus aria-hidden="true" className="size-4" />}
            onClick={() => {
              setAdding(true)
              setFormError(null)
            }}
          >
            New doctor profile
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

        <Card>
          <CardHeader
            title="Doctors"
            description={
              meta
                ? `${meta.total} ${meta.total === 1 ? 'doctor' : 'doctors'} match your filters.`
                : 'Professional profiles for the doctors working here.'
            }
            actions={
              <SearchInput
                value={q}
                onChange={(value) => update({ q: value })}
                placeholder="Search doctors…"
                label="Search doctors"
                className="w-full sm:w-72"
              />
            }
          />

          {doctors.isPending ? (
            <TableSkeleton
              rows={5}
              columns={5}
              caption="Doctors in this hospital, with speciality, registration and booking status"
            />
          ) : doctors.isError ? (
            <CardBody>
              <ErrorState
                title="Could not load doctors"
                message={
                  doctors.error instanceof ApiClientError
                    ? doctors.error.message
                    : 'The doctor list could not be retrieved.'
                }
                onRetry={() => void doctors.refetch()}
                retrying={doctors.isFetching}
              />
            </CardBody>
          ) : rows.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<Stethoscope aria-hidden="true" className="size-10" />}
                title={q ? 'No doctors match this search' : 'No doctors yet'}
                description={
                  q
                    ? 'Try a different term, or clear the search to see everyone.'
                    : 'A doctor needs an account before they can hold a profile. Add the account under Staff, then attach the profile here.'
                }
                action={
                  q ? (
                    <Button variant="secondary" onClick={() => setSearchParams(new URLSearchParams())}>
                      Clear search
                    </Button>
                  ) : canWrite ? (
                    <Button onClick={() => setAdding(true)}>New doctor profile</Button>
                  ) : undefined
                }
              />
            </CardBody>
          ) : (
            <>
              <DataTable
                caption="Doctors in this hospital, with speciality, registration and booking status"
                columns={columns}
                items={rows}
                rowKey={(row) => row.id}
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
        open={adding}
        onClose={() => {
          setAdding(false)
          setFormError(null)
        }}
        title="New doctor profile"
        description="Attaches professional details to an existing doctor account."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setAdding(false)
                setFormError(null)
              }}
            >
              Cancel
            </Button>
            <Button
              busy={create.isPending}
              disabled={userId === '' || registrationNumber.trim() === ''}
              onClick={() => {
                setFormError(null)
                create.mutate()
              }}
            >
              Create profile
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
            <Alert tone="danger" title="Could not create the profile">
              {formError}
            </Alert>
          ) : null}

          <FormField
            label="Doctor account"
            required
            hint="Accounts with the DOCTOR role that do not yet have a profile."
          >
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                placeholder={
                  candidates.isPending
                    ? 'Loading accounts…'
                    : available.length === 0
                      ? 'No unprofiled doctor accounts'
                      : 'Select a doctor'
                }
                options={available.map((member) => ({
                  value: member.userId,
                  label: `${member.fullName} — ${member.email}`,
                }))}
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
              />
            )}
          </FormField>

          <FormField
            label="Council registration number"
            required
            hint="Unique within this hospital. Stored masked and never written to the audit trail."
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                value={registrationNumber}
                maxLength={60}
                onChange={(event) => setRegistrationNumber(event.target.value)}
              />
            )}
          </FormField>

          {canReadDepartments ? (
            <FormField label="Department">
              {({ id }) => (
                <Select
                  id={id}
                  placeholder="Unassigned"
                  options={(departments.data?.items ?? []).map((d) => ({
                    value: d.id,
                    label: d.name,
                  }))}
                  value={departmentId}
                  onChange={(event) => setDepartmentId(event.target.value)}
                />
              )}
            </FormField>
          ) : null}

          <FormField label="Consultation fee" hint="In rupees, for example 1500.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                inputMode="decimal"
                value={fee}
                onChange={(event) => setFee(event.target.value)}
              />
            )}
          </FormField>
        </form>
      </Modal>
    </AppShell>
  )
}