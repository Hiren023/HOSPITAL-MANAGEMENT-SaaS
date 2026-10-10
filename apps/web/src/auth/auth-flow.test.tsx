import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ROLE_PERMISSIONS } from '@infinigrow/shared'
import { describe, expect, it, vi } from 'vitest'

import { tokenStore } from './token-store.js'
import { LoginPage } from '../features/auth/LoginPage.js'
import { RegisterHospitalPage } from '../features/auth/RegisterHospitalPage.js'
import { NO_SESSION, mockApi, renderApp, sessionRoutes, type MockUser } from '../test/harness.js'
import { useAuth } from './auth-context.js'

const RECEPTIONIST: MockUser = {
  userId: '507f1f77bcf86cd799439011',
  email: 'reception@example.test',
  firstName: 'Fictional',
  lastName: 'Receptionist',
  role: 'RECEPTIONIST',
  permissions: [...ROLE_PERMISSIONS.RECEPTIONIST],
}

const OPERATOR: MockUser = {
  userId: '507f1f77bcf86cd799439011',
  email: 'operator@example.test',
  firstName: 'Fictional',
  lastName: 'Operator',
  role: 'SUPER_ADMIN',
  hospitalId: null,
  hospitalName: null,
  membershipId: null,
  permissions: [...ROLE_PERMISSIONS.SUPER_ADMIN],
}

/** Surfaces auth state so a test can assert on the result of a real sign-in. */
function AuthProbe() {
  const { status, user } = useAuth()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{user?.email ?? 'none'}</span>
    </div>
  )
}

describe('sign-in against the real API path', () => {
  it('sends the credentials and stores the access token in memory only', async () => {
    const user = userEvent.setup()
    const api = mockApi({ ...NO_SESSION, ...sessionRoutes(RECEPTIONIST) })

    renderApp(
      <>
        <LoginPage />
        <AuthProbe />
      </>,
      { route: '/login' },
    )

    await screen.findByLabelText(/email address/i)
    await user.type(screen.getByLabelText(/email address/i), 'reception@example.test')
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery-staple')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
    })

    const loginCall = api.requests.find((r) => r.url.includes('/auth/login'))
    expect(loginCall).toBeDefined()
    expect(loginCall?.method).toBe('POST')
    expect(loginCall?.body).toMatchObject({
      email: 'reception@example.test',
      password: 'correct-horse-battery-staple',
    })

    // The token is held in memory. Nothing is written to storage a script could read.
    expect(tokenStore.get()).toBe('test-access-token')
    expect(localStorage.getItem('accessToken')).toBeNull()
    expect(sessionStorage.getItem('accessToken')).toBeNull()
  })

  it('shows the server message when the credentials are rejected', async () => {
    const user = userEvent.setup()

    mockApi({
      ...NO_SESSION,
      'POST /api/v1/auth/login': {
        status: 401,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      },
    })

    renderApp(<LoginPage />, { route: '/login' })

    await screen.findByLabelText(/email address/i)
    await user.type(screen.getByLabelText(/email address/i), 'reception@example.test')
    await user.type(screen.getByLabelText(/^password/i), 'wrong-password-entirely')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    // The uniform message is the API's anti-enumeration design and is surfaced verbatim.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invalid email or password')

    expect(tokenStore.get()).toBeNull()
  })

  it('does not reveal whether an account exists', async () => {
    const user = userEvent.setup()

    mockApi({
      ...NO_SESSION,
      'POST /api/v1/auth/login': {
        status: 401,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      },
    })

    renderApp(<LoginPage />, { route: '/login' })

    await screen.findByLabelText(/email address/i)
    await user.type(screen.getByLabelText(/email address/i), 'nobody@example.test')
    await user.type(screen.getByLabelText(/^password/i), 'whatever-long-enough')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invalid email or password')
    expect(alert).not.toHaveTextContent(/not found|does not exist|unknown user/i)
  })

  it('validates before making a request', async () => {
    const user = userEvent.setup()
    const api = mockApi({ ...NO_SESSION, ...sessionRoutes(RECEPTIONIST) })

    renderApp(<LoginPage />, { route: '/login' })

    await screen.findByLabelText(/email address/i)
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(await screen.findAllByText('Enter your email address')).toHaveLength(1)
    expect(screen.getByText('Enter your password')).toBeInTheDocument()
    expect(api.requests.some((r) => r.url.includes('/auth/login'))).toBe(false)
  })

  it('rejects a malformed email without contacting the server', async () => {
    const user = userEvent.setup()
    const api = mockApi({ ...NO_SESSION, ...sessionRoutes(RECEPTIONIST) })

    renderApp(<LoginPage />, { route: '/login' })

    await screen.findByLabelText(/email address/i)
    await user.type(screen.getByLabelText(/email address/i), 'not-an-email')
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery-staple')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
    expect(api.requests.some((r) => r.url.includes('/auth/login'))).toBe(false)
  })

  it('maps server field errors back onto the inputs', async () => {
    const user = userEvent.setup()

    mockApi({
      ...NO_SESSION,
      'POST /api/v1/auth/login': {
        status: 422,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request body is invalid.',
          details: [{ path: 'email', message: 'That address is not permitted.' }],
        },
      },
    })

    renderApp(<LoginPage />, { route: '/login' })

    await screen.findByLabelText(/email address/i)
    await user.type(screen.getByLabelText(/email address/i), 'reception@example.test')
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery-staple')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(await screen.findByText('That address is not permitted.')).toBeInTheDocument()
    expect(screen.getByLabelText(/email address/i)).toHaveAttribute('aria-invalid', 'true')
  })

  it('distinguishes an unreachable server from a rejected password', async () => {
    const user = userEvent.setup()

    mockApi({
      ...NO_SESSION,
      'POST /api/v1/auth/login': {
        status: 500,
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
      },
    })

    renderApp(<LoginPage />, { route: '/login' })

    await screen.findByLabelText(/email address/i)
    await user.type(screen.getByLabelText(/email address/i), 'reception@example.test')
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery-staple')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Something went wrong')
    expect(alert).not.toHaveTextContent('Invalid email or password')
  })

  it('restores a session from the refresh cookie on load', async () => {
    mockApi(sessionRoutes(OPERATOR))

    renderApp(<AuthProbe />, { route: '/' })

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
    })
    expect(screen.getByTestId('email')).toHaveTextContent('operator@example.test')
    expect(tokenStore.get()).toBe('test-access-token')
  })

  it('treats a failed refresh as anonymous, without an error banner', async () => {
    mockApi(NO_SESSION)

    renderApp(<AuthProbe />, { route: '/' })

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('anonymous')
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(tokenStore.get()).toBeNull()
  })

  it('marks the submit control busy and disabled while the request is in flight', async () => {
    const user = userEvent.setup()

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    // A refresh that 401s immediately, and a login that hangs until released.
    const refresh = new Response(
      JSON.stringify({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'No active session', requestId: 'r' },
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )

    const login = new Response(
      JSON.stringify({
        success: true,
        data: { accessToken: 'test-access-token', expiresInSeconds: 600, user: RECEPTIONIST },
        meta: { requestId: 'r' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('/auth/refresh')) return refresh.clone()
        await gate
        return login.clone()
      }),
    )

    renderApp(<LoginPage />, { route: '/login' })

    await screen.findByLabelText(/email address/i)
    await user.type(screen.getByLabelText(/email address/i), 'reception@example.test')
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery-staple')

    // Hold the reference before submitting: while busy the accessible name also carries
    // the pending announcement, so a fresh name query would no longer match.
    const submit = screen.getByRole('button', { name: /^sign in$/i })
    await user.click(submit)

    // The control announces that it is working and refuses a repeat submission.
    await waitFor(() => {
      expect(submit).toHaveAttribute('aria-busy', 'true')
      expect(submit).toBeDisabled()
    })
    expect(submit).toHaveTextContent(/signing in, please wait/i)

    release?.()

    await waitFor(() => {
      // The attribute is removed entirely when idle rather than set to "false".
      expect(submit).not.toHaveAttribute('aria-busy')
      expect(submit).not.toBeDisabled()
    })
  })
})

describe('hospital registration against the real API path', () => {
  /**
   * A lowercase passphrase. Chosen deliberately: the API's `passwordSchema` requires
   * length only, so this must be accepted. A client-side complexity rule would have
   * rejected a perfectly good password the server permits.
   */
  const PASSPHRASE = 'correct-horse-battery-staple'

  const fillValid = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByLabelText(/hospital name/i)
    await user.type(screen.getByLabelText(/hospital name/i), 'Fictional General Hospital')
    await user.type(screen.getByLabelText(/registration number/i), 'FG/2026/0001')
    await user.type(screen.getByLabelText(/contact email/i), 'admin@fictional.test')
    await user.type(screen.getByLabelText(/^first name/i), 'Fictional')
    await user.type(screen.getByLabelText(/^last name/i), 'Administrator')
    await user.type(screen.getByLabelText(/^your email/i), 'admin@fictional.test')
    await user.type(screen.getByLabelText(/^password/i), PASSPHRASE)
    await user.type(screen.getByLabelText(/confirm password/i), PASSPHRASE)
  }

  it('registers and reports the pending-approval outcome honestly', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      ...NO_SESSION,
      'POST /api/v1/platform/hospitals': {
        status: 201,
        data: {
          hospitalId: '507f1f77bcf86cd799439099',
          slug: 'fictional-general-hospital',
          status: 'PENDING',
        },
      },
    })

    renderApp(<RegisterHospitalPage />, { route: '/register' })
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: /submit registration/i }))

    expect(
      await screen.findByRole('heading', { name: /registration received/i }),
    ).toBeInTheDocument()

    // It must NOT claim the account is ready to use.
    expect(screen.getByText(/awaiting approval/i)).toBeInTheDocument()
    expect(screen.getByText(/once a platform administrator approves/i)).toBeInTheDocument()

    const call = api.requests.find((r) => r.url.includes('/platform/hospitals'))
    expect(call?.body).toMatchObject({
      hospitalName: 'Fictional General Hospital',
      registrationNumber: 'FG/2026/0001',
      contactEmail: 'admin@fictional.test',
      admin: { email: 'admin@fictional.test', firstName: 'Fictional', lastName: 'Administrator' },
    })
  })

  it('enforces a strong password before submitting', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      ...NO_SESSION,
      'POST /api/v1/platform/hospitals': {
        status: 201,
        data: { hospitalId: 'x', status: 'PENDING' },
      },
    })

    renderApp(<RegisterHospitalPage />, { route: '/register' })

    await screen.findByLabelText(/hospital name/i)
    await user.type(screen.getByLabelText(/hospital name/i), 'Fictional General Hospital')
    await user.type(screen.getByLabelText(/registration number/i), 'FG/2026/0001')
    await user.type(screen.getByLabelText(/contact email/i), 'admin@fictional.test')
    await user.type(screen.getByLabelText(/^first name/i), 'Fictional')
    await user.type(screen.getByLabelText(/^last name/i), 'Administrator')
    await user.type(screen.getByLabelText(/^your email/i), 'admin@fictional.test')
    await user.type(screen.getByLabelText(/^password/i), 'short')
    await user.type(screen.getByLabelText(/confirm password/i), 'short')
    await user.click(screen.getByRole('button', { name: /submit registration/i }))

    expect(await screen.findByText('Use at least 12 characters')).toBeInTheDocument()
    expect(api.requests.some((r) => r.url.includes('/platform/hospitals'))).toBe(false)
  })

  it('accepts a long passphrase without requiring character-class complexity', async () => {
    // The server requires 12 characters and nothing more. Forcing "one digit, one
    // symbol" in the browser would reject a valid password and push users toward
    // predictable substitutions such as Password1!.
    const user = userEvent.setup()
    const api = mockApi({
      ...NO_SESSION,
      'POST /api/v1/platform/hospitals': {
        status: 201,
        data: { hospitalId: '507f1f77bcf86cd799439099', status: 'PENDING' },
      },
    })

    renderApp(<RegisterHospitalPage />, { route: '/register' })
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: /submit registration/i }))

    expect(
      await screen.findByRole('heading', { name: /registration received/i }),
    ).toBeInTheDocument()
    expect(api.requests.some((r) => r.url.includes('/platform/hospitals'))).toBe(true)
  })

  it('shows a duplicate-registration conflict from the server', async () => {
    const user = userEvent.setup()

    mockApi({
      ...NO_SESSION,
      'POST /api/v1/platform/hospitals': {
        status: 409,
        error: { code: 'CONFLICT', message: 'A hospital with that name already exists.' },
      },
    })

    renderApp(<RegisterHospitalPage />, { route: '/register' })
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: /submit registration/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('A hospital with that name already exists.')
    expect(
      screen.queryByRole('heading', { name: /registration received/i }),
    ).not.toBeInTheDocument()
  })
})
