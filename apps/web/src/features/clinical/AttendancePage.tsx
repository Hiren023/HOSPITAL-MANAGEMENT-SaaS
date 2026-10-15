import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { CalendarCheck, Users } from 'lucide-react'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { Modal } from '../../components/ui/Modal.js'
import { Textarea } from '../../components/ui/Textarea.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'
import { hospitalToday } from '../clinic/api.js'

import {
  checkIn,
  checkOut,
  decideAttendanceCorrection,
  fetchMyAttendance,
  fetchTeamAttendance,
  requestAttendanceCorrection,
  type AttendanceRecord,
} from './api.js'

/**
 * Attendance.
 *
 * Two things on this screen are deliberate and worth stating to anyone changing it:
 *
 * 1. **Check-in and check-out send no timestamp.** The server owns the clock. A control
 *    that let someone type their own arrival time would make the whole record worthless,
 *    so the buttons here take nothing and the times shown are always the server's.
 *
 * 2. **There is no "edit" button, anywhere.** Changing a recorded time is a *request*
 *    with a reason, which someone else approves. That is the whole point of keeping the
 *    record: it must not be adjustable by the person it describes.
 */
export function AttendancePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const canRecord = user !== null && hasPermission(user, 'attendance:write')
  const canSeeTeam = user !== null && hasPermission(user, 'attendance:read:any')
  const canApprove = user !== null && hasPermission(user, 'attendance:approve')

  const date = searchParams.get('date') ?? hospitalToday('Asia/Kolkata')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requesting, setRequesting] = useState<AttendanceRecord | null>(null)

  const mine = useQuery({
    queryKey: ['hospital', 'attendance', 'me', date],
    queryFn: ({ signal }) => fetchMyAttendance(date, signal),
  })

  const team = useQuery({
    queryKey: ['hospital', 'attendance', 'team', date],
    queryFn: ({ signal }) => fetchTeamAttendance(date, signal),
    enabled: canSeeTeam,
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['hospital', 'attendance'] })
  }

  const checkInNow = useMutation({
    mutationFn: checkIn,
    onSuccess: () => {
      setNotice('Checked in. The time recorded is the server’s.')
      setError(null)
      refresh()
    },
    onError: (cause) => setError(messageFor(cause, 'You could not be checked in.')),
  })

  const checkOutNow = useMutation({
    mutationFn: checkOut,
    onSuccess: () => {
      setNotice('Checked out.')
      setError(null)
      refresh()
    },
    onError: (cause) => setError(messageFor(cause, 'You could not be checked out.')),
  })

  const today = mine.data?.items[0]
  const openNow = today !== undefined && today.checkOutAt === null

  const myColumns: Column<AttendanceRecord>[] = [
    {
      key: 'date',
      header: 'Day',
      cell: (row) => <span className="whitespace-nowrap font-medium">{row.workDate}</span>,
    },
    {
      key: 'in',
      header: 'Checked in',
      cell: (row) => <span className="whitespace-nowrap text-sm">{formatTime(row.checkInAt)}</span>,
    },
    {
      key: 'out',
      header: 'Checked out',
      cell: (row) => (
        <span className="whitespace-nowrap text-sm">
          {row.checkOutAt ? formatTime(row.checkOutAt) : '—'}
        </span>
      ),
    },
    {
      key: 'hours',
      header: 'Hours',
      cell: (row) => (
        <span className="whitespace-nowrap text-sm text-body-muted">
          {row.hoursWorked === null ? '—' : row.hoursWorked.toFixed(2)}
        </span>
      ),
      secondary: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(row.status)}>{row.status}</Badge>
          {row.corrections.some((entry) => entry.decision === null) ? (
            <Badge tone="warning">Correction pending</Badge>
          ) : null}
        </div>
      ),
    },
  ]

  if (canRecord && today) {
    myColumns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (row) => (
        <Button size="sm" variant="ghost" onClick={() => setRequesting(row)}>
          Request a correction
        </Button>
      ),
    })
  }

  const teamColumns: Column<AttendanceRecord>[] = [
    {
      key: 'who',
      header: 'Person',
      cell: (row) => <span className="font-medium">{row.userName ?? 'Unknown'}</span>,
    },
    {
      key: 'in',
      header: 'In',
      cell: (row) => <span className="whitespace-nowrap text-sm">{formatTime(row.checkInAt)}</span>,
    },
    {
      key: 'out',
      header: 'Out',
      cell: (row) => (
        <span className="whitespace-nowrap text-sm">
          {row.checkOutAt ? formatTime(row.checkOutAt) : '—'}
        </span>
      ),
    },
    {
      key: 'hours',
      header: 'Hours',
      cell: (row) => (
        <span className="whitespace-nowrap text-sm text-body-muted">
          {row.hoursWorked === null ? '—' : row.hoursWorked.toFixed(2)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone(row.status)}>{row.status}</Badge>
          {row.corrections
            .filter((entry) => entry.decision === null)
            .map((entry) => (
              <Badge key={entry.requestedAt ?? entry.reason} tone="warning">
                Correction pending
              </Badge>
            ))}
        </div>
      ),
    },
  ]

  if (canApprove) {
    teamColumns.push({
      key: 'approve',
      header: <span className="sr-only">Decide corrections</span>,
      cell: (row) => {
        const pending = row.corrections.find((entry) => entry.decision === null)
        if (!pending) return <span className="text-xs text-body-subtle">Nothing to decide</span>
        return (
          <CorrectionDecision
            recordId={row.id}
            field={pending.field}
            requestedValue={pending.requestedValue}
            reason={pending.reason}
            onDone={(message) => {
              setNotice(message)
              refresh()
            }}
            onError={setError}
          />
        )
      },
    })
  }

  return (
    <AppShell
      title="Attendance"
      breadcrumbs={[{ label: 'People' }, { label: 'Attendance' }]}
      wide
    >
      <div className="space-y-5">
        {notice ? (
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        ) : null}
        {error ? (
          <Alert tone="danger" title="Could not complete that" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        ) : null}

        {canRecord ? (
          <Card>
            <CardHeader
              title={date}
              description="Your own record. The time comes from the server, not from this device."
              actions={
                <div className="flex gap-2">
                  <Button
                    busy={checkInNow.isPending}
                    disabled={today !== undefined}
                    onClick={() => checkInNow.mutate()}
                  >
                    {today ? 'Already checked in' : 'Check in'}
                  </Button>
                  <Button
                    variant="secondary"
                    busy={checkOutNow.isPending}
                    disabled={!openNow}
                    onClick={() => checkOutNow.mutate()}
                  >
                    Check out
                  </Button>
                </div>
              }
            />
            <CardBody>
              <p className="text-sm text-body-muted">
                If the recorded time is wrong, ask for a correction below. It does not change
                anything by itself — someone with approval responsibility decides.
              </p>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title="My attendance"
            description="Your recorded days."
            actions={
              <>
                <label htmlFor="attendance-date" className="sr-only">
                  Date
                </label>
                <Input
                  id="attendance-date"
                  type="date"
                  value={date}
                  onChange={(event) => {
                    const next = new URLSearchParams(searchParams)
                    next.set('date', event.target.value)
                    setSearchParams(next)
                  }}
                  className="w-auto"
                />
              </>
            }
          />

          {mine.isPending ? (
            <TableSkeleton rows={3} columns={5} caption="Your attendance record" />
          ) : mine.isError ? (
            <CardBody>
              <ErrorState
                title="Could not load your attendance"
                message={messageFor(mine.error, 'The record could not be retrieved.')}
                onRetry={() => void mine.refetch()}
                retrying={mine.isFetching}
              />
            </CardBody>
          ) : (mine.data?.items ?? []).length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<CalendarCheck aria-hidden="true" className="size-10" />}
                title="Nothing recorded"
                description="You have no attendance recorded for this day."
              />
            </CardBody>
          ) : (
            <DataTable
              caption="Your attendance record, with check-in, check-out and any pending corrections"
              columns={myColumns}
              items={mine.data?.items ?? []}
              rowKey={(row) => row.id}
            />
          )}
        </Card>

        {canSeeTeam ? (
          <Card>
            <CardHeader
              title="Team attendance"
              description="Everyone recorded on this day."
            />
            {team.isPending ? (
              <TableSkeleton rows={4} columns={5} caption="Team attendance for the day" />
            ) : team.isError ? (
              <CardBody>
                <ErrorState
                  title="Could not load team attendance"
                  message={messageFor(team.error, 'The team record could not be retrieved.')}
                  onRetry={() => void team.refetch()}
                  retrying={team.isFetching}
                />
              </CardBody>
            ) : (team.data?.items ?? []).length === 0 ? (
              <CardBody>
                <EmptyState
                  icon={<Users aria-hidden="true" className="size-10" />}
                  title="Nobody recorded"
                  description="No one has checked in on this day."
                />
              </CardBody>
            ) : (
              <DataTable
                caption="Team attendance for the day, with status and any corrections awaiting a decision"
                columns={teamColumns}
                items={team.data?.items ?? []}
                rowKey={(row) => row.id}
              />
            )}
          </Card>
        ) : null}
      </div>

      {requesting ? (
        <CorrectionRequestDialog
          record={requesting}
          onClose={() => setRequesting(null)}
          onDone={(message) => {
            setRequesting(null)
            setNotice(message)
            refresh()
          }}
          onError={setError}
        />
      ) : null}
    </AppShell>
  )
}

// ─────────────────────── correction request ───────────────────────

function CorrectionRequestDialog({
  record,
  onClose,
  onDone,
  onError,
}: {
  record: AttendanceRecord
  onClose: () => void
  onDone: (message: string) => void
  onError: (message: string) => void
}) {
  const [field, setField] = useState<'checkInAt' | 'checkOutAt'>(
    record.checkOutAt === null ? 'checkInAt' : 'checkOutAt',
  )
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')

  const request = useMutation({
    mutationFn: () =>
      requestAttendanceCorrection(record.id, {
        field,
        // A `datetime-local` value has no offset. Send it with the browser's own offset
        // attached, which is what the API requires — see `docs/TIMEZONE.md`.
        value: new Date(value).toISOString(),
        reason,
      }),
    onSuccess: () => onDone('Your correction was requested. Nothing has changed yet.'),
    onError: (cause) =>
      onError(messageFor(cause, 'The correction could not be requested.')),
  })

  return (
    <Modal
      open
      onClose={onClose}
      title="Request a correction"
      description="This does not change the record. Someone else decides."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={request.isPending}
            disabled={value === '' || reason.trim().length < 10}
            onClick={() => request.mutate()}
          >
            Send request
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          request.mutate()
        }}
      >
        <Alert tone="info">
          The recorded time stays exactly as it is until a correction is approved. Both the
          original and your requested time will be visible afterwards.
        </Alert>

        <FormField label="Which time?">
          {({ id }) => (
            <select
              id={id}
              value={field}
              onChange={(event) =>
                setField(event.target.value as 'checkInAt' | 'checkOutAt')
              }
              className="w-full rounded-md border border-line px-3 py-2 text-sm"
            >
              <option value="checkInAt">Checked in</option>
              <option value="checkOutAt" disabled={record.checkOutAt === null}>
                Checked out{record.checkOutAt === null ? ' (not yet)' : ''}
              </option>
            </select>
          )}
        </FormField>

        <FormField label="Correct time" required>
          {({ id }) => (
            <Input
              id={id}
              type="datetime-local"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </FormField>

        <FormField
          label="Why should this be changed?"
          required
          hint="At least 10 characters. Whoever approves this will read it."
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </FormField>
      </form>
    </Modal>
  )
}

// ─────────────────────── correction decision ───────────────────────

function CorrectionDecision({
  recordId,
  field,
  requestedValue,
  reason,
  onDone,
  onError,
}: {
  recordId: string
  field: string
  requestedValue: string | null
  reason: string
  onDone: (message: string) => void
  onError: (message: string) => void
}) {
  const [note, setNote] = useState('')
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null)

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      decideAttendanceCorrection(recordId, decision, note || undefined),
    onSuccess: (_, decision) => {
      setDeciding(null)
      onDone(
        decision === 'approve'
          ? 'The correction was approved and the record now shows both times.'
          : 'The correction was rejected. The original time is unchanged.',
      )
    },
    onError: (cause) => onError(messageFor(cause, 'The decision could not be recorded.')),
  })

  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-body-muted">
          {field === 'checkInAt' ? 'Check-in' : 'Check-out'} →{' '}
          {requestedValue ? formatTime(requestedValue) : '—'}
        </span>
        <span className="text-xs italic text-body-subtle">{reason}</span>
      </div>

      <div className="mt-1 flex gap-2">
        <Button size="sm" onClick={() => setDeciding('approve')}>
          Approve
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDeciding('reject')}>
          Reject
        </Button>
      </div>

      {deciding ? (
        <Modal
          open
          onClose={() => setDeciding(null)}
          title={deciding === 'approve' ? 'Approve this correction?' : 'Reject this correction?'}
          description={
            deciding === 'approve'
              ? 'The record will show the corrected time, with the original preserved alongside it.'
              : 'The record stays exactly as it is. The request and your reason are kept.'
          }
          footer={
            <>
              <Button variant="secondary" onClick={() => setDeciding(null)}>
                Cancel
              </Button>
              <Button
                variant={deciding === 'approve' ? 'primary' : 'danger'}
                busy={decide.isPending}
                onClick={() => decide.mutate(deciding)}
              >
                {deciding === 'approve' ? 'Approve' : 'Reject'}
              </Button>
            </>
          }
        >
          <FormField label="Note (optional)">
            {({ id }) => (
              <Textarea
                id={id}
                rows={2}
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            )}
          </FormField>
        </Modal>
      ) : null}
    </>
  )
}

function statusTone(status: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (status === 'OPEN') return 'info'
  if (status === 'CLOSED') return 'success'
  if (status === 'CORRECTED') return 'warning'
  return 'neutral'
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
