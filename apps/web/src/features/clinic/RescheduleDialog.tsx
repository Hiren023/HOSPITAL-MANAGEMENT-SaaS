import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { FormField } from '../../components/ui/FormField.js'
import { Select } from '../../components/ui/Select.js'
import { Textarea } from '../../components/ui/Textarea.js'
import { Modal } from '../../components/ui/Modal.js'
import { ApiClientError } from '../../lib/api-client.js'

import {
  fetchAvailability,
  rescheduleAppointment,
  type Appointment,
} from './api.js'

/**
 * Move an appointment.
 *
 * As with booking, the replacement time is chosen from the server's free instants and sent
 * back unchanged — no client-side timezone conversion.
 *
 * A reason is mandatory. An appointment that moves without anyone recording why leaves a
 * patient asking why, with nobody able to answer.
 */
export function RescheduleDialog({
  appointment,
  date,
  onClose,
  onRescheduled,
  onFailed,
}: {
  appointment: Appointment | null
  date: string
  onClose: () => void
  onRescheduled: (message: string) => void
  onFailed: (message: string) => void
}) {
  const [startAt, setStartAt] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  // No re-seeding effect: the parent mounts this dialog only while one appointment is
  // being rescheduled, so it always starts clean.

  const availability = useQuery({
    queryKey: ['hospital', 'availability', date, appointment?.doctorUserId],
    queryFn: ({ signal }) =>
      fetchAvailability(
        appointment ? { date, doctorUserId: appointment.doctorUserId } : { date },
        signal,
      ),
    enabled: appointment !== null,
  })

  /**
   * The slot the appointment currently holds is absent from the free list — it is taken.
   * Including it as an option means "keep the same time" is expressible, and the server
   * treats an unchanged reschedule as a no-op rather than a self-conflict.
   */
  const slots: { value: string; label: string }[] = (() => {
    const free = availability.data?.doctors?.[0]?.freeSlots ?? []
    const mapped = free.map((slot) => ({ value: slot.startAt, label: slot.localTime }))

    if (!appointment) return mapped

    return [{ value: appointment.startAt, label: 'Keep the current time' }, ...mapped]
  })()

  const reschedule = useMutation({
    mutationFn: () =>
      rescheduleAppointment(appointment?.id ?? '', { startAt, reason }),
    onSuccess: (updated) => {
      onRescheduled(
        `Appointment moved to ${new Date(updated.startAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })}.`,
      )
    },
    onError: (cause) => {
      const message =
        cause instanceof ApiClientError ? cause.message : 'The appointment could not be moved.'
      setError(message)
      onFailed(message)
    },
  })

  return (
    <Modal
      open={appointment !== null}
      onClose={onClose}
      title="Reschedule this appointment"
      description={appointment ? `Currently booked with ${appointment.doctorName ?? 'a doctor'}.` : undefined}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={reschedule.isPending}
            disabled={startAt === '' || reason.trim().length < 5}
            onClick={() => {
              setError(null)
              reschedule.mutate()
            }}
          >
            Move appointment
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          reschedule.mutate()
        }}
      >
        {error ? (
          <Alert tone="danger" title="Could not move the appointment">
            {error}
          </Alert>
        ) : null}

        <FormField label="New time" required>
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              placeholder={
                availability.isPending ? 'Loading free slots…' : 'Select a time'
              }
              options={slots}
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
            />
          )}
        </FormField>

        <FormField
          label="Reason for the change"
          required
          hint="Recorded on the appointment. At least 5 characters."
        >
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              rows={2}
              maxLength={300}
              aria-describedby={describedBy}
              invalid={invalid}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </FormField>
      </form>
    </Modal>
  )
}