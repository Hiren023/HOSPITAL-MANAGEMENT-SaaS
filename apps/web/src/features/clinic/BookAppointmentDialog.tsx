import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { Modal } from '../../components/ui/Modal.js'
import { Select } from '../../components/ui/Select.js'
import { Textarea } from '../../components/ui/Textarea.js'
import { ApiClientError } from '../../lib/api-client.js'

import { bookAppointment, fetchPatients, type Availability } from './api.js'

/**
 * Book an appointment.
 *
 * The slot is chosen from the server's list of free instants and sent back verbatim. This
 * dialog performs NO local-time conversion — that is the whole point. A browser turning
 * "09:00" into an instant is where timezone bugs live, and near a DST transition some
 * local times do not exist at all. The server already knows which instants are real, so it
 * proposes them and the client picks one.
 */
export function BookAppointmentDialog({
  date,
  availability,
  initialDoctorUserId,
  initialStartAt,
  onClose,
  onBooked,
  onFailed,
}: {
  date: string
  availability: Availability | null
  initialDoctorUserId?: string
  initialStartAt?: string
  onClose: () => void
  onBooked: (message: string) => void
  onFailed: (message: string) => void
}) {
  const [patientId, setPatientId] = useState('')
  const [doctorUserId, setDoctorUserId] = useState(initialDoctorUserId ?? '')
  const [startAt, setStartAt] = useState(initialStartAt ?? '')
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [patientQuery, setPatientQuery] = useState('')

  // No re-seeding effect. The parent mounts this dialog only while it is open, so every
  // opening starts from these initial values. An effect would have to guard against
  // re-running, and every such guard is a chance to clobber a slot just chosen.

  const patients = useQuery({
    queryKey: ['hospital', 'patients', 'picker', patientQuery],
    queryFn: ({ signal }) =>
      fetchPatients({ pageSize: 20, q: patientQuery || undefined }, signal),
    enabled: true,
  })

  const slotsForDoctor = (() => {
    const doctors = availability?.doctors ?? []
    const chosen =
      doctors.find((doctor) => doctor.doctorUserId === doctorUserId) ?? doctors[0]
    return chosen?.freeSlots ?? []
  })()

  // Derived, not stored: a slot preselected from the free list wins, otherwise fall back
  // to the first free one — which is what a receptionist almost always wants. Deriving
  // avoids an effect that would fire on every render and fight the person's own choice.
  const effectiveStartAt = startAt || slotsForDoctor[0]?.startAt || ''

  const book = useMutation({
    mutationFn: () =>
      bookAppointment({
        patientId,
        doctorUserId,
        startAt: effectiveStartAt,
        reason: reason || undefined,
        confirm,
      }),
    onSuccess: (created) => {
      onBooked(
        `Appointment booked for ${created.patientName ?? 'the patient'} at ${new Date(
          created.startAt,
        ).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`,
      )
    },
    onError: (cause) => {
      const message =
        cause instanceof ApiClientError
          ? cause.message
          : 'The appointment could not be booked.'
      setError(message)
      onFailed(message)
    },
  })

  const patientOptions = (patients.data?.items ?? []).map((patient) => ({
    value: patient.id,
    label: `${patient.patientNumber} — ${patient.firstName} ${patient.lastName}`,
  }))

  return (
    <Modal
      open
      onClose={onClose}
      title="Book an appointment"
      description={`${date} · times are the hospital's own.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={book.isPending}
            disabled={patientId === '' || doctorUserId === '' || effectiveStartAt === ''}
            onClick={() => {
              setError(null)
              book.mutate()
            }}
          >
            Book appointment
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          book.mutate()
        }}
      >
        {error ? (
          <Alert tone="danger" title="Could not book">
            {error}
          </Alert>
        ) : null}

        <FormField label="Patient" required hint="Search by name, or by patient number.">
          {({ id, describedBy }) => (
            <>
              <Input
                id={id}
                aria-describedby={describedBy}
                value={patientQuery}
                placeholder="Filter patients…"
                onChange={(event) => setPatientQuery(event.target.value)}
                className="mb-2"
              />
              <Select
                aria-label="Choose a patient"
                placeholder={patients.isPending ? 'Loading patients…' : 'Select a patient'}
                options={patientOptions}
                value={patientId}
                onChange={(event) => setPatientId(event.target.value)}
              />
            </>
          )}
        </FormField>

        <FormField label="Doctor" required>
          {({ id }) => (
            <Select
              id={id}
              placeholder={availability === null ? 'Loading doctors…' : 'Select a doctor'}
              options={(availability?.doctors ?? []).map((doctor) => ({
                value: doctor.doctorUserId,
                label: `${doctor.freeSlots.length} free slot${
                  doctor.freeSlots.length === 1 ? '' : 's'
                }`,
              }))}
              value={doctorUserId}
              onChange={(event) => {
                setDoctorUserId(event.target.value)
                // Changing the doctor invalidates the chosen slot: it belongs to the old one.
                setStartAt('')
              }}
            />
          )}
        </FormField>

        <FormField
          label="Time"
          required
          hint="Only slots the server reports as free. Booked slots are absent by design."
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              placeholder={
                slotsForDoctor.length === 0 ? 'No free slots for this doctor' : 'Select a time'
              }
              options={slotsForDoctor.map((slot) => ({
                value: slot.startAt,
                label: slot.localTime,
              }))}
              value={effectiveStartAt}
              onChange={(event) => setStartAt(event.target.value)}
            />
          )}
        </FormField>

        <FormField label="Reason for the visit" hint="In the patient's own words. Optional.">
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              rows={2}
              maxLength={300}
              aria-describedby={describedBy}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </FormField>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirm}
            onChange={(event) => setConfirm(event.target.checked)}
            className="size-4 rounded border-line"
          />
          Confirm with the patient now
        </label>
      </form>
    </Modal>
  )
}