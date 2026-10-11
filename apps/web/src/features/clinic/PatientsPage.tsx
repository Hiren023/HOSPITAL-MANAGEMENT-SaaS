import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { UserPlus, Users } from 'lucide-react'

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
  ageFrom,
  checkDuplicate,
  fetchPatients,
  registerPatient,
  type DuplicateMatch,
  type Patient,
} from './api.js'

const PAGE_SIZE = 20

const GENDER_OPTIONS = [
  { value: 'FEMALE', label: 'Female' },
  { value: 'MALE', label: 'Male' },
  { value: 'TRANSGENDER', label: 'Transgender' },
  { value: 'OTHER', label: 'Other' },
  { value: 'UNDECLARED', label: 'Prefer not to say' },
]

interface Draft {
  firstName: string
  lastName: string
  dateOfBirth: string
  gender: string
  phone: string
  email: string
  city: string
  stateName: string
}

const EMPTY: Draft = {
  firstName: '',
  lastName: '',
  dateOfBirth: '',
  gender: 'UNDECLARED',
  phone: '',
  email: '',
  city: '',
  stateName: '',
}

/**
 * Patient register.
 *
 * Search, filtering and paging are server-side, as everywhere else in this product.
 *
 * A patient without a phone number AND without an email is refused by the API, because a
 * record nobody can be contacted on is a record that cannot be used. The button therefore
 * reflects that requirement rather than letting someone fill the whole form and be
 * rejected at the end.
 */
export function PatientsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const canWrite = user !== null && hasPermission(user, 'patient:write')

  const q = searchParams.get('q') ?? ''
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)

  const [notice, setNotice] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [matches, setMatches] = useState<DuplicateMatch[] | null>(null)

  const patients = useQuery({
    queryKey: ['hospital', 'patients', { page, q }],
    queryFn: ({ signal }) =>
      fetchPatients({ page, pageSize: PAGE_SIZE, q: q || undefined }, signal),
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
      registerPatient({
        firstName: draft?.firstName ?? '',
        lastName: draft?.lastName ?? '',
        dateOfBirth: draft?.dateOfBirth ?? '',
        gender: draft?.gender,
        phone: draft?.phone || undefined,
        email: draft?.email || undefined,
        address: { city: draft?.city || undefined, state: draft?.stateName || undefined },
      }),
    onSuccess: (created) => {
      setNotice(
        `${created.firstName} ${created.lastName} was registered as ${created.patientNumber}.`,
      )
      setFormError(null)
      setDraft(null)
      setMatches(null)
      void queryClient.invalidateQueries({ queryKey: ['hospital'] })
    },
    onError: (error) => {
      setFormError(
        error instanceof ApiClientError ? error.message : 'The patient could not be registered.',
      )
    },
  })

  const rows = patients.data?.items ?? []
  const meta = patients.data?.page

  const columns: Column<Patient>[] = [
    {
      key: 'name',
      header: 'Patient',
      cell: (row) => {
        return (
          <div className="min-w-0">
            <a
              href={`/patients/${row.id}`}
              className="truncate font-medium text-brand-700 underline-offset-4 hover:underline"
            >
              {row.firstName} {row.lastName}
            </a>
            <p className="truncate font-mono text-xs text-ink-subtle">{row.patientNumber}</p>
          </div>
        )
      },
    },
    {
      key: 'age',
      header: 'Age',
      cell: (row) => (
        <span className="whitespace-nowrap text-sm text-ink-muted">
          {ageFrom(row.dateOfBirth) ?? '—'}
        </span>
      ),
      secondary: true,
    },
    {
      key: 'gender',
      header: 'Gender',
      cell: (row) => (
        <span className="whitespace-nowrap text-sm text-ink-muted">
          {row.gender === 'UNDECLARED' ? '—' : row.gender}
        </span>
      ),
      secondary: true,
    },
    {
      key: 'contact',
      header: 'Contact',
      // The server has already decided what this caller may see. Rendering the masked
      // state explicitly is more honest than a blank cell that reads as missing data.
      cell: (row) =>
        row.contactVisible ? (
          <span className="whitespace-nowrap text-sm text-ink-muted">{row.phone ?? '—'}</span>
        ) : (
          <span className="whitespace-nowrap text-xs text-ink-subtle">
            hidden — read-only access
          </span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge tone={row.isActive ? 'success' : 'neutral'}>
          {row.isActive ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
  ]

  return (
    <AppShell
      title="Patients"
      breadcrumbs={[{ label: 'Clinical' }, { label: 'Patients' }]}
      wide
      actions={
        canWrite ? (
          <Button
            leadingIcon={<UserPlus aria-hidden="true" className="size-4" />}
            onClick={() => {
              setDraft(EMPTY)
              setFormError(null)
              setMatches(null)
            }}
          >
            Register patient
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
            title="Patient register"
            description={
              meta
                ? `${meta.total} ${meta.total === 1 ? 'patient' : 'patients'} match your search.`
                : 'Everyone registered at this hospital.'
            }
            actions={
              <SearchInput
                value={q}
                onChange={(value) => update({ q: value })}
                placeholder="Search by name…"
                label="Search patients"
                className="w-full sm:w-72"
              />
            }
          />

          {patients.isPending ? (
            <TableSkeleton
              rows={6}
              columns={5}
              caption="Patients registered at this hospital, with age, gender and contact details"
            />
          ) : patients.isError ? (
            <CardBody>
              <ErrorState
                title="Could not load patients"
                message={
                  patients.error instanceof ApiClientError
                    ? patients.error.message
                    : 'The patient register could not be retrieved.'
                }
                onRetry={() => void patients.refetch()}
                retrying={patients.isFetching}
              />
            </CardBody>
          ) : rows.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<Users aria-hidden="true" className="size-10" />}
                title={q ? 'No patients match this search' : 'No patients registered yet'}
                description={
                  q
                    ? 'Try a different name, or clear the search to see everyone.'
                    : 'Register the first patient to start booking appointments.'
                }
                action={
                  q ? (
                    <Button variant="secondary" onClick={() => setSearchParams(new URLSearchParams())}>
                      Clear search
                    </Button>
                  ) : canWrite ? (
                    <Button onClick={() => setDraft(EMPTY)}>Register patient</Button>
                  ) : undefined
                }
              />
            </CardBody>
          ) : (
            <>
              <DataTable
                caption="Patients registered at this hospital, with age, gender and contact details"
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
        open={draft !== null}
        onClose={() => {
          setDraft(null)
          setFormError(null)
          setMatches(null)
        }}
        title="Register a patient"
        description="Demographics only. Clinical detail belongs with the consultation."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(null)
                setFormError(null)
                setMatches(null)
              }}
            >
              Cancel
            </Button>
            <Button
              busy={create.isPending}
              disabled={
                draft === null ||
                draft.firstName.trim() === '' ||
                draft.lastName.trim() === '' ||
                draft.dateOfBirth === '' ||
                (draft.phone.trim() === '' && draft.email.trim() === '')
              }
              onClick={() => {
                setFormError(null)
                create.mutate()
              }}
            >
              Register
            </Button>
          </>
        }
      >
        {draft ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              create.mutate()
            }}
          >
            {formError ? (
              <Alert tone="danger" title="Could not register">
                {formError}
              </Alert>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="First name" required>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={draft.firstName}
                    maxLength={100}
                    onChange={(event) => {
                      const next = { ...draft, firstName: event.target.value }
                      setDraft(next)
                      void checkDuplicateFor(next)
                    }}
                  />
                )}
              </FormField>

              <FormField label="Last name" required>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={draft.lastName}
                    maxLength={100}
                    onChange={(event) => {
                      const next = { ...draft, lastName: event.target.value }
                      setDraft(next)
                      void checkDuplicateFor(next)
                    }}
                  />
                )}
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Date of birth" required>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="date"
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={draft.dateOfBirth}
                    onChange={(event) => {
                      const next = { ...draft, dateOfBirth: event.target.value }
                      setDraft(next)
                      void checkDuplicateFor(next)
                    }}
                  />
                )}
              </FormField>

              <FormField label="Gender">
                {({ id }) => (
                  <Select
                    id={id}
                    options={GENDER_OPTIONS}
                    value={draft.gender}
                    onChange={(event) => setDraft({ ...draft, gender: event.target.value })}
                  />
                )}
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Phone" hint="A phone number or an email is required.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="tel"
                    aria-describedby={describedBy}
                    value={draft.phone}
                    maxLength={20}
                    onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
                  />
                )}
              </FormField>

              <FormField label="Email">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="email"
                    aria-describedby={describedBy}
                    value={draft.email}
                    onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                  />
                )}
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="City">
                {({ id }) => (
                  <Input
                    id={id}
                    value={draft.city}
                    maxLength={80}
                    onChange={(event) => setDraft({ ...draft, city: event.target.value })}
                  />
                )}
              </FormField>

              <FormField label="State">
                {({ id }) => (
                  <Input
                    id={id}
                    value={draft.stateName}
                    maxLength={80}
                    onChange={(event) => setDraft({ ...draft, stateName: event.target.value })}
                  />
                )}
              </FormField>
            </div>

            {matches && matches.length > 0 ? (
              <Alert tone="warning" title="This may already be a patient here">
                <ul className="mt-1 space-y-1">
                  {matches.map((match) => (
                    <li key={match.id}>
                      <a href={`/patients/${match.id}`} className="underline underline-offset-2">
                        {match.patientNumber} — {match.firstName} {match.lastName}
                      </a>{' '}
                      (born {match.dateOfBirth})
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs">
                  Check before registering. Two people can share a name and a birthday, so
                  this is a warning rather than a block.
                </p>
              </Alert>
            ) : null}
          </form>
        ) : null}
      </Modal>
    </AppShell>
  )

  async function checkDuplicateFor(candidate: Draft): Promise<void> {
    if (!candidate.firstName || !candidate.lastName || !candidate.dateOfBirth) {
      setMatches(null)
      return
    }

    try {
      const result = await checkDuplicate({
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        dateOfBirth: candidate.dateOfBirth,
      })
      setMatches(result.matches.length > 0 ? result.matches : null)
    } catch {
      // A failed warning must never block registration.
      setMatches(null)
    }
  }
}
