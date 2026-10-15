import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AlertCircle } from 'lucide-react'

import { useAuth } from '../../auth/auth-context.js'
import { homePathFor, isPlatformUser } from '../../auth/session.js'
import { ApiClientError } from '../../lib/api-client.js'
import { Alert } from '../../components/ui/Alert.js'
import { Button } from '../../components/ui/Button.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { BrandMark } from '../../components/layout/BrandMark.js'

interface LocationState {
  from?: string
}

/**
 * Sign-in screen.
 *
 * Calls the real `POST /auth/login`. There is no client-side "demo account" shortcut and
 * no simulated delay: if the server rejects the credentials the user is told, and if the
 * server is unreachable they are told that too, distinctly. A login form that appears to
 * succeed is the single most damaging fake in a clinical product, because every
 * subsequent screen is then built on a fiction.
 *
 * Two distinct failure messages are shown on purpose:
 *  - `INVALID_CREDENTIALS` is the server's deliberately uniform "Invalid email or
 *    password", which does not reveal whether an account exists;
 *  - a transport or 5xx failure says the system is unreachable, because "try again" and
 *    "check your password" are different advice.
 */
export function LoginPage() {
  const { signIn, status } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const destination = (location.state as LocationState | null)?.from

  const validate = (): boolean => {
    const errors: Record<string, string> = {}

    if (email.trim() === '') {
      errors['email'] = 'Enter your email address'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors['email'] = 'Enter a valid email address'
    }

    if (password === '') {
      errors['password'] = 'Enter your password'
    }

    setFieldErrors(errors)

    // Move focus to the first problem so a keyboard or screen-reader user is not left
    // wondering why submission did nothing.
    if (Object.keys(errors).length > 0) {
      const first = document.querySelector<HTMLElement>('[aria-invalid="true"]')
      first?.focus()
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
      const user = await signIn({ email: email.trim(), password })

      // ── The return destination is checked against the signer's own scope ──────
      //
      // `RequireAuth` remembers the URL somebody was trying to reach, so sign-in can put
      // them back there. Honouring it unconditionally means a Super Admin who touched a
      // hospital link before signing in is dropped onto a route their scope cannot open —
      // and the only thing they see is a 403 they have no way out of.
      //
      // So the destination is used only when it belongs to this identity's world. A path
      // they could not have opened is not "where they were going"; it is a stale intent
      // from before they were signed in at all.
      const home = homePathFor(user)
      const wantsPlatformPath =
        destination === '/platform' || (destination?.startsWith('/platform/') ?? false)

      const target =
        destination !== undefined && wantsPlatformPath === isPlatformUser(user)
          ? destination
          : home

      navigate(target, { replace: true })
    } catch (error) {
      if (error instanceof ApiClientError) {
        // Server-side field errors map back onto the inputs.
        if (Object.keys(error.fieldErrors).length > 0) {
          setFieldErrors(error.fieldErrors)
        }
        setFormError(error.message)
      } else {
        setFormError('We could not reach the server. Check your connection and try again.')
      }
      setPassword('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel, desktop only. */}
      <div className="relative hidden flex-col justify-between bg-ink-900 p-12 lg:flex">
        <BrandMark tone="light" />

        <div className="max-w-md">
          <h2 className="text-3xl font-semibold leading-tight text-white">
            One cloud platform for every hospital you run.
          </h2>
          <p className="mt-4 text-ink-200">
            Infini Health keeps patient records, appointments, billing and workforce
            management separated by hospital — and provably so.
          </p>
        </div>

        <dl className="grid grid-cols-3 gap-6 border-t border-white/10 pt-6">
          {[
            { label: 'Tenant isolation', value: 'Enforced' },
            { label: 'Password hashing', value: 'Argon2id' },
            { label: 'Audit trail', value: 'Append-only' },
          ].map((item) => (
            <div key={item.label}>
              <dt className="text-xs text-ink-300">{item.label}</dt>
              <dd className="mt-0.5 text-sm font-medium text-white">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Form panel. */}
      <div className="flex flex-col justify-center bg-surface px-5 py-12 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <BrandMark />
          </div>

          <h1 className="text-2xl font-semibold text-ink-900">Sign in</h1>
          <p className="mt-1.5 text-sm text-body-muted">
            Use the email address your hospital administrator registered.
          </p>

          {formError ? (
            <Alert tone="danger" className="mt-5" title="Could not sign you in">
              {formError}
            </Alert>
          ) : null}

          <form onSubmit={(event) => void onSubmit(event)} className="mt-6 space-y-4" noValidate>
            <FormField label="Email address" error={fieldErrors['email']} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  name="email"
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  autoFocus
                  invalid={invalid}
                  aria-describedby={describedBy}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@hospital.example"
                />
              )}
            </FormField>

            <FormField
              label="Password"
              error={fieldErrors['password']}
              required
              hint={
                <Link to="/forgot-password" className="text-infini-700 underline underline-offset-2">
                  Forgot your password?
                </Link>
              }
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  invalid={invalid}
                  aria-describedby={describedBy}
                  leading={<AlertCircle aria-hidden="true" className="size-4" />}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </FormField>

            <Button
              type="submit"
              size="lg"
              full
              busy={submitting}
              busyLabel="Signing in, please wait"
              disabled={status === 'restoring'}
            >
              Sign in
            </Button>
          </form>

          <p className="mt-8 border-t border-line pt-6 text-center text-sm text-body-muted">
            New hospital?{' '}
            <Link
              to="/register"
              className="font-medium text-infini-700 underline underline-offset-4"
            >
              Request an account
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
