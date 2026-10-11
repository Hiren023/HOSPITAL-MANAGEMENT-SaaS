import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { ArrowLeft, CalendarDays, Stethoscope } from 'lucide-react'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { Textarea } from '../../components/ui/Textarea.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { LoadingState } from '../../components/states/LoadingState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'

import {
  WEEKDAYS,
  fetchDepartments,
  fetchDoctor,
  fetchSchedule,
  formatInr,
  formatMinute,
  parseInr,
  parseMinute,
  replaceSchedule,
  updateDoctorProfile,
  type Department,
  type DoctorProfile,
  type ScheduleBlock,
} from './api.js'

/** One editable row per weekday. `enabled` is that day's working switch. */
interface DayDraft {
  weekday: number
  enabled: boolean
  start: string
  end: string
  slotDurationMinutes: number
}

const SLOT_OPTIONS = [10, 15, 20, 30, 45, 60].map((value) => ({
  value: String(value),
  label: `${value} minutes`,
}))

function toDrafts(blocks: ScheduleBlock[]): DayDraft[] {
  const byDay = new Map(blocks.map((block) => [block.weekday, block]))

  return WEEKDAYS.map((_, weekday) => {
    const block = byDay.get(weekday)
    return {
      weekday,
      enabled: Boolean(block?.isActive),
      start: formatMinute(block?.startMinute ?? 9 * 60),
      end: formatMinute(block?.endMinute ?? 17 * 60),
      slotDurationMinutes: block?.slotDurationMinutes ?? 15,
    }
  })
}

/**
 * Professional details form.
 *
 * Mounted with a `profile-`-prefixed key by the page, so it takes its initial state straight from
 * the loaded doctor instead of copying it into state via an effect. That is both the
 * idiomatic React shape and the one that cannot desynchronise: remounting on a new
 * doctor resets every field, where an effect has to be guarded against re-seeding and
 * would otherwise discard edits in progress.
 */
function ProfileEditor({
  doctor,
  departments,
  canEdit,
  showDepartments,
  onSaved,
}: {
  doctor: DoctorProfile
  departments: Department[]
  canEdit: boolean
  showDepartments: boolean
  onSaved: (message: string) => void
}) {
  const [specialities, setSpecialities] = useState(doctor.specialities.join(', '))
  const [departmentId, setDepartmentId] = useState(doctor.departmentId ?? '')
  const [years, setYears] = useState(String(doctor.yearsOfExperience))
  const [fee, setFee] = useState(
    doctor.consultationFeeInPaise > 0 ? String(doctor.consultationFeeInPaise / 100) : '',
  )
  const [bio, setBio] = useState(doctor.bio ?? '')
  const [accepting, setAccepting] = useState(doctor.isAcceptingNewPatients)
  const [error, setError] = useState<string | null>(null)

  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: () => {
      const parsedYears = Number(years)
      if (!Number.isInteger(parsedYears) || parsedYears < 0 || parsedYears > 70) {
        throw new ApiClientError(
          'VALIDATION_ERROR',
          'Years of experience must be a whole number between 0 and 70.',
          422,
        )
      }

      const feePaise = fee.trim() === '' ? 0 : parseInr(fee)
      if (feePaise === null) {
        throw new ApiClientError(
          'VALIDATION_ERROR',
          'Enter the consultation fee as a number, or leave it empty.',
          422,
        )
      }

      return updateDoctorProfile(doctor.id, {
        departmentId: departmentId || undefined,
        specialities: specialities
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 10),
        yearsOfExperience: parsedYears,
        consultationFeeInPaise: feePaise,
        bio: bio.trim() || undefined,
        isAcceptingNewPatients: accepting,
      })
    },
    onSuccess: () => {
      setError(null)
      onSaved('The doctor profile was updated.')
      void queryClient.invalidateQueries({ queryKey: ['hospital'] })
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiClientError ? cause.message : 'The profile could not be saved.',
      )
    },
  })

  return (
    <Card>
      <CardHeader
        title="Professional details"
        description="Visible to staff who can read this profile."
      />
      <CardBody>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          {error ? (
            <Alert tone="danger" title="Could not save" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          ) : null}

          <fieldset className="space-y-4" disabled={!canEdit}>
            <FormField
              label="Specialities"
              hint="Comma separated, for example Cardiology, Internal Medicine."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={specialities}
                  onChange={(event) => setSpecialities(event.target.value)}
                />
              )}
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Years of experience">
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    max={70}
                    value={years}
                    onChange={(event) => setYears(event.target.value)}
                  />
                )}
              </FormField>

              <FormField label="Consultation fee" hint="In rupees.">
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
            </div>

            {showDepartments ? (
              <FormField label="Department">
                {({ id }) => (
                  <Select
                    id={id}
                    placeholder="Unassigned"
                    options={departments.map((d) => ({ value: d.id, label: d.name }))}
                    value={departmentId}
                    onChange={(event) => setDepartmentId(event.target.value)}
                  />
                )}
              </FormField>
            ) : null}

            <FormField label="Biography">
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={4}
                  maxLength={2000}
                  value={bio}
                  onChange={(event) => setBio(event.target.value)}
                />
              )}
            </FormField>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={accepting}
                onChange={(event) => setAccepting(event.target.checked)}
                className="size-4 rounded border-line"
              />
              Accepting new patients
            </label>

            {canEdit ? (
              <Button type="submit" busy={save.isPending}>
                Save profile
              </Button>
            ) : null}
          </fieldset>
        </form>
      </CardBody>
    </Card>
  )
}

/**
 * Weekly schedule editor.
 *
 * Saving REPLACES the whole week rather than merging. A form that submits a week should
 * produce exactly that week; merging would leave behind blocks the person believed they
 * had deleted, which for a rota means booking slots that should have been closed.
 *
 * Times are minutes from midnight end to end. That makes ordering, overlap and
 * midnight-crossing checks exact, and sidesteps timezones entirely — a hospital's
 * working day is local, and converting it twice is how a 09:00 slot becomes 04:30.
 */
function ScheduleEditor({
  profileId,
  blocks,
  canEdit,
  onSaved,
}: {
  profileId: string
  blocks: ScheduleBlock[]
  canEdit: boolean
  onSaved: (message: string) => void
}) {
  const [days, setDays] = useState<DayDraft[]>(() => toDrafts(blocks))
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const workingDays = days.filter((day) => day.enabled).length

  const patch = (weekday: number, changes: Partial<DayDraft>) =>
    setDays((current) =>
      current.map((day) => (day.weekday === weekday ? { ...day, ...changes } : day)),
    )

  const save = useMutation({
    mutationFn: () => {
      const payload: Omit<ScheduleBlock, 'isActive'>[] = []

      // Validate here so the person is told WHICH day is wrong. Sending the week and
      // having the server reject it wholesale turns a two-second fix into a guessing
      // game about which row was at fault.
      for (const day of days) {
        if (!day.enabled) continue

        const start = parseMinute(day.start)
        const end = parseMinute(day.end)
        if (start === null || end === null) {
          throw new ApiClientError(
            'VALIDATION_ERROR',
            `${WEEKDAYS[day.weekday]}: enter times as HH:MM.`,
            422,
          )
        }
        if (end <= start) {
          throw new ApiClientError(
            'VALIDATION_ERROR',
            `${WEEKDAYS[day.weekday]}: the finish time must be after the start time.`,
            422,
          )
        }

        payload.push({
          weekday: day.weekday,
          startMinute: start,
          endMinute: end,
          slotDurationMinutes: day.slotDurationMinutes,
        })
      }

      return replaceSchedule(profileId, payload)
    },
    onSuccess: () => {
      setError(null)
      onSaved('The weekly schedule was saved.')
      void queryClient.invalidateQueries({ queryKey: ['hospital'] })
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiClientError ? cause.message : 'The schedule could not be saved.',
      )
    },
  })

  return (
    <Card>
      <CardHeader
        title="Weekly schedule"
        description={
          workingDays === 0
            ? 'This doctor is not working any day yet.'
            : `Working ${workingDays} ${workingDays === 1 ? 'day' : 'days'} a week. Saving replaces the whole week.`
        }
      />
      <CardBody>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          {error ? (
            <Alert tone="danger" title="Could not save the schedule" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          ) : null}

          <fieldset className="space-y-2" disabled={!canEdit}>
            <legend className="sr-only">Weekly working hours</legend>

            {days.map((day) => (
              <div
                key={day.weekday}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2"
              >
                <label className="flex min-w-36 items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={day.enabled}
                    onChange={(event) => patch(day.weekday, { enabled: event.target.checked })}
                    className="size-4 rounded border-line"
                  />
                  {WEEKDAYS[day.weekday]}
                </label>

                <label className="flex items-center gap-2 text-sm">
                  <span className="text-ink-subtle">From</span>
                  <Input
                    type="time"
                    value={day.start}
                    disabled={!day.enabled}
                    aria-label={`${WEEKDAYS[day.weekday]} start time`}
                    className="w-28"
                    onChange={(event) => patch(day.weekday, { start: event.target.value })}
                  />
                </label>

                <label className="flex items-center gap-2 text-sm">
                  <span className="text-ink-subtle">to</span>
                  <Input
                    type="time"
                    value={day.end}
                    disabled={!day.enabled}
                    aria-label={`${WEEKDAYS[day.weekday]} finish time`}
                    className="w-28"
                    onChange={(event) => patch(day.weekday, { end: event.target.value })}
                  />
                </label>

                <label className="flex items-center gap-2 text-sm">
                  <span className="text-ink-subtle">Slot</span>
                  <Select
                    aria-label={`${WEEKDAYS[day.weekday]} slot length`}
                    options={SLOT_OPTIONS}
                    value={String(day.slotDurationMinutes)}
                    disabled={!day.enabled}
                    className="w-36"
                    onChange={(event) =>
                      patch(day.weekday, { slotDurationMinutes: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            ))}
          </fieldset>

          {canEdit ? (
            <Button type="submit" busy={save.isPending}>
              Save schedule
            </Button>
          ) : (
            <p className="text-sm text-ink-subtle">
              You can view this schedule but not change it.
            </p>
          )}
        </form>
      </CardBody>
    </Card>
  )
}

/**
 * A doctor's profile and weekly schedule.
 *
 * `requireDoctorMembership` on the server means a profile is only ever reachable from the
 * hospital that owns it; this page simply renders whatever the API returned and never
 * assumes an id it was handed is valid.
 */
export function DoctorProfilePage() {
  const { profileId = '' } = useParams()
  const { user } = useAuth()

  const canEdit = user !== null && hasPermission(user, 'doctor:write')
  const canEditSchedule = user !== null && hasPermission(user, 'schedule:write')
  const canReadDepartments = user !== null && hasPermission(user, 'department:read')

  const [notice, setNotice] = useState<string | null>(null)

  const profile = useQuery({
    queryKey: ['hospital', 'doctor', profileId],
    queryFn: ({ signal }) => fetchDoctor(profileId, signal),
    enabled: profileId !== '',
  })

  const schedule = useQuery({
    queryKey: ['hospital', 'schedule', profileId],
    queryFn: ({ signal }) => fetchSchedule(profileId, signal),
    enabled: profileId !== '',
  })

  // Only requested when the caller may read departments, so a doctor-viewer without that
  // permission gets the profile without the column rather than a failed request.
  const departments = useQuery({
    queryKey: ['hospital', 'departments', 'picker'],
    queryFn: ({ signal }) => fetchDepartments({ pageSize: 100 }, signal),
    enabled: canReadDepartments,
  })

  const onSaved = (message: string) => setNotice(message)
  const doctor = profile.data

  const departmentOptions = useMemo(
    () => departments.data?.items ?? [],
    [departments.data],
  )

  if (profile.isPending) {
    return (
      <AppShell title="Doctor" breadcrumbs={[{ label: 'Doctors' }, { label: 'Loading' }]}>
        <LoadingState label="Loading the doctor profile…" />
      </AppShell>
    )
  }

  if (profile.isError) {
    const notFound = profile.error instanceof ApiClientError && profile.error.status === 404

    return (
      <AppShell title="Doctor" breadcrumbs={[{ label: 'Doctors' }, { label: 'Not found' }]}>
        <Card>
          <CardBody>
            {notFound ? (
              <EmptyState
                icon={<Stethoscope aria-hidden="true" className="size-10" />}
                title="No such doctor"
                description="This profile does not exist in your hospital. It may have been removed."
                action={
                  <a
                    href="/doctors"
                    className="text-sm font-medium text-brand-700 underline underline-offset-4"
                  >
                    Back to doctors
                  </a>
                }
              />
            ) : (
              <ErrorState
                title="Could not load this doctor"
                message={
                  profile.error instanceof ApiClientError
                    ? profile.error.message
                    : 'The doctor profile could not be retrieved.'
                }
                onRetry={() => void profile.refetch()}
                retrying={profile.isFetching}
              />
            )}
          </CardBody>
        </Card>
      </AppShell>
    )
  }

  if (!doctor) return null

  return (
    <AppShell
      title={doctor.fullName ?? 'Doctor'}
      breadcrumbs={[
        { label: 'Doctors', to: '/doctors' },
        { label: doctor.fullName ?? 'Profile' },
      ]}
      wide
      actions={
        <a
          href="/doctors"
          className="inline-flex items-center gap-2 text-sm font-medium text-brand-700 underline-offset-4 hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All doctors
        </a>
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
            title={doctor.fullName ?? 'Unnamed account'}
            description={doctor.email ?? undefined}
            actions={
              <Badge tone={doctor.isAcceptingNewPatients ? 'success' : 'neutral'}>
                {doctor.isAcceptingNewPatients ? 'Accepting patients' : 'Not booking'}
              </Badge>
            }
          />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Registration
                </dt>
                <dd className="mt-1 font-mono text-sm">
                  {doctor.registrationNumber ?? '—'}
                  {doctor.registrationNumberMasked ? (
                    <span className="ml-2 text-xs text-ink-subtle">
                      hidden — you do not manage doctors
                    </span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Specialities
                </dt>
                <dd className="mt-1 text-sm">{doctor.specialities.join(', ') || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Experience
                </dt>
                <dd className="mt-1 text-sm">{doctor.yearsOfExperience} years</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Consultation fee
                </dt>
                <dd className="mt-1 text-sm">
                  {doctor.consultationFeeInPaise > 0 ? formatInr(doctor.consultationFeeInPaise) : '—'}
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        {/*
          Both keys are prefixed, and that is load-bearing rather than cosmetic. These two
          components are siblings under the same parent, and `doctor.id` IS `profileId` —
          the very same string. Keying both on the bare id made React report "two children
          with the same key" on every render, which is the warning that precedes children
          being duplicated or dropped.

          The remount itself is deliberate: each editor takes its initial state from props,
          so after a save the fresh record must REPLACE the component rather than merge
          with the stale state it is already holding.
        */}
        {canEdit ? (
          <ProfileEditor
            key={`profile-${doctor.id}`}
            doctor={doctor}
            departments={departmentOptions}
            canEdit={canEdit}
            showDepartments={canReadDepartments}
            onSaved={onSaved}
          />
        ) : null}

        {schedule.isPending ? (
          <Card>
            <CardBody>
              <LoadingState label="Loading the weekly schedule…" />
            </CardBody>
          </Card>
        ) : schedule.isError ? (
          <Card>
            <CardHeader title="Weekly schedule" />
            <CardBody>
              <ErrorState
                title="Could not load the schedule"
                message={
                  schedule.error instanceof ApiClientError
                    ? schedule.error.message
                    : 'The weekly schedule could not be retrieved.'
                }
                onRetry={() => void schedule.refetch()}
                retrying={schedule.isFetching}
              />
            </CardBody>
          </Card>
        ) : (
          <ScheduleEditor
            key={`schedule-${profileId}`}
            profileId={profileId}
            blocks={schedule.data?.blocks ?? []}
            canEdit={canEditSchedule}
            onSaved={onSaved}
          />
        )}

        {schedule.data && schedule.data.blocks.length > 0 ? (
          <p className="flex items-center gap-2 text-sm text-ink-subtle">
            <CalendarDays aria-hidden="true" className="size-4" />
            {schedule.data.blocks.filter((block) => block.isActive).length} working blocks stored for
            this doctor.
          </p>
        ) : null}
      </div>
    </AppShell>
  )
}