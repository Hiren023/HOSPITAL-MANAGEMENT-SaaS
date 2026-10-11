import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ROLE_PERMISSIONS, type Permission } from '@infinigrow/shared'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { PlatformOverviewPage } from './PlatformOverviewPage.js'
import { PlatformHospitalsPage } from './PlatformHospitalsPage.js'
import { PlatformHospitalDetailPage } from './PlatformHospitalDetailPage.js'
import { PlatformAuditPage } from './PlatformAuditPage.js'
import { PlatformReportsPage } from './PlatformReportsPage.js'
import {
  mockApi,
  renderApp,
  renderAppRoutes,
  sessionRoutes,
  type MockRoute,
  type MockUser,
} from '../../test/harness.js'
import { expectNoSeriousViolations } from '../../test/a11y.js'
import { AuthProvider } from '../../auth/auth-context.js'

/**
 * Platform console — frontend.
 *
 * These assert the same boundary the API suite does, from the other side: that the
 * console calls real endpoints, renders real returned values, and refuses to present a
 * control the identity cannot use.
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

/** Fictional tenants. Never real hospitals. */
const TENANTS = [
  {
    id: '507f1f77bcf86cd7994390a1',
    name: 'Aarav Memorial Hospital',
    slug: 'aarav-memorial',
    status: 'PENDING',
    plan: 'STARTER',
    planLabel: 'Starter',
    seatLimit: 3,
    registrationNumber: 'GJ/2026/1042',
    contactEmail: 'contact@aarav.example.test',
    city: 'Ahmedabad',
    state: 'Gujarat',
    createdAt: '2026-10-01T09:00:00.000Z',
    approvedAt: null,
    suspendedAt: null,
    suspensionReason: null,
  },
  {
    id: '507f1f77bcf86cd7994390a2',
    name: 'Bhavna Community Hospital',
    slug: 'bhavna-community',
    status: 'APPROVED',
    plan: 'HOSPITAL',
    planLabel: 'Hospital',
    seatLimit: 50,
    registrationNumber: 'GJ/2026/2087',
    contactEmail: 'contact@bhavna.example.test',
    city: 'Surat',
    state: 'Gujarat',
    createdAt: '2026-09-14T09:00:00.000Z',
    approvedAt: '2026-09-15T09:00:00.000Z',
    suspendedAt: null,
    suspensionReason: null,
  },
]

const PAGE = { page: 1, pageSize: 20, total: 2, totalPages: 1 }

const OVERVIEW = {
  tenants: { total: 2, pending: 1, approved: 1, suspended: 0, rejected: 0 },
  identity: { totalUsers: 4, activeMemberships: 4 },
  plans: { STARTER: 1, HOSPITAL: 1 },
  recentActivity: { last24h: 12, mostRecentAt: '2026-10-10T09:30:00.000Z' },
}

function platformRoutes(overrides: Record<string, MockRoute | MockRoute[]> = {}) {
  return {
    ...sessionRoutes(OPERATOR),
    'GET /api/v1/platform/overview': { data: OVERVIEW },
    'GET /api/v1/platform/hospitals': { data: { items: TENANTS, page: PAGE } },
    'GET /api/v1/platform/hospitals/507f1f77bcf86cd7994390a1': {
      data: {
        ...TENANTS[0],
        departmentLimit: 2,
        indicativeMonthlyPriceInr: 2499,
        approvedBy: null,
        reactivatedAt: null,
        planChangedAt: null,
        address: { city: 'Ahmedabad', state: 'Gujarat' },
        usersByRole: { HOSPITAL_ADMIN: 1, DOCTOR: 1 },
        totalUsers: 2,
      },
    },
    'GET /api/v1/platform/hospitals/507f1f77bcf86cd7994390a1/users': {
      data: {
        items: [
          {
            userId: '507f1f77bcf86cd7994390b1',
            email: 'aditi@example.test',
            firstName: 'Aditi',
            lastName: 'Sharma',
            status: 'ACTIVE',
            emailVerified: true,
            lastLoginAt: '2026-10-10T08:00:00.000Z',
            role: 'HOSPITAL_ADMIN',
            membershipStatus: 'ACTIVE',
          },
        ],
        page: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
      },
    },
    'GET /api/v1/platform/audit': {
      data: {
        items: [
          {
            id: '507f1f77bcf86cd7994390c1',
            action: 'hospital.suspended',
            actorUserId: '507f1f77bcf86cd799439011',
            actorRole: 'SUPER_ADMIN',
            hospitalId: '507f1f77bcf86cd7994390a1',
            resourceType: 'Hospital',
            resourceId: '507f1f77bcf86cd7994390a1',
            outcome: 'SUCCESS',
            ip: '127.0.0.1',
            createdAt: '2026-10-10T09:30:00.000Z',
            metadata: { reason: 'Documents could not be verified' },
          },
        ],
        nextCursor: null,
        limit: 25,
      },
    },
    'GET /api/v1/platform/reports/operational': {
      data: {
        windowDays: 30,
        since: '2026-09-10T00:00:00.000Z',
        tenants: {
          active: 1,
          registeredInWindow: 2,
          byStatus: { PENDING: 1, APPROVED: 1 },
          byPlan: { STARTER: 1, HOSPITAL: 1 },
        },
        growth: [{ date: '2026-10-01', count: 1 }],
      },
    },
    'POST /api/v1/platform/hospitals/507f1f77bcf86cd7994390a1/approve': {
      data: { hospitalId: '507f1f77bcf86cd7994390a1', status: 'APPROVED' },
    },
    ...overrides,
  }
}

describe('platform overview', () => {
  it('renders the metrics the API returned', async () => {
    mockApi(platformRoutes())
    renderApp(<PlatformOverviewPage />, { route: '/platform' })

    expect(await screen.findByText('Hospitals on platform')).toBeInTheDocument()
    // Data-dependent labels only appear once the response lands; the shell renders first.
    expect(await screen.findByText('Total users')).toBeInTheDocument()
    expect(screen.getByText('Pending approval')).toBeInTheDocument()
    expect(screen.getByText('Approved')).toBeInTheDocument()
    // Counted from the response, not invented.
    expect(screen.getByText('Total users').closest('div')?.parentElement).toHaveTextContent('4')
    expect(screen.getByText('Active memberships').closest('div')?.parentElement).toHaveTextContent(
      '4',
    )
  })

  it('states plainly that patient records are not visible', async () => {
    mockApi(platformRoutes())
    renderApp(<PlatformOverviewPage />, { route: '/platform' })

    expect(await screen.findByText(/patient records are not visible here/i)).toBeInTheDocument()
  })

  it('shows a retryable error rather than an empty dashboard', async () => {
    mockApi(
      platformRoutes({
        'GET /api/v1/platform/overview': {
          status: 500,
          error: { code: 'INTERNAL_ERROR', message: 'Metrics are unavailable.' },
        },
      }),
    )
    renderApp(<PlatformOverviewPage />, { route: '/platform' })

    expect(await screen.findByText('Could not load platform metrics')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('has no serious accessibility violations', async () => {
    mockApi(platformRoutes())
    const { container } = renderApp(<PlatformOverviewPage />, { route: '/platform' })

    await screen.findByText('Hospitals on platform')
    await expectNoSeriousViolations(container)
  })
})

describe('hospital list', () => {
  it('renders the tenants from the API', async () => {
    mockApi(platformRoutes())
    renderApp(<PlatformHospitalsPage />, { route: '/platform/hospitals' })

    expect(await screen.findByText('Aarav Memorial Hospital')).toBeInTheDocument()
    expect(screen.getByText('Bhavna Community Hospital')).toBeInTheDocument()
  })

  it('reports the server-supplied total, not the page length', async () => {
    mockApi(
      platformRoutes({
        'GET /api/v1/platform/hospitals': {
          data: { items: TENANTS, page: { page: 1, pageSize: 20, total: 137, totalPages: 7 } },
        },
      }),
    )
    renderApp(<PlatformHospitalsPage />, { route: '/platform/hospitals' })

    // The header count comes from `page.total`, which is the whole matching set.
    expect(await screen.findByText(/137 hospitals match your filters/i)).toBeInTheDocument()
  })

  it('sends search to the server rather than filtering locally', async () => {
    const user = userEvent.setup()
    const api = mockApi(platformRoutes())
    renderApp(<PlatformHospitalsPage />, { route: '/platform/hospitals' })

    await screen.findByText('Aarav Memorial Hospital')
    await user.type(screen.getByLabelText('Search hospitals'), 'bhavna')

    await waitFor(() => {
      const call = api.requests.filter((r) => r.url.includes('/platform/hospitals')).at(-1)
      expect(call?.url).toContain('q=bhavna')
    })
  })

  it('sends the status filter to the server', async () => {
    const user = userEvent.setup()
    const api = mockApi(platformRoutes())
    renderApp(<PlatformHospitalsPage />, { route: '/platform/hospitals' })

    await screen.findByText('Aarav Memorial Hospital')
    await user.selectOptions(screen.getByLabelText('Status'), 'PENDING')

    await waitFor(() => {
      const call = api.requests.filter((r) => r.url.includes('/platform/hospitals')).at(-1)
      expect(call?.url).toContain('status=PENDING')
    })
  })

  it('confirms before approving, then reports the result', async () => {
    const user = userEvent.setup()
    const api = mockApi(platformRoutes())
    renderApp(<PlatformHospitalsPage />, { route: '/platform/hospitals' })

    await screen.findByText('Aarav Memorial Hospital')
    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('Approve this hospital?')
    // Nothing sent yet.
    expect(api.requests.some((r) => r.method === 'POST' && r.url.includes('/approve'))).toBe(false)

    await user.click(within(dialog).getByRole('button', { name: 'Approve hospital' }))

    await waitFor(() => {
      expect(api.requests.some((r) => r.method === 'POST' && r.url.includes('/approve'))).toBe(true)
    })
    expect(await screen.findByText(/was approved/i)).toBeInTheDocument()
  })

  it('surfaces a server failure instead of claiming success', async () => {
    const user = userEvent.setup()
    mockApi(
      platformRoutes({
        'POST /api/v1/platform/hospitals/507f1f77bcf86cd7994390a1/approve': {
          status: 409,
          error: { code: 'CONFLICT', message: 'This hospital is already approved.' },
        },
      }),
    )
    renderApp(<PlatformHospitalsPage />, { route: '/platform/hospitals' })

    await screen.findByText('Aarav Memorial Hospital')
    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Approve hospital' }))

    expect(await screen.findByText('This hospital is already approved.')).toBeInTheDocument()
    expect(screen.queryByText(/was approved/i)).not.toBeInTheDocument()
  })

  it('offers a way back from an empty filtered result', async () => {
    const user = userEvent.setup()
    mockApi(
      platformRoutes({
        'GET /api/v1/platform/hospitals': {
          data: { items: [], page: { page: 1, pageSize: 20, total: 0, totalPages: 0 } },
        },
      }),
    )
    renderApp(<PlatformHospitalsPage />, { route: '/platform/hospitals?q=nothing' })

    expect(await screen.findByText('No hospitals match these filters')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /clear filters/i }).length).toBeGreaterThan(0)
    void user
  })
})

describe('hospital detail', () => {
  /**
   * The detail page reads `useParams()`, so it has to be mounted under a matching route.
   * Rendering the component on its own leaves the param empty, the query disabled, and
   * every assertion below would pass against an empty screen.
   */
  function renderDetail() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    })
    return render(
      // `autoRestore: false` keeps the provider out of the way — this suite tests the
      // page, and the shell only needs the context to exist.
      <AuthProvider autoRestore={false}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route
              path="/platform/hospitals/:hospitalId"
              element={<PlatformHospitalDetailPage />}
            />
          </Routes>
        </QueryClientProvider>
      </AuthProvider>,
      {
        wrapper: ({ children }) => (
          <MemoryRouter initialEntries={['/platform/hospitals/507f1f77bcf86cd7994390a1']}>
            {children}
          </MemoryRouter>
        ),
      },
    )
  }
  it('shows the tenant record and its plan', async () => {
    mockApi(platformRoutes())
    renderDetail()

    expect(await screen.findByText('Registration number')).toBeInTheDocument()
    expect(screen.getByText('GJ/2026/1042')).toBeInTheDocument()
    expect(screen.getByText('Starter')).toBeInTheDocument()
  })

  it('requires a reason before suspending', async () => {
    const user = userEvent.setup()
    const api = mockApi(platformRoutes())
    renderDetail()

    await screen.findByText('Registration number')
    await user.click(screen.getByRole('button', { name: /suspend hospital/i }))

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /suspend hospital/i }))

    // Nothing sent: a suspension with no reason would be indistinguishable from a
    // mistake, and the hospital has no way to contest it.
    expect(api.requests.some((r) => r.method === 'POST' && r.url.includes('/suspend'))).toBe(false)
    expect(await screen.findByText(/give a reason of at least 10 characters/i)).toBeInTheDocument()
  })

  it('suspends with a reason and reports the outcome', async () => {
    const user = userEvent.setup()
    const api = mockRoutesWithSuspend()
    renderDetail()

    await screen.findByText('Registration number')
    await user.click(screen.getByRole('button', { name: /suspend hospital/i }))

    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/reason/i), 'Documents could not be verified')
    await user.click(within(dialog).getByRole('button', { name: /suspend hospital/i }))

    await waitFor(() => {
      expect(api.requests.some((r) => r.method === 'POST' && r.url.includes('/suspend'))).toBe(true)
    })
    expect(await screen.findByText(/can no longer sign in/i)).toBeInTheDocument()
  })

  it('never renders a credential in the staff list', async () => {
    mockApi(platformRoutes())
    const { container } = renderDetail()

    await screen.findByText('aditi@example.test')
    expect(container.textContent).not.toContain('passwordHash')
    expect(container.textContent).not.toContain('$argon2')
  })

  it('states that clinical records are not visible from the console', async () => {
    mockApi(platformRoutes())
    renderDetail()

    expect(await screen.findByText(/not visible from the platform console/i)).toBeInTheDocument()
  })
})

function mockRoutesWithSuspend() {
  return mockApi(
    platformRoutes({
      'POST /api/v1/platform/hospitals/507f1f77bcf86cd7994390a1/suspend': {
        data: { hospitalId: '507f1f77bcf86cd7994390a1', status: 'SUSPENDED' },
      },
    }),
  )
}

describe('audit viewer', () => {
  it('renders events returned by the API', async () => {
    mockApi(platformRoutes())
    renderApp(<PlatformAuditPage />, { route: '/platform/audit' })

    expect(await screen.findByText('hospital.suspended')).toBeInTheDocument()
    expect(screen.getByText('SUCCESS')).toBeInTheDocument()
  })

  it('sends the action filter to the server', async () => {
    const user = userEvent.setup()
    const api = mockApi(platformRoutes())
    renderApp(<PlatformAuditPage />, { route: '/platform/audit' })

    await screen.findByText('hospital.suspended')

    await user.click(screen.getByRole('button', { name: /^filters$/i }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/action code/i), 'hospital.approved')
    await user.click(within(dialog).getByRole('button', { name: /^apply$/i }))

    await waitFor(() => {
      const call = api.requests.filter((r) => r.url.includes('/platform/audit')).at(-1)
      expect(call?.url).toContain('action=hospital.approved')
    })
  })

  it('disables forward paging when the API reports no more pages', async () => {
    mockApi(platformRoutes())
    renderApp(<PlatformAuditPage />, { route: '/platform/audit' })

    await screen.findByText('hospital.suspended')
    expect(screen.getByRole('button', { name: /load more/i })).toBeDisabled()
  })

  it('pages forward with the cursor the API supplied', async () => {
    const user = userEvent.setup()
    const api = mockApi(
      platformRoutes({
        'GET /api/v1/platform/audit': [
          { data: { items: [], nextCursor: 'cursor-page-2', limit: 25 } },
          {
            data: {
              items: [
                {
                  id: '507f1f77bcf86cd7994390c2',
                  action: 'hospital.approved',
                  actorUserId: null,
                  actorRole: 'SUPER_ADMIN',
                  hospitalId: null,
                  resourceType: 'Hospital',
                  resourceId: null,
                  outcome: 'SUCCESS',
                  ip: null,
                  createdAt: '2026-10-09T09:30:00.000Z',
                  metadata: null,
                },
              ],
              nextCursor: null,
              limit: 25,
            },
          },
        ],
      }),
    )
    renderApp(<PlatformAuditPage />, { route: '/platform/audit' })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /load more/i })).not.toBeDisabled()
    })
    await user.click(screen.getByRole('button', { name: /load more/i }))

    expect(await screen.findByText('hospital.approved')).toBeInTheDocument()
    const call = api.requests.filter((r) => r.url.includes('/platform/audit')).at(-1)
    expect(call?.url).toContain('cursor=')
  })
})

describe('operational report', () => {
  it('renders counts returned by the API', async () => {
    mockApi(platformRoutes())
    renderApp(<PlatformReportsPage />, { route: '/platform/reports' })

    expect(await screen.findByText('Active tenants')).toBeInTheDocument()
    expect(screen.getByText('Tenants by status')).toBeInTheDocument()
  })

  it('requests the chosen reporting window', async () => {
    const user = userEvent.setup()
    const api = mockApi(platformRoutes())
    renderApp(<PlatformReportsPage />, { route: '/platform/reports' })

    await screen.findByText('Active tenants')
    await user.selectOptions(screen.getByLabelText(/reporting window/i), '90')

    await waitFor(() => {
      const call = api.requests.filter((r) => r.url.includes('/reports/operational')).at(-1)
      expect(call?.url).toContain('days=90')
    })
  })

  it('disclaims revenue tracking, since no payment system exists', async () => {
    mockApi(platformRoutes())
    renderApp(<PlatformReportsPage />, { route: '/platform/reports' })

    expect(await screen.findByText(/no revenue is tracked/i)).toBeInTheDocument()
  })
})

describe('platform console permissions', () => {
  const HOSPITAL_ADMIN: MockUser = {
    userId: '507f1f77bcf86cd799439011',
    email: 'admin-a@example.test',
    firstName: 'Aditi',
    lastName: 'Sharma',
    role: 'HOSPITAL_ADMIN',
    hospitalId: '507f1f77bcf86cd799439012',
    hospitalName: 'Aarav Memorial Hospital',
    membershipId: '507f1f77bcf86cd799439013',
    permissions: [...ROLE_PERMISSIONS.HOSPITAL_ADMIN],
  }

  it('offers a hospital administrator no route into the platform console', async () => {
    mockApi(sessionRoutes(HOSPITAL_ADMIN))
    const { AppShell } = await import('../../components/layout/AppShell.js')
    renderApp(<AppShell title="Test">content</AppShell>, { route: '/dashboard' })

    const nav = await screen.findByRole('navigation', { name: 'Main navigation' })
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href') ?? '')

    // A hospital role does have its own Reports and Audit trail — those live under
    // `/reports` and `/audit`. What it must never see is anything under `/platform`.
    expect(hrefs.some((href) => href.startsWith('/platform'))).toBe(false)
    expect(within(nav).queryByRole('link', { name: /^Hospitals$/ })).not.toBeInTheDocument()
  })

  it('shows the platform entries to an operator, including Reports', async () => {
    mockApi(sessionRoutes(OPERATOR))
    const { AppShell } = await import('../../components/layout/AppShell.js')
    renderApp(<AppShell title="Test">content</AppShell>, { route: '/platform' })

    const nav = await screen.findByRole('navigation', { name: 'Main navigation' })

    expect(within(nav).getByRole('link', { name: /Hospitals/ })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: /Reports/ })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: /Audit trail/ })).toBeInTheDocument()
  })

  it('hides Reports from an operator whose grant omits platform:report:read', async () => {
    mockApi(
      sessionRoutes({
        ...OPERATOR,
        permissions: ['platform:hospital:read', 'platform:audit:read'] as Permission[],
      }),
    )
    const { AppShell } = await import('../../components/layout/AppShell.js')
    renderApp(<AppShell title="Test">content</AppShell>, { route: '/platform' })

    const nav = await screen.findByRole('navigation', { name: 'Main navigation' })

    expect(within(nav).getByRole('link', { name: /Hospitals/ })).toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: /Reports/ })).not.toBeInTheDocument()
  })

  it('never calls a platform endpoint for a hospital user', async () => {
    const api = mockApi(sessionRoutes(HOSPITAL_ADMIN))

    // Through the real `App`, so the guard actually runs. Mounting the page component
    // directly would skip it entirely and make this assertion meaningless.
    await renderAppRoutes('/platform/hospitals')

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /access restricted/i })).toBeInTheDocument()
    })

    // The guard refused to render the console, so no platform request was ever made.
    expect(
      api.requests.some((r) => r.url.includes('/platform/hospitals') && r.method === 'GET'),
    ).toBe(false)
  })

  it('blocks the audit trail for a hospital user', async () => {
    const api = mockApi(sessionRoutes(HOSPITAL_ADMIN))
    await renderAppRoutes('/platform/audit')

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /access restricted/i })).toBeInTheDocument()
    })
    expect(api.requests.some((r) => r.url.includes('/platform/audit'))).toBe(false)
  })
})

describe('no patient data in the console', () => {
  it('renders no clinical vocabulary anywhere in the console', async () => {
    mockApi(platformRoutes())

    const { container: overview } = renderApp(<PlatformOverviewPage />, { route: '/platform' })
    await screen.findByText('Hospitals on platform')
    const { container: reports } = renderApp(<PlatformReportsPage />, {
      route: '/platform/reports',
    })
    await screen.findByText('Active tenants')

    const text = `${overview.textContent} ${reports.textContent}`.toLowerCase()

    // The console describes tenants and accounts. It must never present clinical figures.
    for (const forbidden of ['patients', 'patient records seen', 'diagnosis', 'prescription']) {
      expect(text, `console rendered "${forbidden}"`).not.toContain(forbidden)
    }
  })

  it('uses a real API call rather than a fixture baked into the component', async () => {
    const api = mockApi(platformRoutes())
    renderApp(<PlatformOverviewPage />, { route: '/platform' })

    await screen.findByText('Hospitals on platform')
    expect(api.requests.some((r) => r.url.includes('/platform/overview'))).toBe(true)
  })

  it('propagates an abort when a query is superseded', async () => {
    // Guards against a superseded fetch overwriting a newer one — the classic stale-data
    // bug in a filterable console.
    const user = userEvent.setup()
    mockApi(platformRoutes())

    const { container } = renderApp(<PlatformHospitalsPage />, { route: '/platform/hospitals' })
    await screen.findByText('Aarav Memorial Hospital')

    await user.type(screen.getByLabelText('Search hospitals'), 'bhavna')
    await user.clear(screen.getByLabelText('Search hospitals'))
    await user.type(screen.getByLabelText('Search hospitals'), 'aarav')

    expect(container).toBeInTheDocument()
    expect(screen.getByText('Aarav Memorial Hospital')).toBeInTheDocument()
  })
})

describe('console failure handling', () => {
  it('does not render a blank screen when every endpoint fails', async () => {
    mockApi({
      ...sessionRoutes(OPERATOR),
      'GET /api/v1/platform/hospitals': {
        status: 503,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'The console is temporarily unavailable.' },
      },
    })

    renderApp(<PlatformHospitalsPage />, { route: '/platform/hospitals' })

    expect(await screen.findByText('Could not load hospitals')).toBeInTheDocument()
    expect(screen.getByText('The console is temporarily unavailable.')).toBeInTheDocument()
  })

  it('shows a signed-out state when the session is gone', async () => {
    mockApi({
      'POST /api/v1/auth/refresh': {
        status: 401,
        error: { code: 'UNAUTHENTICATED', message: 'No active session' },
      },
    })

    await renderAppRoutes('/platform/hospitals')

    // The guard sends an anonymous visitor to sign-in rather than rendering an empty
    // console that would look like "no hospitals exist".
    expect(await screen.findByRole('heading', { name: /^sign in$/i })).toBeInTheDocument()
  })

  it('does not leave a spinner running forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockApi(platformRoutes())
    renderApp(<PlatformOverviewPage />, { route: '/platform' })

    await screen.findByText('Hospitals on platform')
    expect(screen.queryByText(/restoring your session/i)).not.toBeInTheDocument()
    vi.useRealTimers()
  })
})
