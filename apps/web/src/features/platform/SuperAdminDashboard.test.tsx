import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ROLE_PERMISSIONS } from '@infinigrow/shared'
import { describe, expect, it, vi } from 'vitest'

import { SuperAdminDashboard } from './SuperAdminDashboard.js'
import { HospitalDashboard } from '../dashboard/HospitalDashboard.js'
import { mockApi, renderApp, sessionRoutes, type MockUser } from '../../test/harness.js'
import { expectNoSeriousViolations } from '../../test/a11y.js'

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

/** Fictional tenants. No real hospitals, no real people. */
const TENANTS = [
  {
    id: '507f1f77bcf86cd7994390a1',
    name: 'Aarav Memorial Hospital',
    slug: 'aarav-memorial-hospital',
    status: 'PENDING',
    createdAt: '2026-10-01T09:00:00.000Z',
  },
  {
    id: '507f1f77bcf86cd7994390a2',
    name: 'Bhavna Community Hospital',
    slug: 'bhavna-community-hospital',
    status: 'APPROVED',
    createdAt: '2026-09-14T09:00:00.000Z',
  },
  {
    id: '507f1f77bcf86cd7994390a3',
    name: 'Charak Diagnostics Centre',
    slug: 'charak-diagnostics-centre',
    status: 'SUSPENDED',
    createdAt: '2026-08-02T09:00:00.000Z',
  },
]

function platformRoutes(overrides: Record<string, unknown> = {}) {
  return {
    ...sessionRoutes(OPERATOR),
    'GET /api/v1/platform/hospitals': { data: TENANTS },
    'POST /api/v1/platform/hospitals/507f1f77bcf86cd7994390a1/approve': {
      data: { hospitalId: '507f1f77bcf86cd7994390a1', status: 'APPROVED' },
    },
    ...overrides,
  }
}

describe('SuperAdminDashboard', () => {
  it('renders an announced loading state before data arrives', async () => {
    // The tenant list is held open so the pending state is genuinely observable rather
    // than racing past between render and assertion.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const tenantResponse = new Response(
      JSON.stringify({
        success: true,
        data: TENANTS,
        meta: { requestId: 'r' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

    const refresh = new Response(
      JSON.stringify({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'No active session', requestId: 'r' },
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('/auth/refresh')) return refresh.clone()
        await gate
        return tenantResponse.clone()
      }),
    )

    renderApp(<SuperAdminDashboard />, { route: '/platform' })

    // The table region is exposed with its caption even while loading.
    const region = await screen.findByRole('region', {
      name: /hospitals registered on the platform/i,
    })
    expect(region).toHaveAttribute('aria-busy', 'true')

    // And the skeleton announces that something is coming.
    expect(document.body).toHaveTextContent('Loading Hospitals registered on the platform')

    // No tenant is shown before the data arrives — the screen never invents rows.
    expect(screen.queryByText('Aarav Memorial Hospital')).not.toBeInTheDocument()

    release?.()

    expect(await screen.findByText('Aarav Memorial Hospital')).toBeInTheDocument()
  })

  it('lists real tenants from the API and counts them', async () => {
    mockApi(platformRoutes())
    renderApp(<SuperAdminDashboard />, { route: '/platform' })

    expect(await screen.findByText('Aarav Memorial Hospital')).toBeInTheDocument()

    // Tiles are counted from the response, not invented. The stat label also appears in
    // the sidebar, so the tile is located by its position in the stats row.
    const stats = screen.getAllByText('Hospitals').at(-1)?.closest('div')?.parentElement
    expect(stats).toHaveTextContent('3')

    expect(screen.getByText('Bhavna Community Hospital')).toBeInTheDocument()
    expect(screen.getByText('Charak Diagnostics Centre')).toBeInTheDocument()
  })

  it('shows a status badge for each tenant', async () => {
    mockApi(platformRoutes())
    renderApp(<SuperAdminDashboard />, { route: '/platform' })

    await screen.findByText('Aarav Memorial Hospital')

    // "Pending approval" also appears as the stat tile's hint text.
    expect(screen.getAllByText('Pending approval').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Approved').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Suspended').length).toBeGreaterThan(0)
  })

  it('filters the list as the operator types', async () => {
    const user = userEvent.setup()
    mockApi(platformRoutes())
    renderApp(<SuperAdminDashboard />, { route: '/platform' })

    await screen.findByText('Aarav Memorial Hospital')
    await user.type(screen.getByLabelText('Search hospitals'), 'bhavna')

    await waitFor(() => {
      expect(screen.queryByText('Aarav Memorial Hospital')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Bhavna Community Hospital')).toBeInTheDocument()
  })

  it('offers a way back from an empty search', async () => {
    const user = userEvent.setup()
    mockApi(platformRoutes())
    renderApp(<SuperAdminDashboard />, { route: '/platform' })

    await screen.findByText('Aarav Memorial Hospital')
    await user.type(screen.getByLabelText('Search hospitals'), 'zzzzz-nothing')

    expect(await screen.findByText('No hospitals match your search')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /show all hospitals/i }))
    expect(await screen.findByText('Aarav Memorial Hospital')).toBeInTheDocument()
  })

  it('shows an empty state when the platform has no tenants', async () => {
    mockApi(platformRoutes({ 'GET /api/v1/platform/hospitals': { data: [] } }))
    renderApp(<SuperAdminDashboard />, { route: '/platform' })

    expect(await screen.findByText('No hospitals registered yet')).toBeInTheDocument()
  })

  it('shows a retryable error state, never a blank table', async () => {
    mockApi(
      platformRoutes({
        'GET /api/v1/platform/hospitals': {
          status: 500,
          error: { code: 'INTERNAL_ERROR', message: 'The tenant list is unavailable.' },
        },
      }),
    )
    renderApp(<SuperAdminDashboard />, { route: '/platform' })

    expect(await screen.findByText('Could not load hospitals')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('confirms before approving and reports the result', async () => {
    const user = userEvent.setup()
    const api = mockApi(platformRoutes())
    renderApp(<SuperAdminDashboard />, { route: '/platform' })

    await screen.findByText('Aarav Memorial Hospital')

    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    // Nothing has happened yet — a confirmation is required.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('Approve this hospital?')
    expect(api.requests.some((r) => r.method === 'POST' && r.url.includes('/approve'))).toBe(false)

    await user.click(within(dialog).getByRole('button', { name: 'Approve hospital' }))

    await waitFor(() => {
      expect(api.requests.some((r) => r.method === 'POST' && r.url.includes('/approve'))).toBe(true)
    })

    expect(await screen.findByText(/was approved/i)).toBeInTheDocument()
  })

  it('cancelling the confirmation performs no action', async () => {
    const user = userEvent.setup()
    const api = mockApi(platformRoutes())
    renderApp(<SuperAdminDashboard />, { route: '/platform' })

    await screen.findByText('Aarav Memorial Hospital')
    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(api.requests.some((r) => r.method === 'POST' && r.url.includes('/approve'))).toBe(false)
  })

  it('states that a platform operator has no clinical access', async () => {
    mockApi(platformRoutes())
    renderApp(<SuperAdminDashboard />, { route: '/platform' })

    expect(await screen.findByText(/cannot read patient records/i)).toBeInTheDocument()
  })

  it('has no serious accessibility violations', async () => {
    mockApi(platformRoutes())
    const { container } = renderApp(<SuperAdminDashboard />, { route: '/platform' })

    await screen.findByText('Aarav Memorial Hospital')
    await expectNoSeriousViolations(container)
  })
})

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
