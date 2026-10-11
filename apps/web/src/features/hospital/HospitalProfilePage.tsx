import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, ShieldCheck } from 'lucide-react'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader, StatTile } from '../../components/ui/Card.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { Select } from '../../components/ui/Select.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { LoadingState } from '../../components/states/LoadingState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'

import {
  fetchHospitalProfile,
  updateHospitalProfile,
  updateHospitalSettings,
  type HospitalProfile,
} from './api.js'

/**
 * Profile form.
 *
 * Mounted with `key={hospital.id}` so it seeds its fields directly from the loaded
 * record. Copying props into state inside an effect instead would need its own guard
 * against re-seeding, and every such guard is a chance to clobber edits in progress.
 */
function ProfileForm({
  hospital,
  canEdit,
  onSaved,
}: {
  hospital: HospitalProfile
  canEdit: boolean
  onSaved: (message: string) => void
}) {
  const [name, setName] = useState(hospital.name)
  const [registrationNumber, setRegistrationNumber] = useState(hospital.registrationNumber ?? '')
  const [contactEmail, setContactEmail] = useState(hospital.contactEmail ?? '')
  const [contactPhone, setContactPhone] = useState(hospital.contactPhone ?? '')
  const [city, setCity] = useState(hospital.address?.city ?? '')
  const [stateName, setStateName] = useState(hospital.address?.state ?? '')
  const [error, setError] = useState<string | null>(null)

  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: () =>
      updateHospitalProfile({
        name,
        registrationNumber: registrationNumber || undefined,
        contactEmail: contactEmail || undefined,
        contactPhone: contactPhone || undefined,
        address: { city: city || undefined, state: stateName || undefined },
      }),
    onSuccess: () => {
      setError(null)
      onSaved('The hospital profile was updated.')
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
        title="Profile"
        description="How your hospital appears to staff and on generated documents."
        actions={
          <Badge tone={hospital.status === 'APPROVED' ? 'success' : 'warning'}>
            {hospital.status}
          </Badge>
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
            <Alert tone="danger" title="Could not save" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          ) : null}

          <fieldset className="space-y-4" disabled={!canEdit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Hospital name" required>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={name}
                    maxLength={160}
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </FormField>

              <FormField
                label="Registration number"
                hint="Your own regulatory registration, if you have one."
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={registrationNumber}
                    maxLength={80}
                    onChange={(event) => setRegistrationNumber(event.target.value)}
                  />
                )}
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Contact email">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="email"
                    aria-describedby={describedBy}
                    value={contactEmail}
                    onChange={(event) => setContactEmail(event.target.value)}
                  />
                )}
              </FormField>

              <FormField label="Contact phone">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="tel"
                    aria-describedby={describedBy}
                    value={contactPhone}
                    maxLength={20}
                    onChange={(event) => setContactPhone(event.target.value)}
                  />
                )}
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="City">
                {({ id }) => (
                  <Input
                    id={id}
                    value={city}
                    maxLength={80}
                    onChange={(event) => setCity(event.target.value)}
                  />
                )}
              </FormField>

              <FormField label="State">
                {({ id }) => (
                  <Input
                    id={id}
                    value={stateName}
                    maxLength={80}
                    onChange={(event) => setStateName(event.target.value)}
                  />
                )}
              </FormField>
            </div>

            {/* Read-only by design: the slug is the tenant's public identity. */}
            <FormField label="Public address" hint="Permanent. Issued when you registered.">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={`/${hospital.slug}`}
                  readOnly
                />
              )}
            </FormField>

            {canEdit ? (
              <Button type="submit" busy={save.isPending}>
                Save profile
              </Button>
            ) : (
              <p className="flex items-center gap-2 text-sm text-ink-subtle">
                <ShieldCheck aria-hidden="true" className="size-4" />
                You can view this but not change it.
              </p>
            )}
          </fieldset>
        </form>
      </CardBody>
    </Card>
  )
}

/** Operational settings, under their own permission and their own save button. */
function SettingsForm({
  hospital,
  canEdit,
  onSaved,
}: {
  hospital: HospitalProfile
  canEdit: boolean
  onSaved: (message: string) => void
}) {
  const settings = (hospital.settings ?? {}) as Record<string, unknown>

  const [appointmentMinutes, setAppointmentMinutes] = useState(
    String(settings['defaultAppointmentMinutes'] ?? 15),
  )
  const [currency, setCurrency] = useState(String(settings['currency'] ?? 'INR'))
  const [prefix, setPrefix] = useState(String(settings['registrationNumberPrefix'] ?? ''))
  const [error, setError] = useState<string | null>(null)

  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: () => {
      const minutes = Number(appointmentMinutes)
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) {
        throw new ApiClientError(
          'VALIDATION_ERROR',
          'The default appointment length must be a whole number of minutes between 5 and 120.',
          422,
        )
      }

      return updateHospitalSettings({
        defaultAppointmentMinutes: minutes,
        currency,
        registrationNumberPrefix: prefix,
      })
    },
    onSuccess: () => {
      setError(null)
      onSaved('Hospital settings were updated.')
      void queryClient.invalidateQueries({ queryKey: ['hospital'] })
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiClientError ? cause.message : 'The settings could not be saved.',
      )
    },
  })

  return (
    <Card>
      <CardHeader
        title="Operational settings"
        description="Defaults applied across appointments and generated documents."
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
            <Alert tone="danger" title="Could not save settings" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          ) : null}

          <fieldset className="space-y-4" disabled={!canEdit}>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="Default appointment length" hint="Minutes, 5 to 120.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="number"
                    min={5}
                    max={120}
                    aria-describedby={describedBy}
                    value={appointmentMinutes}
                    onChange={(event) => setAppointmentMinutes(event.target.value)}
                  />
                )}
              </FormField>

              <FormField label="Currency">
                {({ id }) => (
                  <Select
                    id={id}
                    options={[
                      { value: 'INR', label: 'INR — Indian rupee' },
                      { value: 'USD', label: 'USD — US dollar' },
                      { value: 'AED', label: 'AED — UAE dirham' },
                    ]}
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value)}
                  />
                )}
              </FormField>

              <FormField label="Registration prefix" hint="Prepended to new patient numbers.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={prefix}
                    maxLength={12}
                    onChange={(event) => setPrefix(event.target.value)}
                  />
                )}
              </FormField>
            </div>

            {canEdit ? (
              <Button type="submit" busy={save.isPending}>
                Save settings
              </Button>
            ) : (
              <p className="flex items-center gap-2 text-sm text-ink-subtle">
                <Building2 aria-hidden="true" className="size-4" />
                Only a hospital administrator can change these.
              </p>
            )}
          </fieldset>
        </form>
      </CardBody>
    </Card>
  )
}

/**
 * The hospital's own record.
 *
 * Profile and settings are separate cards with separate permissions and separate save
 * buttons on purpose. `hospital:write` may correct a phone number; only
 * `hospital:settings:manage` may change how the hospital operates. Merging them would
 * mean whoever holds the weaker permission can silently edit the stronger one's fields,
 * and the audit trail would record one action for two different kinds of change.
 *
 * Nothing here can change the slug or the status. The slug is the tenant's public
 * identity and changing it would break every link ever issued; the status is a platform
 * decision, not a hospital one.
 */
export function HospitalProfilePage() {
  const { user } = useAuth()
  const [notice, setNotice] = useState<string | null>(null)

  const canEditProfile = user !== null && hasPermission(user, 'hospital:write')
  const canEditSettings = user !== null && hasPermission(user, 'hospital:settings:manage')

  const profile = useQuery({
    queryKey: ['hospital', 'profile'],
    queryFn: ({ signal }) => fetchHospitalProfile(signal),
  })

  if (profile.isPending) {
    return (
      <AppShell title="Hospital" breadcrumbs={[{ label: 'Operations' }, { label: 'Hospital' }]}>
        <LoadingState label="Loading your hospital…" />
      </AppShell>
    )
  }

  if (profile.isError) {
    return (
      <AppShell title="Hospital" breadcrumbs={[{ label: 'Operations' }, { label: 'Hospital' }]}>
        <Card>
          <CardBody>
            <ErrorState
              title="Could not load your hospital"
              message={
                profile.error instanceof ApiClientError
                  ? profile.error.message
                  : 'The hospital record could not be retrieved.'
              }
              onRetry={() => void profile.refetch()}
              retrying={profile.isFetching}
            />
          </CardBody>
        </Card>
      </AppShell>
    )
  }

  const data = profile.data
  if (!data) return null

  return (
    <AppShell
      title="Hospital"
      breadcrumbs={[{ label: 'Operations' }, { label: 'Hospital' }]}
      wide
    >
      <div className="space-y-5">
        {notice ? (
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile label="Plan" value={data.planLabel} hint="Set by the platform operator" />
          <StatTile label="Status" value={data.status} hint="Only the platform can change this" />
          <StatTile
            label="Seats"
            value={data.seatLimit ?? 'Unlimited'}
            hint="Staff accounts included in your plan"
          />
        </div>

        <ProfileForm
          key={data.id}
          hospital={data}
          canEdit={canEditProfile}
          onSaved={setNotice}
        />

        <SettingsForm
          key={`settings-${data.id}`}
          hospital={data}
          canEdit={canEditSettings}
          onSaved={setNotice}
        />
      </div>
    </AppShell>
  )
}