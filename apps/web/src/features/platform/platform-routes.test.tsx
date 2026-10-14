import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { homePathFor, scopeCanOpenPath, type SessionUser } from '../../auth/session.js'
import { describe, expect, it } from 'vitest'
import { ROLE_PERMISSIONS } from '@infinigrow/shared'

import { mockApi, renderAppRoutes, sessionRoutes, type MockUser } from '../../test/harness.js'

/**
 * The platform route table.
 *
 * ── Why this file exists ───────────────────────────────────────────────────────
 *
 * `App.tsx` declared `path="/platform"` **twice**: once for `SuperAdminDashboard` and
 * once for `PlatformOverviewPage`. React Router matches the first entry and silently
 * ignores every later one, so the overview page was unreachable — and the component that
 * won had been left behind when `/platform/hospitals` gained server-side pagination. It
 * still read the response as an array, called `.slice()` on `undefined`, and crashed, so
 * the Super Admin panel rendered a blank screen.
 *
 * Nothing failed loudly. The component's own test mocked `/platform/hospitals` in the
 * shape it had when it was written, so it kept passing while the real route was broken.
 * The only way to catch it is to render the **route**, not the component.
 */

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

const OVERVIEW = {
  tenants: { total: 3, pending: 1, approved: 1, suspended: 1, rejected: 0 },
  identity: { totalUsers: 12, activeMemberships: 14 },
  plans: { STARTER: 1, HOSPITAL: 1, ENTERPRISE: 1 },
  recentActivity: { last24h: 7, mostRecentAt: '2027-01-02T09:00:00.000Z' },
}

describe('platform routes', () => {
  it('renders the overview at /platform', async () => {
    mockApi({
      ...sessionRoutes(OPERATOR),
      'GET /api/v1/platform/overview': { data: OVERVIEW },
    })

    await renderAppRoutes('/platform')

    // A real figure from the real endpoint, which is the thing the duplicate route was
    // hiding.
    expect(await screen.findByText('3')).toBeDefined()
  })

  it('does not crash at /platform whatever the overview contains', async () => {
    mockApi({
      ...sessionRoutes(OPERATOR),
      'GET /api/v1/platform/overview': { data: OVERVIEW },
    })

    await renderAppRoutes('/platform')

    // The failure mode of the shadowed route was a thrown TypeError, so the screen went
    // blank with no message. Asserting overview-specific content is what proves the
    // render completed rather than crashed.
    await screen.findByText('Pending approval')
    expect(screen.getByText('Approved')).toBeDefined()
    expect(screen.getByText('Suspended')).toBeDefined()
  })

  it('shows an error rather than a blank screen when the overview fails', async () => {
    mockApi({
      ...sessionRoutes(OPERATOR),
      'GET /api/v1/platform/overview': {
        status: 500,
        error: { code: 'INTERNAL_ERROR', message: 'The platform console is unavailable.' },
      },
    })

    await renderAppRoutes('/platform')

    // A blank screen is the worst possible answer to a failed request: the operator
    // cannot tell a bug from a slow server.
    expect(await screen.findByRole('alert')).toBeDefined()
  })

  it('keeps a hospital administrator out of the platform console', async () => {
    const admin: MockUser = {
      userId: '507f1f77bcf86cd7994390c1',
      email: 'meera.nair@example.test',
      firstName: 'Meera',
      lastName: 'Nair',
      role: 'HOSPITAL_ADMIN',
      hospitalId: '507f1f77bcf86cd7994390b1',
      hospitalName: 'Aarav Memorial Hospital',
      membershipId: '507f1f77bcf86cd7994390c2',
      permissions: [...ROLE_PERMISSIONS.HOSPITAL_ADMIN],
    }

    const api = mockApi({ ...sessionRoutes(admin) })

    await renderAppRoutes('/platform')

    expect(await screen.findByText(/platform administrators only/i)).toBeDefined()
    // The guard must stop the request, not merely hide the result.
    expect(api.requests.some((r) => r.url.includes('/platform/overview'))).toBe(false)
  })

  it('keeps a platform operator out of a hospital screen', async () => {
    const api = mockApi({ ...sessionRoutes(OPERATOR) })

    await renderAppRoutes('/patients')

    expect(await screen.findByText(/belongs to a hospital/i)).toBeDefined()
    expect(api.requests.some((r) => r.url.includes('/api/v1/patients'))).toBe(false)
  })

  it('sends an operator to sign-in rather than looping on a redirect', async () => {
    mockApi({})

    await renderAppRoutes('/platform')

    // With no session the guard redirects to /login. Rendering the login form is the
    // observable outcome; a blank shell here would be a redirect loop nobody could read.
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeDefined()
  })
})

describe('a platform operator is never stranded', () => {
  /**
   * The reported failure, pinned at the decision that caused it.
   *
   * `RequireAuth` stores the attempted URL so sign-in can return someone to where they
   * were going. `LoginPage` honoured that unconditionally, so a Super Admin who touched a
   * hospital page before signing in was dropped onto `/dashboard` — a route their own
   * scope forbids — and the only link offered pointed at another forbidden route.
   *
   * These test the two functions that decide it, rather than a whole sign-in flow. A flow
   * test here would pass or fail on harness bootstrap details rather than on the rule, and
   * a test that fails for the wrong reason is worse than no test.
   */
  it('knows which world each identity belongs to', () => {
    const admin: MockUser = {
      userId: '507f1f77bcf86cd7994390c1',
      email: 'meera.nair@example.test',
      firstName: 'Meera',
      lastName: 'Nair',
      role: 'HOSPITAL_ADMIN',
      hospitalId: '507f1f77bcf86cd7994390b1',
      hospitalName: 'Aarav Memorial Hospital',
      membershipId: '507f1f77bcf86cd7994390c2',
      permissions: [...ROLE_PERMISSIONS.HOSPITAL_ADMIN],
    }

    // The two homes. A platform operator has no hospital, so `/dashboard` is not a
    // neutral fallback for one — it is a route their scope cannot open.
    expect(homePathFor(OPERATOR as unknown as SessionUser)).toBe('/platform')
    expect(homePathFor(admin as unknown as SessionUser)).toBe('/dashboard')
    expect(homePathFor(null)).toBe('/login')
  })

  it('refuses a hospital destination to a platform operator, and the reverse', () => {
    const admin: MockUser = {
      userId: '507f1f77bcf86cd7994390c1',
      email: 'meera.nair@example.test',
      firstName: 'Meera',
      lastName: 'Nair',
      role: 'HOSPITAL_ADMIN',
      hospitalId: '507f1f77bcf86cd7994390b1',
      hospitalName: 'Aarav Memorial Hospital',
      membershipId: '507f1f77bcf86cd7994390c2',
      permissions: [...ROLE_PERMISSIONS.HOSPITAL_ADMIN],
    }

    // The exact case reported: a platform operator carrying `/patients` as their
    // destination. It must not be honoured.
    expect(scopeCanOpenPath(OPERATOR as unknown as SessionUser, '/patients')).toBe(false)
    expect(scopeCanOpenPath(OPERATOR as unknown as SessionUser, '/dashboard')).toBe(false)
    expect(scopeCanOpenPath(OPERATOR as unknown as SessionUser, '/platform')).toBe(true)
    expect(scopeCanOpenPath(OPERATOR as unknown as SessionUser, '/platform/hospitals')).toBe(true)

    // And symmetrically, so a hospital user is not sent to the console either.
    expect(scopeCanOpenPath(admin as unknown as SessionUser, '/platform')).toBe(false)
    expect(scopeCanOpenPath(admin as unknown as SessionUser, '/patients')).toBe(true)
    expect(scopeCanOpenPath(admin as unknown as SessionUser, '/dashboard')).toBe(true)
  })

  it('treats the platform path as a whole segment, not a string prefix', () => {
    // A hospital route that merely STARTS with the letters "platform" must not be
    // classified as a console route. `startsWith('/platform')` without the slash would
    // get this wrong.
    expect(scopeCanOpenPath(OPERATOR as unknown as SessionUser, '/platform-notes')).toBe(false)
  })

  it('offers a platform operator a way out of a hospital screen', async () => {
    mockApi({ ...sessionRoutes(OPERATOR) })

    await renderAppRoutes('/patients')

    expect(await screen.findByText('Access restricted')).toBeDefined()

    // The advice must fit the reader. "Ask a hospital administrator" is meaningless to
    // somebody who has no hospital, and it is the only help this screen gives.
    expect(
      screen.getByText(/do not belong to any hospital/i),
    ).toBeDefined()
    expect(screen.queryByText(/ask a hospital administrator/i)).toBeNull()
  })

  it('sends a platform operator back to the console, not to another 403', async () => {
    mockApi({
      ...sessionRoutes(OPERATOR),
      'GET /api/v1/platform/overview': { data: OVERVIEW },
    })

    const user = userEvent.setup()
    await renderAppRoutes('/patients')

    await screen.findByText('Access restricted')
    await user.click(screen.getByRole('link', { name: /platform console/i }))

    // A client-side `Link`, and pointed at a route this identity can open. The old version
    // was an `<a href="/dashboard">`, which for this identity was another dead end.
    expect(await screen.findByText('Pending approval')).toBeDefined()
  })

  it('keeps the hospital wording for a hospital user', async () => {
    const admin: MockUser = {
      userId: '507f1f77bcf86cd7994390c1',
      email: 'meera.nair@example.test',
      firstName: 'Meera',
      lastName: 'Nair',
      role: 'HOSPITAL_ADMIN',
      hospitalId: '507f1f77bcf86cd7994390b1',
      hospitalName: 'Aarav Memorial Hospital',
      membershipId: '507f1f77bcf86cd7994390c2',
      permissions: [...ROLE_PERMISSIONS.HOSPITAL_ADMIN],
    }

    mockApi({ ...sessionRoutes(admin) })

    await renderAppRoutes('/platform')

    expect(await screen.findByText(/platform administrators only/i)).toBeDefined()
    // For a hospital user the original advice is exactly right and must stay.
    expect(screen.getByText(/ask a hospital administrator/i)).toBeDefined()
    expect(screen.getByRole('link', { name: /your dashboard/i })).toBeDefined()
  })
})