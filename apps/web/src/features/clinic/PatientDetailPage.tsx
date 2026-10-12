import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { AppShell } from '../../components/layout/AppShell.js'
import { Badge } from '../../components/ui/Badge.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { LoadingState } from '../../components/states/LoadingState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'
import { PatientClinicalSummary } from '../clinical/PatientClinicalSummary.js'

import {
  ageFrom,
  fetchAppointments,
  fetchPatient,
  statusTone,
  type Appointment,
} from './api.js'

/**
 * One patient, and their appointment history.
 *
 * That is deliberately the WHOLE of "history" in this phase. There is no clinical record
 * here — no notes, no diagnoses, no vitals — because the patient schema has no field that
 * could hold one and the API refuses unknown keys. A history screen that implied more
 * existed would be promising something the product cannot deliver.
 *
 * Cancelling is not offered on this screen. It is a consequential action on an upcoming
 * appointment, and it is confirmed from the schedule where the person can see what they
 * are cancelling and who else is waiting.
 */
export function PatientDetailPage() {
  const { patientId = '' } = useParams()
  const { user } = useAuth()

  const canReadAppointments =
    user !== null && hasPermission(user, 'appointment:read')
  const canReadClinical = user !== null && hasPermission(user, 'consultation:read')


  const patient = useQuery({
    queryKey: ['hospital', 'patient', patientId],
    queryFn: ({ signal }) => fetchPatient(patientId, signal),
    enabled: patientId !== '',
  })

  const appointments = useQuery({
    queryKey: ['hospital', 'patient', patientId, 'appointments'],
    queryFn: ({ signal }) => fetchAppointments({ patientId, pageSize: 25 }, signal),
    enabled: patientId !== '' && canReadAppointments,
  })

  if (patient.isPending) {
    return (
      <AppShell title="Patient" breadcrumbs={[{ label: 'Patients' }, { label: 'Loading' }]}>
        <LoadingState label="Loading the patient record…" />
      </AppShell>
    )
  }

  if (patient.isError) {
    const notFound = patient.error instanceof ApiClientError && patient.error.status === 404

    return (
      <AppShell title="Patient" breadcrumbs={[{ label: 'Patients' }, { label: 'Not found' }]}>
        <Card>
          <CardBody>
            {notFound ? (
              <EmptyState
                title="No such patient"
                description="This record does not exist in your hospital."
                action={
                  <a
                    href="/patients"
                    className="text-sm font-medium text-brand-700 underline underline-offset-4"
                  >
                    Back to patients
                  </a>
                }
              />
            ) : (
              <ErrorState
                title="Could not load this patient"
                message={
                  patient.error instanceof ApiClientError
                    ? patient.error.message
                    : 'The patient record could not be retrieved.'
                }
                onRetry={() => void patient.refetch()}
                retrying={patient.isFetching}
              />
            )}
          </CardBody>
        </Card>
      </AppShell>
    )
  }

  const data = patient.data
  if (!data) return null

  const age = ageFrom(data.dateOfBirth)

  const columns: Column<Appointment>[] = [
    {
      key: 'when',
      header: 'When',
      cell: (row) => (
        <span className="whitespace-nowrap text-sm">
          {new Date(row.startAt).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </span>
      ),
    },
    {
      key: 'doctor',
      header: 'Doctor',
      cell: (row) => (
        <span className="text-sm text-ink-muted">{row.doctorName ?? '—'}</span>
      ),
      secondary: true,
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
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge tone={statusTone(row.status)}>{row.status.replace('_', ' ')}</Badge>,
    },
  ]

  return (
    <AppShell
      title={`${data.firstName} ${data.lastName}`}
      breadcrumbs={[
        { label: 'Patients', to: '/patients' },
        { label: data.patientNumber },
      ]}
      wide
      actions={
        <a
          href="/patients"
          className="inline-flex items-center gap-2 text-sm font-medium text-brand-700 underline-offset-4 hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All patients
        </a>
      }
    >
      <div className="space-y-5">
        <Card>
          <CardHeader
            title={`${data.firstName} ${data.lastName}`}
            description={data.patientNumber}
            actions={
              <Badge tone={data.isActive ? 'success' : 'neutral'}>
                {data.isActive ? 'Active' : 'Inactive'}
              </Badge>
            }
          />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Date of birth
                </dt>
                <dd className="mt-1 text-sm">
                  {data.dateOfBirth}
                  {age !== null ? <span className="text-ink-subtle"> ({age} years)</span> : null}
                </dd>
              </div>

              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Gender
                </dt>
                <dd className="mt-1 text-sm">
                  {data.gender === 'UNDECLARED' ? '—' : data.gender}
                </dd>
              </div>

              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Phone
                </dt>
                <dd className="mt-1 text-sm">
                  {data.contactVisible ? (data.phone ?? '—') : <Restricted />}
                </dd>
              </div>

              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Email
                </dt>
                <dd className="mt-1 break-all text-sm">
                  {data.contactVisible ? (data.email ?? '—') : <Restricted />}
                </dd>
              </div>

              <div className="sm:col-span-2">
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Address
                </dt>
                <dd className="mt-1 text-sm">
                  {data.contactVisible && data.address
                    ? [data.address.line1, data.address.city, data.address.state]
                        .filter(Boolean)
                        .join(', ') || '—'
                    : data.contactVisible
                      ? '—'
                      : <Restricted />}
                </dd>
              </div>

              <div className="sm:col-span-2">
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Emergency contact
                </dt>
                <dd className="mt-1 text-sm">
                  {data.contactVisible && data.emergencyContact?.name
                    ? `${data.emergencyContact.name}${
                        data.emergencyContact.relationship
                          ? ` (${data.emergencyContact.relationship})`
                          : ''
                      } — ${data.emergencyContact.phone ?? ''}`
                    : data.contactVisible
                      ? '—'
                      : <Restricted />}
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Appointment history"
            description={
              canReadAppointments
                ? 'Every booking made for this patient, newest last.'
                : 'Requires appointment:read.'
            }
            actions={
              <a
                href={`/schedule?patientId=${data.id}`}
                className="text-sm font-medium text-brand-700 underline underline-offset-4"
              >
                Book an appointment
              </a>
            }
          />

          {!canReadAppointments ? (
            <CardBody>
              <EmptyState
                title="Not available to you"
                description="Your role can read this patient's details but not their appointments."
              />
            </CardBody>
          ) : appointments.isPending ? (
            <CardBody>
              <TableSkeleton
                rows={3}
                columns={4}
                caption="Appointments booked for this patient"
              />
            </CardBody>
          ) : appointments.isError ? (
            <CardBody>
              <ErrorState
                title="Could not load the appointment history"
                message={
                  appointments.error instanceof ApiClientError
                    ? appointments.error.message
                    : 'The appointment history could not be retrieved.'
                }
                onRetry={() => void appointments.refetch()}
                retrying={appointments.isFetching}
              />
            </CardBody>
          ) : (appointments.data?.items ?? []).length === 0 ? (
            <CardBody>
              <EmptyState
                title="No appointments yet"
                description="This patient has never been booked in."
              />
            </CardBody>
          ) : (
            <DataTable
              caption="Appointments booked for this patient"
              columns={columns}
              items={appointments.data?.items ?? []}
              rowKey={(row) => row.id}
            />
          )}
        </Card>
      {/*
          Clinical history is a SEPARATE card from the appointment history above, and is
          rendered only for callers the API would let read clinical records at all. A
          receptionist sees the booking history and is told plainly that the clinical
          record is not available to them, rather than being shown an empty section that
          looks like missing data.
        */}
        {canReadClinical ? (
          <PatientClinicalSummary patientId={data.id} />
        ) : (
          <Card>
            <CardBody>
              <EmptyState
                title="Clinical history is not available to you"
                description="Reading consultations requires consultation:read. You can still see this patient's demographics and appointment history."
              />
            </CardBody>
          </Card>
        )}
      </div>
    </AppShell>
  )
}

/**
 * Shown in place of contact details the caller may not see.
 *
 * Says why, rather than rendering an empty cell that reads as missing data.
 */
function Restricted() {
  return (
    <span className="text-xs text-ink-subtle">hidden — you do not have patient:write</span>
  )
}
