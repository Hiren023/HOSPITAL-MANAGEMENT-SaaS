import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Bed, Plus } from 'lucide-react'

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
import { Textarea } from '../../components/ui/Textarea.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'

import { createDepartment, fetchDepartments, updateDepartment, type Department } from './api.js'

const PAGE_SIZE = 20

interface Draft {
  id: string | null
  name: string
  code: string
  description: string
}

const EMPTY_DRAFT: Draft = { id: null, name: '', code: '', description: '' }

/**
 * Departments.
 *
 * Search and paging are server-side, matching the platform console. A hospital's
 * department list is bounded by its plan, but relying on that to keep the payload small
 * would be relying on a business rule that a platform operator can change at any time —
 * the server returns the true total regardless.
 */
export function DepartmentsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const canWrite = user !== null && hasPermission(user, 'department:write')

  const q = searchParams.get('q') ?? ''
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)

  const [notice, setNotice] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  const departments = useQuery({
    queryKey: ['hospital', 'departments', { page, q }],
    queryFn: ({ signal }) =>
      fetchDepartments({ page, pageSize: PAGE_SIZE, q: q || undefined }, signal),
  })

  // A filter change invalidates the current page number: staying on page 4 after
  // narrowing the search shows "no results" for a query that does have matches.
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

  const save = useMutation({
    mutationFn: (value: Draft) =>
      value.id === null
        ? createDepartment({
            name: value.name,
            code: value.code,
            description: value.description || undefined,
          })
        : updateDepartment(value.id, {
            name: value.name,
            description: value.description || undefined,
          }),
    onSuccess: (saved) => {
      setNotice(
        draft?.id === null
          ? `Department “${saved.name}” was created.`
          : `Department “${saved.name}” was updated.`,
      )
      setFormError(null)
      setDraft(null)
      void queryClient.invalidateQueries({ queryKey: ['hospital'] })
    },
    onError: (error) => {
      setFormError(
        error instanceof ApiClientError ? error.message : 'The department could not be saved.',
      )
    },
  })

  const rows = departments.data?.items ?? []
  const meta = departments.data?.page

  const columns = useMemo<Column<Department>[]>(
    () => [
      {
        key: 'name',
        header: 'Department',
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.name}</p>
            <p className="truncate font-mono text-xs text-ink-subtle">{row.code}</p>
          </div>
        ),
      },
      {
        key: 'description',
        header: 'Description',
        cell: (row) => (
          <span className="text-sm text-ink-muted">{row.description || '—'}</span>
        ),
        secondary: true,
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
      {
        key: 'actions',
        header: <span className="sr-only">Actions</span>,
        cell: (row) =>
          canWrite ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setDraft({
                  id: row.id,
                  name: row.name,
                  code: row.code,
                  description: row.description ?? '',
                })
              }
            >
              Edit
            </Button>
          ) : (
            <span className="text-xs text-ink-subtle">—</span>
          ),
      },
    ],
    [canWrite],
  )

  return (
    <AppShell
      title="Departments"
      breadcrumbs={[{ label: 'Clinical' }, { label: 'Departments' }]}
      wide
      actions={
        canWrite ? (
          <Button leadingIcon={<Plus aria-hidden="true" className="size-4" />} onClick={() => setDraft(EMPTY_DRAFT)}>
            New department
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
            title="Clinical departments"
            description={
              meta
                ? `${meta.total} ${meta.total === 1 ? 'department' : 'departments'} match your filters.`
                : 'The wards and specialities this hospital runs.'
            }
            actions={
              <SearchInput
                value={q}
                onChange={(value) => update({ q: value })}
                placeholder="Search name, code or description…"
                label="Search departments"
                className="w-full sm:w-72"
              />
            }
          />

          {departments.isPending ? (
            <TableSkeleton
              rows={5}
              columns={4}
              caption="Departments in this hospital, with their status"
            />
          ) : departments.isError ? (
            <CardBody>
              <ErrorState
                title="Could not load departments"
                message={
                  departments.error instanceof ApiClientError
                    ? departments.error.message
                    : 'The department list could not be retrieved.'
                }
                onRetry={() => void departments.refetch()}
                retrying={departments.isFetching}
              />
            </CardBody>
          ) : rows.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<Bed aria-hidden="true" className="size-10" />}
                title={q ? 'No departments match this search' : 'No departments yet'}
                description={
                  q
                    ? 'Try a different term, or clear the search to see every department.'
                    : 'Departments group your doctors and give appointments and billing somewhere to point. Add your first one to get started.'
                }
                action={
                  q ? (
                    <Button variant="secondary" onClick={() => setSearchParams(new URLSearchParams())}>
                      Clear search
                    </Button>
                  ) : canWrite ? (
                    <Button onClick={() => setDraft(EMPTY_DRAFT)}>New department</Button>
                  ) : undefined
                }
              />
            </CardBody>
          ) : (
            <>
              <DataTable
                caption="Departments in this hospital, with their status"
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
        }}
        title={draft?.id === null ? 'New department' : 'Edit department'}
        description={
          draft?.id === null
            ? 'The code must be unique within this hospital.'
            : 'The code identifies the department and cannot be changed.'
        }
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(null)
                setFormError(null)
              }}
            >
              Cancel
            </Button>
            <Button
              busy={save.isPending}
              disabled={draft === null || draft.name.trim() === '' || draft.code.trim() === ''}
              onClick={() => {
                setFormError(null)
                if (draft) save.mutate(draft)
              }}
            >
              {draft?.id === null ? 'Create department' : 'Save changes'}
            </Button>
          </>
        }
      >
        {draft ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              save.mutate(draft)
            }}
          >
            {formError ? (
              <Alert tone="danger" title="Could not save">
                {formError}
              </Alert>
            ) : null}

            <FormField label="Name" required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={draft.name}
                  maxLength={120}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              )}
            </FormField>

            <FormField
              label="Code"
              required
              hint={
                draft.id === null
                  ? 'A short unique code, for example CARD.'
                  : undefined
              }
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={draft.code}
                  maxLength={20}
                  disabled={draft.id !== null}
                  onChange={(event) =>
                    setDraft({ ...draft, code: event.target.value.toUpperCase() })
                  }
                />
              )}
            </FormField>

            <FormField label="Description">
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  rows={3}
                  maxLength={500}
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              )}
            </FormField>
          </form>
        ) : null}
      </Modal>
    </AppShell>
  )
}