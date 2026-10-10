import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'

import { passwordSchema } from '@infinigrow/shared'

import { registerHospital } from '../../auth/session.js'
import { ApiClientError } from '../../lib/api-client.js'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody } from '../../components/ui/Card.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { BrandMark } from '../../components/layout/BrandMark.js'

interface FormValues {
  hospitalName: string
  registrationNumber: string
  contactEmail: string
  contactPhone: string
  city: string
  state: string
  firstName: string
  lastName: string
  adminEmail: string
  password: string
  confirmPassword: string
}

/**
 * Minimum password length, derived from the same Zod schema the API validates with.
 *
 * Reading it rather than hardcoding 12 means the form cannot drift from the server and
 * reject a password the API would happily accept — the failure mode where a legitimate
 * user is told their passphrase is too weak by a rule that exists only in the browser.
 */
function minimumPasswordLength(): number {
  for (let length = 1; length <= 200; length += 1) {
    if (passwordSchema.safeParse('x'.repeat(length)).success) return length
  }
  return 12
}

const MIN_PASSWORD_LENGTH = minimumPasswordLength()

const EMPTY: FormValues = {
  hospitalName: '',
  registrationNumber: '',
  contactEmail: '',
  contactPhone: '',
  city: '',
  state: '',
  firstName: '',
  lastName: '',
  adminEmail: '',
  password: '',
  confirmPassword: '',
}

/**
 * Hospital registration.
 *
 * Submits to the real `POST /platform/hospitals`, which creates the hospital in `PENDING`
 * and the administrator account in `PENDING_VERIFICATION`. Neither can sign in until a
 * platform administrator approves the tenant, so the success screen says exactly that
 * rather than implying immediate access.
 *
 * Client validation mirrors the server's rules to give fast feedback; the server remains
 * the authority and its field errors are mapped back onto the inputs when it disagrees.
 */
export function RegisterHospitalPage() {
  const [values, setValues] = useState<FormValues>(EMPTY)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [registered, setRegistered] = useState<string | null>(null)

  const set = (key: keyof FormValues) => (value: string) =>
    setValues((previous) => ({ ...previous, [key]: value }))

  const validate = (): boolean => {
    const errors: Record<string, string> = {}

    if (!values.hospitalName.trim()) errors['hospitalName'] = 'Enter the hospital name'
    if (!values.registrationNumber.trim()) {
      errors['registrationNumber'] = 'Enter your registration number'
    }
    if (!values.contactEmail.trim()) {
      errors['contactEmail'] = 'Enter a contact email address'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contactEmail.trim())) {
      errors['contactEmail'] = 'Enter a valid email address'
    }
    if (!values.firstName.trim()) errors['firstName'] = 'Enter your first name'
    if (!values.lastName.trim()) errors['lastName'] = 'Enter your last name'

    if (!values.adminEmail.trim()) {
      errors['adminEmail'] = 'Enter your email address'
    } else if (values.adminEmail.trim() !== values.contactEmail.trim()) {
      // Matches the API contract, which requires the administrator to be the registrant.
      errors['adminEmail'] = 'Must be the same address as the hospital contact email'
    }

    if (!values.password) {
      errors['password'] = 'Choose a password'
    } else if (values.password.length < MIN_PASSWORD_LENGTH) {
      // Deliberately a length rule only. The server enforces `passwordSchema` from
      // @infinigrow/shared — 12 characters, no complexity classes — and adding extra
      // rules here would reject passphrases the API accepts. Forcing "one symbol, one
      // digit" tends to produce weaker passwords, not stronger ones
      // (NIST SP 800-63B §3.1.1.2).
      errors['password'] = `Use at least ${MIN_PASSWORD_LENGTH} characters`
    }

    if (values.confirmPassword !== values.password) {
      errors['confirmPassword'] = 'Passwords do not match'
    }

    setFieldErrors(errors)

    if (Object.keys(errors).length > 0) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return false
    }

    return true
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)

    if (!validate()) return

    setSubmitting(true)
    try {
      const result = await registerHospital({
        hospitalName: values.hospitalName.trim(),
        registrationNumber: values.registrationNumber.trim(),
        contactEmail: values.contactEmail.trim(),
        contactPhone: values.contactPhone.trim() || undefined,
        city: values.city.trim() || undefined,
        state: values.state.trim() || undefined,
        admin: {
          firstName: values.firstName.trim(),
          lastName: values.lastName.trim(),
          email: values.adminEmail.trim(),
          password: values.password,
        },
      })
      setRegistered(result.hospitalId)
      window.scrollTo({ top: 0 })
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (Object.keys(error.fieldErrors).length > 0) setFieldErrors(error.fieldErrors)
        setFormError(error.message)
      } else {
        setFormError('We could not reach the server. Check your connection and try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (registered !== null) {
    return (
      <div className="flex min-h-screen flex-col bg-canvas">
        <div className="border-b border-line bg-surface">
          <div className="mx-auto flex h-16 max-w-5xl items-center px-5">
            <BrandMark />
          </div>
        </div>

        <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-12">
          <Card>
            <CardBody className="flex flex-col items-center py-10 text-center">
              <CheckCircle2 aria-hidden="true" className="size-12 text-success" />
              <h1 className="mt-4 text-2xl font-semibold text-navy-900">Registration received</h1>
              <p className="mt-2 max-w-prose text-sm text-ink-muted">
                <strong className="font-medium text-ink">{values.hospitalName}</strong> has been
                registered and is awaiting approval by the Infinigrow platform team. You will be
                able to sign in once a platform administrator approves the hospital and activates
                your account.
              </p>

              <dl className="mt-6 grid w-full gap-px overflow-hidden rounded-lg border border-line bg-line text-left sm:grid-cols-2">
                <div className="bg-surface px-4 py-3">
                  <dt className="text-xs text-ink-subtle">Status</dt>
                  <dd className="mt-0.5 text-sm font-medium text-warning">Pending approval</dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="text-xs text-ink-subtle">Reference</dt>
                  <dd className="mt-0.5 font-mono text-xs text-ink">{registered}</dd>
                </div>
              </dl>

              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <Link to="/login">
                  <Button variant="secondary">Back to sign in</Button>
                </Link>
                <Link to="/">
                  <Button variant="ghost">Return to site</Button>
                </Link>
              </div>
            </CardBody>
          </Card>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5">
          <Link to="/">
            <BrandMark />
          </Link>
          <Link
            to="/login"
            className="text-sm font-medium text-brand-700 underline underline-offset-4"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 py-10">
        <div className="max-w-2xl">
          <h1 className="text-3xl font-semibold text-navy-900">Register your hospital</h1>
          <p className="mt-2 text-sm text-ink-muted">
            Create a tenant on Infinigrow Hospital Cloud. Your account stays inactive until the
            platform team approves the hospital — this is deliberate, and prevents unverified
            organisations from appearing in the platform.
          </p>
        </div>

        {formError ? (
          <Alert tone="danger" className="mt-6" title="Registration failed">
            {formError}
          </Alert>
        ) : null}

        <Card className="mt-6">
          <CardBody>
            <form onSubmit={(event) => void onSubmit(event)} className="space-y-5" noValidate>
              <fieldset className="space-y-5">
                <legend className="text-sm font-semibold text-navy-900">Hospital details</legend>

                <FormField label="Hospital name" error={fieldErrors['hospitalName']} required>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      invalid={invalid}
                      aria-describedby={describedBy}
                      autoComplete="organization"
                      value={values.hospitalName}
                      onChange={(event) => set('hospitalName')(event.target.value)}
                      placeholder="e.g. Aarav Memorial Hospital"
                    />
                  )}
                </FormField>

                <FormField
                  label="Registration number"
                  error={fieldErrors['registrationNumber']}
                  required
                  hint="As issued by your state health authority."
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      invalid={invalid}
                      aria-describedby={describedBy}
                      value={values.registrationNumber}
                      onChange={(event) => set('registrationNumber')(event.target.value)}
                      placeholder="e.g. GJ/2026/1042"
                    />
                  )}
                </FormField>

                <FormField label="Contact email" error={fieldErrors['contactEmail']} required>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      invalid={invalid}
                      aria-describedby={describedBy}
                      value={values.contactEmail}
                      onChange={(event) => set('contactEmail')(event.target.value)}
                    />
                  )}
                </FormField>

                <div className="grid gap-5 sm:grid-cols-2">
                  <FormField label="Contact phone" error={fieldErrors['contactPhone']}>
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        invalid={invalid}
                        aria-describedby={describedBy}
                        value={values.contactPhone}
                        onChange={(event) => set('contactPhone')(event.target.value)}
                      />
                    )}
                  </FormField>

                  <FormField label="City" error={fieldErrors['city']}>
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        invalid={invalid}
                        aria-describedby={describedBy}
                        value={values.city}
                        onChange={(event) => set('city')(event.target.value)}
                      />
                    )}
                  </FormField>
                </div>
              </fieldset>

              <fieldset className="space-y-5 border-t border-line pt-5">
                <legend className="text-sm font-semibold text-navy-900">
                  Administrator account
                </legend>
                <p className="text-xs text-ink-subtle">
                  This account will manage users, departments and settings for your hospital.
                </p>

                <div className="grid gap-5 sm:grid-cols-2">
                  <FormField label="First name" error={fieldErrors['firstName']} required>
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        autoComplete="given-name"
                        invalid={invalid}
                        aria-describedby={describedBy}
                        value={values.firstName}
                        onChange={(event) => set('firstName')(event.target.value)}
                      />
                    )}
                  </FormField>

                  <FormField label="Last name" error={fieldErrors['lastName']} required>
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        autoComplete="family-name"
                        invalid={invalid}
                        aria-describedby={describedBy}
                        value={values.lastName}
                        onChange={(event) => set('lastName')(event.target.value)}
                      />
                    )}
                  </FormField>
                </div>

                <FormField label="Your email" error={fieldErrors['adminEmail']} required>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      invalid={invalid}
                      aria-describedby={describedBy}
                      value={values.adminEmail}
                      onChange={(event) => set('adminEmail')(event.target.value)}
                    />
                  )}
                </FormField>

                <FormField
                  label="Password"
                  error={fieldErrors['password']}
                  required
                  hint={`At least ${MIN_PASSWORD_LENGTH} characters. A short phrase you can remember is stronger than a short complicated one.`}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="password"
                      autoComplete="new-password"
                      invalid={invalid}
                      aria-describedby={describedBy}
                      value={values.password}
                      onChange={(event) => set('password')(event.target.value)}
                    />
                  )}
                </FormField>

                <FormField label="Confirm password" error={fieldErrors['confirmPassword']} required>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="password"
                      autoComplete="new-password"
                      invalid={invalid}
                      aria-describedby={describedBy}
                      value={values.confirmPassword}
                      onChange={(event) => set('confirmPassword')(event.target.value)}
                    />
                  )}
                </FormField>
              </fieldset>

              <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
                <Button
                  type="submit"
                  size="lg"
                  busy={submitting}
                  busyLabel="Submitting, please wait"
                >
                  Submit registration
                </Button>
                <p className="text-xs text-ink-subtle">
                  All details are used to verify the organisation. We never store patient data here.
                </p>
              </div>
            </form>
          </CardBody>
        </Card>
      </main>
    </div>
  )
}
