import { screen } from '@testing-library/react'
import { ROLE_PERMISSIONS } from '@infinigrow/shared'
import { describe, expect, it } from 'vitest'

import { HospitalDashboard } from '../dashboard/HospitalDashboard.js'
import { mockApi, renderApp, sessionRoutes, type MockUser } from '../../test/harness.js'
import { expectNoSeriousViolations } from '../../test/a11y.js'

describe('HospitalDashboard', () => {
  const RECEPTIONIST: MockUser = {
    userId: '507f1f77bcf86cd799439011',
    email: 'reception@fictional.test',
    firstName: 'Fictional',
    lastName: 'Receptionist',
    role: 'RECEPTIONIST',
    hospitalId: '507f1f77bcf86cd799439012',
    hospitalName: 'Fictional General Hospital',
    membershipId: '507f1f77bcf86cd799439013',
    permissions: [...ROLE_PERMISSIONS.RECEPTIONIST],
  }

  it('names the hospital, so the scope is never ambiguous', async () => {
    mockApi(sessionRoutes(RECEPTIONIST))
    renderApp(<HospitalDashboard />, { route: '/dashboard' })

    // Appears both in the sidebar scope footer and on the dashboard card — both are
    // deliberate, so a repeated match is expected rather than a defect.
    expect((await screen.findAllByText('Fictional General Hospital')).length).toBeGreaterThan(0)
  })

  it('offers only the modules the role can open', async () => {
    mockApi(sessionRoutes(RECEPTIONIST))
    renderApp(<HospitalDashboard />, { route: '/dashboard' })

    const modules = await screen.findByRole('heading', { name: /your modules/i })
    expect(modules).toBeInTheDocument()

    expect(screen.getByRole('link', { name: /patients/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /appointments/i })).toBeInTheDocument()

    expect(screen.queryByRole('link', { name: /consultations/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /billing/i })).not.toBeInTheDocument()
  })

  it('lists the withheld modules so the absence is explained, not silent', async () => {
    mockApi(sessionRoutes(RECEPTIONIST))
    renderApp(<HospitalDashboard />, { route: '/dashboard' })

    expect(
      await screen.findByRole('heading', { name: /not available to your role/i }),
    ).toBeInTheDocument()

    expect(screen.getByText('Consultations')).toBeInTheDocument()
    expect(screen.getByText('Billing')).toBeInTheDocument()
  })

  it('shows the granted permissions from the issued token', async () => {
    mockApi(sessionRoutes(RECEPTIONIST))
    renderApp(<HospitalDashboard />, { route: '/dashboard' })

    await screen.findByRole('heading', { name: /your access/i })
    expect(screen.getByText('appointment:write')).toBeInTheDocument()
    expect(screen.getByText('patient:write')).toBeInTheDocument()
  })

  it('warns when the email address is unverified', async () => {
    mockApi(sessionRoutes({ ...RECEPTIONIST, emailVerified: false }))
    renderApp(<HospitalDashboard />, { route: '/dashboard' })

    expect(await screen.findByText(/email address not yet verified/i)).toBeInTheDocument()
  })

  it('has no serious accessibility violations', async () => {
    mockApi(sessionRoutes(RECEPTIONIST))
    const { container } = renderApp(<HospitalDashboard />, { route: '/dashboard' })

    await screen.findAllByText('Fictional General Hospital')
    await expectNoSeriousViolations(container)
  })
})
