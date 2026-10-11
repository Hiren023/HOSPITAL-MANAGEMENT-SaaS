import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ScrollText } from 'lucide-react'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { Modal } from '../../components/ui/Modal.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'

import { fetchAuditEvents, type AuditEvent } from './api.js'

const LIMIT = 25

/**
 * Platform audit trail.
 *
 * Cursor-paginated, never offset. The trail is append-only and unbounded: with
 * `skip`/`offset`, an event written while an operator scrolls shifts the window and
 * produces a view with gaps or duplicates — and a gap in an audit trail reads as
 * tampering, even when it is only a pagination artefact. Each page ends where the last
 * one stopped.
 *
 * Filtering is server-side and strictly validated, so a search term can never reach
 * MongoDB as an operator. The metadata shown is redacted again on read, in case a value
 * reached storage by a route the writer did not cover.
 */
export function PlatformAuditPage() {
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [history, setHistory] = useState<Array<{ cursor: string | undefined; label: string }>>([
    { cursor: undefined, label: 'Start' },
  ])
  const [action, setAction] = useState('')
  const [q, setQ] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [actorFilter, setActorFilter] = useState('')
  const [actorValue, setActorValue] = useState('')

  const filters = useMemo(
    () => ({
      q: q || undefined,
      action: action || undefined,
      actorUserId: actorFilter || undefined,
    }),
    [q, action, actorFilter],
  )

  const events = useQuery({
    queryKey: ['platform', 'audit', { cursor, ...filters }],
    queryFn: ({ signal }) => fetchAuditEvents({ cursor, limit: LIMIT, ...filters }, signal),
    // Audit entries never change once written, so a cached page stays correct.
    staleTime: 15_000,
  })

  const rows = events.data?.items ?? []

  const goNext = () => {
    const next = events.data?.nextCursor
    if (!next) return
    setCursor(next)
    setHistory((previous) => [...previous, { cursor: next, label: `Page ${previous.length + 1}` }])
  }

  const goTo = (index: number) => {
    const entry = history[index]
    if (!entry) return
    setCursor(entry.cursor)
    setHistory((previous) => previous.slice(0, index + 1))
  }

  const resetPaging = () => {
    setCursor(undefined)
    setHistory([{ cursor: undefined, label: 'Start' }])
  }

  const columns = useMemo<Column<AuditEvent>[]>(
    () => [
      {
        key: 'when',
        header: 'When',
        cell: (row) => (
          <span className="whitespace-nowrap text-ink-muted">
            {new Date(row.createdAt).toLocaleString('en-IN', {
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
        ),
      },
      {
        key: 'action',
        header: 'Action',
        cell: (row) => <code className="font-mono text-xs text-ink">{row.action}</code>,
      },
      {
        key: 'role',
        header: 'Actor',
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-ink">{row.actorRole ?? 'system'}</p>
            <p className="truncate font-mono text-[0.6875rem] text-ink-subtle">
              {row.actorUserId ? row.actorUserId.slice(-8) : '—'}
            </p>
          </div>
        ),
      },
      {
        key: 'tenant',
        header: 'Tenant',
        cell: (row) => (
          <span className="font-mono text-xs text-ink-subtle">
            {row.hospitalId ? row.hospitalId.slice(-8) : 'platform'}
          </span>
        ),
        secondary: true,
      },
      {
        key: 'outcome',
        header: 'Outcome',
        cell: (row) => (
          <Badge
            tone={
              row.outcome === 'SUCCESS'
                ? 'success'
                : row.outcome === 'DENIED'
                  ? 'danger'
                  : 'neutral'
            }
          >
            {row.outcome ?? '—'}
          </Badge>
        ),
      },
      {
        key: 'details',
        header: <span className="sr-only">Details</span>,
        cell: (row) => (
          <Button
            size="sm"
            variant="ghost"
            disabled={!row.metadata || Object.keys(row.metadata).length === 0}
            onClick={() => {
              setActorFilter(row.actorUserId ?? '')
              setActorValue(row.actorUserId ?? '')
              setFiltersOpen(true)
            }}
          >
            Details
          </Button>
        ),
      },
    ],
    [],
  )

  const hasFilters = q !== '' || action !== '' || actorFilter !== ''

  return (
    <AppShell
      title="Audit trail"
      breadcrumbs={[{ label: 'Platform' }, { label: 'Audit trail' }]}
      wide
    >
      <div className="space-y-5">
        <Alert tone="info" title="What is recorded here">
          Every administrative action across all tenants, newest first. Metadata is redacted on
          write and again on read, so credentials and clinical detail never appear — and no patient
          identifier is stored here in the first place.
        </Alert>

        <Card>
          <CardHeader
            title="Platform audit log"
            description="Append-only. Entries are never edited or deleted."
            actions={
              <Button variant="secondary" size="sm" onClick={() => setFiltersOpen(true)}>
                Filters
              </Button>
            }
          />

          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
            <label htmlFor="audit-search" className="sr-only">
              Search actions
            </label>
            <div className="min-w-[12rem] flex-1">
              <Input
                id="audit-search"
                type="search"
                placeholder="Search action or resource type…"
                value={q}
                onChange={(event) => {
                  setQ(event.target.value)
                  resetPaging()
                }}
              />
            </div>

            {hasFilters ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQ('')
                  setAction('')
                  setActorFilter('')
                  resetPaging()
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </div>

          {events.isPending ? (
            <TableSkeleton rows={8} columns={6} caption="Audit events across all tenants" />
          ) : events.isError ? (
            <CardBody>
              <ErrorState
                title="Could not load the audit trail"
                message={
                  events.error instanceof ApiClientError
                    ? events.error.message
                    : 'The audit log could not be retrieved.'
                }
                onRetry={() => void events.refetch()}
                retrying={events.isFetching}
              />
            </CardBody>
          ) : rows.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<ScrollText aria-hidden="true" className="size-10" />}
                title={hasFilters ? 'No events match these filters' : 'No audit events yet'}
                description={
                  hasFilters
                    ? 'Widen the filters, or start again from the beginning of the trail.'
                    : 'Administrative actions will appear here as they happen.'
                }
                action={
                  hasFilters ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setQ('')
                        setAction('')
                        setActorFilter('')
                        resetPaging()
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </CardBody>
          ) : (
            <DataTable
              caption="Audit events across all tenants, newest first, with actor and outcome"
              columns={columns}
              items={rows}
              rowKey={(row) => row.id}
            />
          )}

          {/* Cursor paging, presented as back/forward rather than page numbers: the API
              exposes no total, and inventing a page count would be a fiction. */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
            <p aria-live="polite" className="text-xs text-ink-muted">
              {rows.length} event{rows.length === 1 ? '' : 's'} on this page
            </p>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={history.length <= 1}
                onClick={() => goTo(history.length - 2)}
              >
                Previous
              </Button>

              {history.length > 1 ? (
                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  <span className="sr-only sm:not-sr-only">Position</span>
                  <select
                    aria-label="Position in the trail"
                    className="rounded-lg border border-line-strong bg-white px-2 py-1 text-sm"
                    value={history.length - 1}
                    onChange={(event) => goTo(Number(event.target.value))}
                  >
                    {history.map((entry, index) => (
                      <option key={`${entry.label}-${index}`} value={index}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <Button
                size="sm"
                variant="secondary"
                disabled={!events.data?.nextCursor}
                onClick={goNext}
              >
                Load more
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <Modal
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filter the audit trail"
        description="Filters are applied by the API, so results reflect the whole trail."
        footer={
          <Button
            onClick={() => {
              setFiltersOpen(false)
              resetPaging()
            }}
          >
            Apply
          </Button>
        }
      >
        <div className="space-y-4">
          <FormField
            label="Action code"
            hint="Exact match, e.g. hospital.suspended. Partial codes are not accepted."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={action}
                onChange={(event) => setAction(event.target.value.trim())}
                placeholder="hospital.suspended"
              />
            )}
          </FormField>

          <FormField
            label="Actor user id"
            hint="The exact id of the operator who performed the action."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={actorValue}
                onChange={(event) => setActorValue(event.target.value.trim())}
                placeholder="507f1f77bcf86cd799439011"
              />
            )}
          </FormField>
        </div>
      </Modal>
    </AppShell>
  )
}
