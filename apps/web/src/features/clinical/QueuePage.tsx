import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Stethoscope } from 'lucide-react'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { Input } from '../../components/ui/Input.js'
import { Modal } from '../../components/ui/Modal.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'
import { hospitalToday } from '../clinic/api.js'

import { createConsultation, fetchQueue, type QueueEntry } from './api.js'

/**
 * The clinician's queue for one hospital-local day.
 *
 * The one question this screen exists to answer is "who still needs to be seen", so the
 * row that needs attention sorts first and the status badge says plainly whether a patient
 * has been written up.
 *
 * Times are rendered in the hospital's zone using the server's own `startAt` instant. No
 * conversion happens here — see `docs/TIMEZONE.md` for why that matters.
 */
export function QueuePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const canWrite = user !== null && hasPermission(user, 'consultation:write')

  const date = searchParams.get('date') ?? hospitalToday('Asia/Kolkata')
  const [starting, setStarting] = useState<QueueEntry | null>(null)

  const queue = useQuery({
    queryKey: ['hospital', 'queue', date],
    queryFn: ({ signal }) => fetchQueue(date, signal),
  })

  const setParam = (changes: Record<string, string>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (value === '') next.delete(key)
      else next.set(key, value)
    }
    setSearchParams(next)
  }

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['hospital'] })
  }

  const timezone = queue.data?.timezone ?? 'Asia/Kolkata'

  // Unseen patients first, then by time. A doctor opening this screen is looking for the
  // people they still owe an appointment to.
  const ordered = useMemo(() => {
    const source = queue.data?.items ?? []
    return [...source].sort((a, b) => {
      if (a.needsConsultation !== b.needsConsultation) {
        return a.needsConsultation ? -1 : 1
      }
      return a.startAt.localeCompare(b.startAt)
    })
  }, [queue.data])

  const columns: Column<QueueEntry>[] = [
    {
      key: 'time',
      header: 'Time',
      cell: (row) => (
        <span className="whitespace-nowrap font-medium">
          {new Date(row.startAt).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      ),
    },
    {
      key: 'patient',
      header: 'Patient',
      cell: (row) => (
        <a
          href={`/patients/${row.patientId}`}
          className="font-medium text-brand-700 underline-offset-4 hover:underline"
        >
          {row.patientName ?? 'Unknown patient'}
        </a>
      ),
    },
    {
      key: 'reason',
      header: 'Reason given',
      cell: (row) => (
        <span className="text-sm text-ink-muted">{row.reason ?? '—'}</span>
      ),
      secondary: true,
    },
    {
      key: 'state',
      header: 'Consultation',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          {row.needsConsultation ? (
            <Badge tone="warning">Not yet seen</Badge>
          ) : (
            <Badge tone={row.consultationStatus === 'FINALIZED' ? 'success' : 'info'}>
              {row.consultationStatus === 'FINALIZED' ? 'Finalized' : 'Draft'}
            </Badge>
          )}
          {row.status === 'CANCELLED' || row.status === 'NO_SHOW' ? (
            <Badge tone="neutral">{row.status === 'CANCELLED' ? 'Cancelled' : 'No show'}</Badge>
          ) : null}
        </div>
      ),
    },
  ]

  if (canWrite) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (row) =>
        row.consultationId ? (
          <Button size="sm" variant="outline" onClick={() => setStarting(row)}>
            Open record
          </Button>
        ) : (
          <Button size="sm" onClick={() => setStarting(row)}>
            Start consultation
          </Button>
        ),
    })
  }

  const pending = starting?.needsConsultation ? (starting.patientId ?? null) : null

  return (
    <AppShell
      title="My queue"
      breadcrumbs={[{ label: 'Clinical' }, { label: 'Queue' }]}
      wide
    >
      <div className="space-y-5">
        <Card>
          <CardHeader
            title={`Clinic day — ${date}`}
            description={`Times shown in the hospital's timezone (${timezone}).`}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Previous day"
                  onClick={() => setParam({ date: shiftDate(date, -1) })}
                >
                  <ChevronLeft aria-hidden="true" className="size-4" />
                </Button>

                <label htmlFor="queue-date" className="sr-only">
                  Date
                </label>
                <Input
                  id="queue-date"
                  type="date"
                  value={date}
                  onChange={(event) => setParam({ date: event.target.value })}
                  className="w-auto"
                />

                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Next day"
                  onClick={() => setParam({ date: shiftDate(date, 1) })}
                >
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Button>
              </div>
            }
          />

          {queue.isPending ? (
            <TableSkeleton
              rows={4}
              columns={columns.length}
              caption="Appointments in this clinician's queue for the day"
            />
          ) : queue.isError ? (
            <CardBody>
              <ErrorState
                title="Could not load your queue"
                message={
                  queue.error instanceof ApiClientError
                    ? queue.error.message
                    : 'The queue could not be retrieved.'
                }
                onRetry={() => void queue.refetch()}
                retrying={queue.isFetching}
              />
            </CardBody>
          ) : ordered.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<Stethoscope aria-hidden="true" className="size-10" />}
                title="Nobody booked in"
                description="There are no appointments in your queue for this day."
              />
            </CardBody>
          ) : (
            <DataTable
              caption="Appointments in this clinician's queue for the day, with whether each has been seen"
              columns={columns}
              items={ordered}
              rowKey={(row) => row.appointmentId}
            />
          )}
        </Card>
      </div>

      {starting ? (
        <StartConsultationDialog
          entry={starting}
          onClose={() => setStarting(null)}
          onStarted={(consultationId) => {
            setStarting(null)
            refresh()
            window.location.assign(`/consultations/${consultationId}`)
          }}
          patientIdOverride={pending}
        />
      ) : null}
    </AppShell>
  )
}

/** Navigate to an already-existing record rather than creating a second one. */
function StartConsultationDialog({
  entry,
  onClose,
  onStarted,
  patientIdOverride,
}: {
  entry: QueueEntry
  onClose: () => void
  onStarted: (consultationId: string) => void
  patientIdOverride: string | null
}) {
  const existing = entry.consultationId

  const create = useMutation({
    mutationFn: () =>
      createConsultation({
        patientId: patientIdOverride ?? entry.patientId,
        appointmentId: entry.appointmentId,
        // The appointment's own reason is not a clinical note — it is what the patient
        // said when booking. Pre-filling saves retyping without asserting anything the
        // clinician has not written themselves.
        chiefComplaint: entry.reason || undefined,
      }),
    onSuccess: (created) => onStarted(created.id),
  })

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? 'Open this consultation' : 'Start a consultation'}
      description={
        entry.patientName
          ? `A new clinical record for ${entry.patientName}. Nothing is shared with anyone who did not write it.`
          : 'A new clinical record. Nothing is shared with anyone who did not write it.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {existing ? (
            <Button onClick={() => onStarted(existing)}>Go to this record</Button>
          ) : (
            <Button
              busy={create.isPending}
              disabled={!patientIdOverride}
              onClick={() => create.mutate()}
            >
              Create draft
            </Button>
          )}
        </>
      }
    >
      {create.isError ? (
        <Alert tone="danger" title="Could not start the consultation">
          {create.error instanceof ApiClientError
            ? create.error.message
            : 'The consultation could not be created.'}
        </Alert>
      ) : (
        <p className="text-sm text-ink-muted">
          The record starts as a <strong>draft</strong> and stays private to you until you
          finalize it. Finalizing is permanent — afterwards, corrections are recorded as
          amendments rather than overwriting what was signed.
        </p>
      )}
    </Modal>
  )
}

function shiftDate(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}