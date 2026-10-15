import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { CalendarDays, ChevronLeft, ChevronRight, Lock } from 'lucide-react'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { FormField } from '../../components/ui/FormField.js'
import { Modal } from '../../components/ui/Modal.js'
import { Textarea } from '../../components/ui/Textarea.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'

import {
  addDaysToKey,
  cancelAppointment,
  fetchAvailability,
  fetchDayView,
  statusTone,
  type Appointment,
} from './api.js'

import { BookAppointmentDialog } from './BookAppointmentDialog.js'
import { RescheduleDialog } from './RescheduleDialog.js'

const DEFAULT_TIMEZONE = 'Asia/Kolkata'

function todayInHospitalZone(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

interface Cancelling {
  appointment: Appointment
  reason: string
}

/**
 * The clinic day.
 *
 * Everything is expressed in the HOSPITAL's calendar day, which is the `date` query
 * parameter and is what the API groups by. The browser's own date is only used to seed
 * that parameter once — a user in another timezone must not silently land on the wrong
 * day's clinic.
 *
 * Booking does no timezone arithmetic in the browser. The server returns each free slot as
 * an ISO instant and the client sends one back verbatim, so there is no local-to-UTC
 * conversion here to get wrong near a DST transition.
 */
export function SchedulePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const canBook = user !== null && hasPermission(user, 'appointment:write')
  const canWriteAny = user !== null && hasPermission(user, 'appointment:write:any')

  const date = searchParams.get('date') ?? todayInHospitalZone()
  const view = searchParams.get('view') === 'week' ? 'week' : 'day'

  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [booking, setBooking] = useState<{ doctorUserId?: string; startAt?: string } | null>(null)
  const [cancelling, setCancelling] = useState<Cancelling | null>(null)
  const [rescheduling, setRescheduling] = useState<Appointment | null>(null)

  const setParam = (changes: Record<string, string>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (value === '') next.delete(key)
      else next.set(key, value)
    }
    setSearchParams(next)
  }

  // A doctor without `:any` gets their own day. The server narrows the query; this only
  // avoids asking for the whole clinic and showing an empty screen.
  const ownScheduleOnly = user !== null && !canWriteAny

  const day = useQuery({
    queryKey: ['hospital', 'schedule', date, view],
    queryFn: ({ signal }) =>
      fetchDayView(
        view === 'week'
          ? { date: weekStartFor(date) }
          : { date },
        signal,
      ),
    enabled: view === 'day',
  })

  const week = useQuery({
    queryKey: ['hospital', 'schedule', 'week', date],
    queryFn: ({ signal }) => fetchDayView({ date: weekStartFor(date) }, signal),
    enabled: view === 'week',
  })

  const availability = useQuery({
    queryKey: ['hospital', 'availability', date],
    queryFn: ({ signal }) => fetchAvailability({ date }, signal),
    enabled: view === 'day' && canBook,
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['hospital'] })
  }

  const cancel = useMutation({
    mutationFn: () =>
      cancelAppointment(cancelling?.appointment.id ?? '', cancelling?.reason ?? ''),
    onSuccess: () => {
      const who = cancelling?.appointment.patientName ?? 'the appointment'
      setNotice(`${who} was cancelled and the slot is free again.`)
      setActionError(null)
      setCancelling(null)
      invalidate()
    },
    onError: (error) => {
      setActionError(
        error instanceof ApiClientError ? error.message : 'The appointment could not be cancelled.',
      )
      setCancelling(null)
    },
  })

  const source = view === 'week' ? week : day
  const appointments = source.data?.appointments ?? []
  const timezone = source.data?.timezone ?? DEFAULT_TIMEZONE

  const columns: Column<Appointment>[] = (() => {
    const base: Column<Appointment>[] = []

    if (view === 'week') {
      base.push({
        key: 'day',
        header: 'Day',
        cell: (row) => (
          <span className="whitespace-nowrap text-sm">
            {new Date(row.startAt).toLocaleDateString(undefined, {
              weekday: 'short',
              day: '2-digit',
              month: 'short',
            })}
          </span>
        ),
      })
    }

    base.push(
      {
        key: 'time',
        header: 'Time',
        // From the server's derived local time when present, so the display cannot
        // disagree with what the API grouped on.
        cell: (row) => (
          <span className="whitespace-nowrap font-medium">
            {row.localTime ??
              new Date(row.startAt).toLocaleTimeString(undefined, {
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
            className="font-medium text-infini-700 underline-offset-4 hover:underline"
          >
            {row.patientName ?? 'Unknown patient'}
          </a>
        ),
      },
      {
        key: 'doctor',
        header: 'Doctor',
        cell: (row) => (
          <span className="text-sm text-body-muted">{row.doctorName ?? '—'}</span>
        ),
        secondary: true,
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => (
          <Badge tone={statusTone(row.status)}>{row.status.replace('_', ' ')}</Badge>
        ),
      },
    )

    if (canBook) {
      base.push({
        key: 'actions',
        header: <span className="sr-only">Actions</span>,
        cell: (row) => (
          <div className="flex flex-wrap gap-2">
            {!isClosed(row.status) ? (
              <Button size="sm" variant="outline" onClick={() => setRescheduling(row)}>
                Reschedule
              </Button>
            ) : null}
            {!isClosed(row.status) ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCancelling({ appointment: row, reason: '' })}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ),
      })
    }

    return base
  })()

  const freeSlots = availability.data?.closed
    ? []
    : (availability.data?.doctors ?? []).flatMap((doctor) =>
        doctor.freeSlots.map((slot) => ({ ...slot, doctorUserId: doctor.doctorUserId })),
      )

  return (
    <AppShell
      title="Appointments"
      breadcrumbs={[{ label: 'Clinical' }, { label: 'Appointments' }]}
      wide
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
        {ownScheduleOnly ? (
          <Alert tone="info" title="Your schedule only">
            You are seeing your own appointments. Booking for other doctors needs
            appointment:write:any.
          </Alert>
        ) : null}

        <Card>
          <CardHeader
            title={view === 'week' ? `Week of ${weekStartFor(date)}` : date}
            description={`Times shown in the hospital's timezone (${timezone}).`}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setParam({ date: addDaysToKey(date, -1) })}
                  aria-label="Previous day"
                >
                  <ChevronLeft aria-hidden="true" className="size-4" />
                </Button>

                <label htmlFor="schedule-date" className="sr-only">
                  Date
                </label>
                <input
                  id="schedule-date"
                  type="date"
                  value={date}
                  onChange={(event) => setParam({ date: event.target.value })}
                  className="rounded-md border border-line px-3 py-1.5 text-sm"
                />

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setParam({ date: addDaysToKey(date, 1) })}
                  aria-label="Next day"
                >
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Button>

                <Button
                  size="sm"
                  variant={view === 'day' ? 'primary' : 'secondary'}
                  onClick={() => setParam({ view: view === 'day' ? 'week' : 'day' })}
                >
                  {view === 'day' ? 'Day' : 'Week'}
                </Button>

                {canBook ? (
                  <Button size="sm" onClick={() => setBooking({})}>
                    Book appointment
                  </Button>
                ) : null}
              </div>
            }
          />

          {source.isPending ? (
            <TableSkeleton
              rows={5}
              columns={columns.length}
              caption="Appointments booked for this day"
            />
          ) : source.isError ? (
            <CardBody>
              <ErrorState
                title="Could not load the schedule"
                message={
                  source.error instanceof ApiClientError
                    ? source.error.message
                    : 'The schedule could not be retrieved.'
                }
                onRetry={() => void source.refetch()}
                retrying={source.isFetching}
              />
            </CardBody>
          ) : appointments.length === 0 ? (
            <CardBody>
              <EmptyState
                icon={<CalendarDays aria-hidden="true" className="size-10" />}
                title="Nothing booked"
                description={
                  canBook
                    ? 'Pick a free slot below to book an appointment.'
                    : 'There are no appointments on this day.'
                }
              />
            </CardBody>
          ) : (
            <DataTable
              caption="Appointments booked for this day, with status and actions"
              columns={columns}
              items={appointments}
              rowKey={(row) => row.id}
            />
          )}
        </Card>

        {canBook && view === 'day' ? (
          <Card>
            <CardHeader
              title="Free slots"
              description="Offered by the server as instants. Booking sends one back unchanged."
            />
            <CardBody>
              {!availability ? null : availability.data?.closed ? (
                <EmptyState
                  icon={<Lock aria-hidden="true" className="size-8" />}
                  title="The hospital is closed on this day"
                  description="Change the opening hours in hospital settings to open this day."
                />
              ) : availability.isPending ? (
                <TableSkeleton rows={2} columns={4} caption="Free appointment slots" />
              ) : availability.isError ? (
                <ErrorState
                  title="Could not load availability"
                  message={
                    availability.error instanceof ApiClientError
                      ? availability.error.message
                      : 'Availability could not be retrieved.'
                  }
                  onRetry={() => void availability.refetch()}
                  retrying={availability.isFetching}
                />
              ) : freeSlots.length === 0 ? (
                <EmptyState
                  title="No free slots"
                  description="Every slot on this day is taken, or past."
                />
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {freeSlots.slice(0, 60).map((slot) => (
                    <li key={`${slot.doctorUserId}-${slot.startAt}`}>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setBooking({ doctorUserId: slot.doctorUserId, startAt: slot.startAt })
                        }
                      >
                        {slot.localTime}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        ) : null}
      </div>

      {booking !== null ? (
      <BookAppointmentDialog
        date={date}
        availability={availability.data ?? null}
        initialDoctorUserId={booking?.doctorUserId}
        initialStartAt={booking?.startAt}
        onClose={() => setBooking(null)}
        onBooked={(message) => {
          setNotice(message)
          setBooking(null)
          invalidate()
        }}
        onFailed={(message) => {
          setActionError(message)
          setBooking(null)
        }}
      />
      ) : null}

      {rescheduling !== null ? (
      <RescheduleDialog
        appointment={rescheduling}
        date={date}
        onClose={() => setRescheduling(null)}
        onRescheduled={(message) => {
          setNotice(message)
          setRescheduling(null)
          invalidate()
        }}
        onFailed={(message) => {
          setActionError(message)
          setRescheduling(null)
        }}
      />
      ) : null}

      {/*
        A Modal rather than ConfirmDialog: cancelling needs a written reason, and the dialog
        component deliberately accepts only a description. The reason goes into the audit
        trail and the appointment's own history, and it is the only record of why somebody
        lost their slot.
      */}
      <Modal
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancel this appointment"
        description={
          cancelling
            ? `${cancelling.appointment.patientName ?? 'This patient'} loses their slot, and it becomes bookable by someone else. The appointment stays on the record with its history intact.`
            : undefined
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelling(null)}>
              Keep appointment
            </Button>
            <Button
              variant="danger"
              busy={cancel.isPending}
              disabled={(cancelling?.reason.trim().length ?? 0) < 10}
              onClick={() => {
                setActionError(null)
                cancel.mutate()
              }}
            >
              Cancel appointment
            </Button>
          </>
        }
      >
        <FormField
          label="Reason for cancelling"
          required
          hint="Recorded in the audit trail and the appointment history. At least 10 characters."
        >
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              rows={3}
              maxLength={500}
              aria-describedby={describedBy}
              invalid={invalid}
              value={cancelling?.reason ?? ''}
              onChange={(event) =>
                setCancelling((current) =>
                  current ? { ...current, reason: event.target.value } : current,
                )
              }
            />
          )}
        </FormField>
      </Modal>
    </AppShell>
  )
}

function isClosed(status: string): boolean {
  return status === 'CANCELLED' || status === 'COMPLETED' || status === 'NO_SHOW'
}

/** Monday of the week containing `dateKey`. */
function weekStartFor(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`)
  const weekday = date.getUTCDay()
  const offset = weekday === 0 ? -6 : 1 - weekday
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}
