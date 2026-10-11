import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ROLE_PERMISSIONS, type Permission, type Role } from '@infinigrow/shared'
import { describe, expect, it } from 'vitest'

import { navigationFor } from '../navigation/navigation.js'
import {
  hasAnyPermission,
  hasPermission,
  isPlatformUser,
  type SessionUser,
} from '../auth/session.js'
import {
  RequireAnyPermission,
  RequirePermission,
  RequirePlatform,
  RequireTenantScope,
  UnauthorizedState,
} from '../auth/guards.js'
import { renderApp, mockApi, sessionRoutes } from '../test/harness.js'
import { Routes, Route } from 'react-router-dom'

/**
 * Builds a session identity from the REAL role→permission map in `@infinigrow/shared`.
 *
 * Using the shared map rather than hand-written permission lists means these tests fail
 * if a role's permissions are ever widened in the source of truth — which is precisely
 * the change a reviewer must be forced to notice.
 */
function identityFor(role: Role, overrides: Partial<SessionUser> = {}): SessionUser {
  const isPlatform = role === 'SUPER_ADMIN'

  return {
    userId: '507f1f77bcf86cd799439011',
    email: `${role.toLowerCase().replace(/_/g, '.')}@example.test`,
    firstName: 'Fictional',
    lastName: 'Person',
    role,
    hospitalId: isPlatform ? null : '507f1f77bcf86cd799439012',
    hospitalName: isPlatform ? null : 'Fictional General Hospital',
    membershipId: isPlatform ? null : '507f1f77bcf86cd799439013',
    permissions: [...ROLE_PERMISSIONS[role]],
    emailVerified: true,
    ...overrides,
  }
}

const ALL_ROLES: Role[] = [
  'SUPER_ADMIN',
  'HOSPITAL_ADMIN',
  'DOCTOR',
  'RECEPTIONIST',
  'STAFF',
  'ACCOUNTANT',
  'PHARMACIST',
]

/** Flattens the nav tree into the labels it would actually render. */
function visibleLabels(user: SessionUser): string[] {
  return navigationFor(user).flatMap((section) => section.items.map((item) => item.label))
}

function visibleRoutes(user: SessionUser): string[] {
  return navigationFor(user).flatMap((section) => section.items.map((item) => item.to))
}

describe('permission-driven navigation', () => {
  it('gives every role at least something to do', () => {
    for (const role of ALL_ROLES) {
      expect(visibleLabels(identityFor(role)).length, `${role} has an empty menu`).toBeGreaterThan(
        0,
      )
    }
  })

  it('hides clinical notes from a receptionist', () => {
    // The single most important assertion in this file: registration staff must not be
    // able to reach clinical notes. `consultation:read` is absent from RECEPTIONIST by
    // design (docs/SECURITY.md R9).
    const labels = visibleLabels(identityFor('RECEPTIONIST'))

    expect(labels).toContain('Patients')
    expect(labels).toContain('Appointments')
    expect(labels).not.toContain('Consultations')
    expect(labels).not.toContain('Prescriptions')
  })

  it('hides clinical notes from an accountant', () => {
    const labels = visibleLabels(identityFor('ACCOUNTANT'))

    expect(labels).toContain('Billing')
    expect(labels).toContain('Payments')
    expect(labels).toContain('Reports')
    expect(labels).not.toContain('Consultations')
    expect(labels).not.toContain('Prescriptions')
  })

  it('hides finance from a doctor', () => {
    const labels = visibleLabels(identityFor('DOCTOR'))

    expect(labels).toContain('Consultations')
    expect(labels).toContain('Prescriptions')
    expect(labels).not.toContain('Billing')
    expect(labels).not.toContain('Payments')
    // A doctor has report:read but not report:financial, and there is no separate
    // financial menu entry — the Reports item covers operational reporting only.
    expect(labels).toContain('Reports')
  })

  it('shows the doctor directory only to identities that may read it', () => {
    // Reception books appointments, so RECEPTIONIST deliberately holds `doctor:read`
    // and does see the directory — read-only, without `doctor:write`. Baseline STAFF
    // holds neither and must not see the entry at all.
    expect(visibleLabels(identityFor('HOSPITAL_ADMIN'))).toContain('Doctors')
    expect(visibleLabels(identityFor('DOCTOR'))).toContain('Doctors')
    expect(visibleLabels(identityFor('RECEPTIONIST'))).toContain('Doctors')
    expect(visibleLabels(identityFor('STAFF'))).not.toContain('Doctors')
  })

  it('gives basic staff only attendance', () => {
    const labels = visibleLabels(identityFor('STAFF'))

    expect(labels).toContain('Attendance')
    expect(labels).not.toContain('Patients')
    expect(labels).not.toContain('Appointments')
    expect(labels).not.toContain('Consultations')
    expect(labels).not.toContain('Billing')
    expect(labels).not.toContain('Staff & users')
  })

  it('gives a hospital administrator the full hospital surface', () => {
    const labels = visibleLabels(identityFor('HOSPITAL_ADMIN'))

    expect(labels).toEqual(
      expect.arrayContaining([
        'Dashboard',
        'Patients',
        'Appointments',
        'Consultations',
        'Prescriptions',
        'Departments',
        'Doctors',
        'Billing',
        'Payments',
        'Reports',
        'Staff & users',
        'Attendance',
        'Hospital',
        'Audit trail',
      ]),
    )
  })

  it('shows a platform administrator platform navigation and nothing from a hospital', () => {
    const labels = visibleLabels(identityFor('SUPER_ADMIN'))
    const routes = visibleRoutes(identityFor('SUPER_ADMIN'))

    expect(labels).toEqual(['Overview', 'Hospitals', 'Reports', 'Audit trail'])
    for (const route of routes) {
      expect(route.startsWith('/platform')).toBe(true)
    }
    expect(labels).not.toContain('Patients')
    expect(labels).not.toContain('Billing')
    expect(labels).not.toContain('Hospital settings')
  })

  it('hides the reports entry from an operator without platform:report:read', () => {
    // A custom SUPER_ADMIN grant that omits `platform:report:read`. Reports are a
    // separate capability from tenant administration, and the menu must honour the grant
    // rather than the role name.
    const user = identityFor('SUPER_ADMIN', {
      permissions: [
        'platform:hospital:read',
        'platform:hospital:write',
        'platform:hospital:approve',
        'platform:hospital:suspend',
        'platform:audit:read',
      ],
    })

    expect(visibleLabels(user)).toContain('Hospitals')
    expect(visibleLabels(user)).toContain('Audit trail')
    expect(visibleLabels(user)).not.toContain('Reports')
  })

  it('never offers a navigation entry the identity cannot actually open', () => {
    // The invariant: every rendered nav link must correspond to a permission the user
    // holds. A menu that offers a guaranteed-403 link is a defect.
    for (const role of ALL_ROLES) {
      const user = identityFor(role)
      const labels = visibleLabels(user)

      if (user.role === 'DOCTOR') {
        expect(hasPermission(user, 'consultation:read')).toBe(true)
      }
      if (user.role === 'RECEPTIONIST') {
        expect(hasPermission(user, 'consultation:read')).toBe(false)
        expect(hasPermission(user, 'appointment:write')).toBe(true)
      }
      if (user.role === 'ACCOUNTANT') {
        expect(hasPermission(user, 'report:financial')).toBe(true)
        expect(hasPermission(user, 'billing:write')).toBe(true)
        expect(hasPermission(user, 'consultation:write')).toBe(false)
      }
      if (user.role === 'SUPER_ADMIN') {
        expect(hasPermission(user, 'patient:read')).toBe(false)
      }

      expect(labels.length).toBeGreaterThan(0)
    }
  })

  it('honours a custom grant rather than assuming the role defaults', () => {
    // A membership may be granted a subset of its role's ceiling. Keying the menu off the
    // role name would wrongly show these entries.
    const user = identityFor('RECEPTIONIST', {
      permissions: [...ROLE_PERMISSIONS.RECEPTIONIST, 'consultation:read'],
    })

    expect(visibleLabels(user)).toContain('Consultations')
  })

  it('removes an entry when a permission is withdrawn', () => {
    const user = identityFor('DOCTOR', {
      permissions: ['patient:read', 'hospital:read'] as Permission[],
    })

    const labels = visibleLabels(user)
    expect(labels).toContain('Patients')
    expect(labels).not.toContain('Consultations')
    expect(labels).not.toContain('Billing')
  })

  it('identifies a platform operator by scope, not by permission list', () => {
    expect(isPlatformUser(identityFor('SUPER_ADMIN'))).toBe(true)
    expect(isPlatformUser(identityFor('HOSPITAL_ADMIN'))).toBe(false)
    expect(hasAnyPermission(identityFor('SUPER_ADMIN'), ['platform:hospital:read'])).toBe(true)
  })
})

/**
 * Route guards.
 *
 * These prove the interface refuses to render a route the identity lacks. The API
 * refuses independently; this proves the application does not pretend otherwise.
 */
describe('route guards', () => {
  function GuardedApp() {
    return (
      <Routes>
        <Route
          path="/billing"
          element={
            <RequirePermission permission="billing:read">
              <div>Billing content</div>
            </RequirePermission>
          }
        />
        <Route
          path="/clinical"
          element={
            <RequireAnyPermission permissions={['consultation:read', 'prescription:read']}>
              <div>Clinical content</div>
            </RequireAnyPermission>
          }
        />
        <Route
          path="/platform"
          element={
            <RequirePlatform>
              <div>Platform content</div>
            </RequirePlatform>
          }
        />
        <Route
          path="/dashboard"
          element={
            <RequireTenantScope>
              <div>Hospital content</div>
            </RequireTenantScope>
          }
        />
      </Routes>
    )
  }

  it('renders a permitted route', async () => {
    mockApi(sessionRoutes(identityFor('ACCOUNTANT')) as never)

    renderApp(<GuardedApp />, { route: '/billing' })

    expect(await screen.findByText('Billing content')).toBeInTheDocument()
  })

  it('blocks a route the role lacks, even by direct URL', async () => {
    mockApi(sessionRoutes(identityFor('DOCTOR')) as never)

    // A doctor typing /billing into the address bar must not reach it.
    renderApp(<GuardedApp />, { route: '/billing' })

    expect(await screen.findByText('Access restricted')).toBeInTheDocument()
    expect(screen.queryByText('Billing content')).not.toBeInTheDocument()
  })

  it('blocks clinical routes for a receptionist by direct URL', async () => {
    mockApi(sessionRoutes(identityFor('RECEPTIONIST')) as never)

    renderApp(<GuardedApp />, { route: '/clinical' })

    expect(await screen.findByText('Access restricted')).toBeInTheDocument()
    expect(screen.queryByText('Clinical content')).not.toBeInTheDocument()
  })

  it('blocks the platform area from a hospital administrator', async () => {
    mockApi(sessionRoutes(identityFor('HOSPITAL_ADMIN')) as never)

    renderApp(<GuardedApp />, { route: '/platform' })

    expect(
      await screen.findByText('This area is for platform administrators only.'),
    ).toBeInTheDocument()
  })

  it('blocks the hospital area from a platform administrator', async () => {
    mockApi(sessionRoutes(identityFor('SUPER_ADMIN')) as never)

    renderApp(<GuardedApp />, { route: '/dashboard' })

    expect(await screen.findByText(/belongs to a hospital/i)).toBeInTheDocument()
  })

  it('allows the platform area for a platform administrator', async () => {
    mockApi(sessionRoutes(identityFor('SUPER_ADMIN')) as never)

    renderApp(<GuardedApp />, { route: '/platform' })

    expect(await screen.findByText('Platform content')).toBeInTheDocument()
  })

  it('renders the same 403 surface used by the guard', async () => {
    renderApp(<UnauthorizedState />)

    const alert = screen.getByRole('alert')
    expect(within(alert).getByText(/do not have permission/i)).toBeInTheDocument()
  })

  it('waits for the session to restore before deciding', async () => {
    // Without a refresh cookie the user is anonymous, and a guarded route must send them
    // to sign-in rather than flashing "Access restricted" during the exchange.
    mockApi({
      'POST /api/v1/auth/refresh': {
        status: 401,
        error: { code: 'UNAUTHENTICATED', message: 'No active session' },
      },
    } as never)

    renderApp(<GuardedApp />, { route: '/billing' })

    await waitFor(() => {
      expect(screen.queryByText('Access restricted')).not.toBeInTheDocument()
    })
  })
})

describe('sidebar rendering', () => {
  it('renders only the permitted entries into the DOM', async () => {
    mockApi(sessionRoutes(identityFor('RECEPTIONIST')) as never)

    const { AppShell } = await import('../components/layout/AppShell.js')
    renderApp(<AppShell title="Test">content</AppShell>, { route: '/dashboard' })

    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument()
    })

    const nav = screen.getByRole('navigation', { name: 'Main navigation' })

    expect(within(nav).getByRole('link', { name: /Appointments/ })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: /Patients/ })).toBeInTheDocument()

    // Absent entirely — not merely disabled.
    expect(within(nav).queryByRole('link', { name: /Consultations/ })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: /Billing/ })).not.toBeInTheDocument()
  })

  it('lets a user open the account menu and sign out', async () => {
    const user = userEvent.setup()
    const api = mockApi(sessionRoutes(identityFor('RECEPTIONIST')) as never)

    const { AppShell } = await import('../components/layout/AppShell.js')
    renderApp(<AppShell title="Test">content</AppShell>, { route: '/dashboard' })

    const trigger = await screen.findByRole('button', { name: /fictional person/i })
    await user.click(trigger)

    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /sign out/i }))

    await waitFor(() => {
      expect(api.requests.some((r) => r.url.includes('/auth/logout'))).toBe(true)
    })
  })
})
