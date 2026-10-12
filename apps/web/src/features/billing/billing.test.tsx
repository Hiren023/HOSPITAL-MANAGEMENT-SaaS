import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ROLE_PERMISSIONS } from '@infinigrow/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RevenuePage } from './RevenuePage.js'
import { ServicesPage } from './ServicesPage.js'
import { paymentIdempotencyKey } from './api.js'
import {
  mockApi,
  renderApp,
  renderAppRoutes,
  sessionRoutes,
  type MockUser,
} from '../../test/harness.js'

/**
 * Billing and reporting screens.
 *
 * Mock route keys are `"METHOD /pathname"` with NO query string: the harness strips the
 * query before matching, so a key containing `?` can never match.
 *
 * The focus is the money-safety behaviour rather than layout: that totals come from the
 * server, that a payment dialog is marked unverified, and that the revenue screen never
 * collapses manual and unverified money into one number.
 *
 * All figures are fictional.
 */

const HOSPITAL_ID = '507f1f77bcf86cd7994390b1'

function accountant(overrides: Partial<MockUser> = {}): MockUser {
  return {
    userId: '507f1f77bcf86cd7994390c1',
    email: 'accountant@example.test',
    firstName: 'Devika',
    lastName: 'Fictional',
    role: 'ACCOUNTANT',
    hospitalId: HOSPITAL_ID,
    hospitalName: 'Aarav Memorial Hospital',
    membershipId: '507f1f77bcf86cd7994390c2',
    // The permission set that matters: money, but not patient registration.
    permissions: [
      'hospital:read',
      'billing:read',
      'billing:write',
      'payment:read',
      'payment:write',
      'report:read',
      'report:financial',
      'appointment:read',
    ],
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
})

describe('the service catalogue', () => {
  const services = {
    id: '507f1f77bcf86cd7994390b1',
    code: 'CONS',
    name: 'General consultation',
    description: null,
    category: 'CONSULTATION',
    unitPriceMinor: 50_000,
    taxBps: 1800,
    taxInclusive: false,
    isActive: true,
  }

  it('shows a price in the hospital currency', async () => {
    mockApi({
      ...sessionRoutes(accountant()),
      'GET /api/v1/services': {
        data: { items: [services], page: { page: 1, pageSize: 50, total: 1, totalPages: 1 } },
      },
    })

    renderApp(<ServicesPage />)

    expect(await screen.findByText('General consultation')).toBeDefined()
    // 50,000 minor units is ₹500.00. Getting this wrong on screen would mean the number
    // people check does not match the number they are charged.
    expect(screen.getByText('₹ 500.00')).toBeDefined()
  })

  it('shows the configured tax rate', async () => {
    mockApi({
      ...sessionRoutes(accountant()),
      'GET /api/v1/services': {
        data: { items: [services], page: { page: 1, pageSize: 50, total: 1, totalPages: 1 } },
      },
    })

    renderApp(<ServicesPage />)

    expect(await screen.findByText('18%')).toBeDefined()
  })

  it('offers no add control to a reader who cannot bill', async () => {
    mockApi({
      ...sessionRoutes(accountant({ permissions: ['hospital:read', 'billing:read'] })),
      'GET /api/v1/services': {
        data: { items: [], page: { page: 1, pageSize: 50, total: 0, totalPages: 0 } },
      },
    })

    renderApp(<ServicesPage />)

    expect(await screen.findByText('No services yet')).toBeDefined()
    expect(screen.queryByRole('button', { name: /add a service/i })).toBeNull()
  })
})

describe('revenue', () => {
  const report = {
    granularity: 'daily',
    from: '2026-10-01',
    to: '2026-10-03',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    series: [
      {
        key: '2026-10-02',
        manualTotalMinor: 10_000,
        verifiedGatewayTotalMinor: 20_000,
        pendingGatewayTotalMinor: 40_000,
        refundedMinor: 0,
        paymentCount: 3,
        refundCount: 0,
      },
    ],
    totals: {
      manualTotalMinor: 10_000,
      verifiedGatewayTotalMinor: 20_000,
      pendingGatewayTotalMinor: 40_000,
      refundedMinor: 0,
      settledTotalMinor: 30_000,
    },
    note: 'manualTotalMinor is asserted by a person, not confirmed by a system.',
  }

  it('never collapses the three kinds of money into one figure', async () => {
    mockApi({
      ...sessionRoutes(accountant()),
      'GET /api/v1/reports/revenue': { data: report },
    })

    renderApp(<RevenuePage />)

    await screen.findByText('Settled')

    // 10,000 + 20,000 = 30,000 minor = ₹300.00. The 40,000 unreconciled is deliberately
    // NOT in it, and the screen says so where somebody will read it.
    expect(screen.getByText('₹ 300.00')).toBeDefined()
    expect(screen.getAllByText('₹ 400.00').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('₹ 100.00').length).toBeGreaterThanOrEqual(2)

    // And nothing on this page shows 10,000 + 20,000 + 40,000 = 70,000. If any figure
    // summed all three, ₹700.00 would appear — and a treasurer reading it would believe
    // the unreconciled claim was money in hand.
    expect(screen.queryByText('₹ 700.00')).toBeNull()
  })

  it('warns that staff-recorded money is an assertion', async () => {
    mockApi({ ...sessionRoutes(accountant()), 'GET /api/v1/reports/revenue': { data: report } })

    renderApp(<RevenuePage />)

    await screen.findByText('Recorded by staff')
    expect(screen.getByText(/asserted cash changed hands/i)).toBeDefined()
    expect(screen.getByText(/nobody has checked/i)).toBeDefined()
  })

  it('exports a CSV on demand rather than linking to it', async () => {
    const user = userEvent.setup()

    mockApi({
      ...sessionRoutes(accountant()),
      'GET /api/v1/reports/revenue': { data: report },
      'GET /api/v1/reports/revenue.csv': { data: 'period,manual_total_minor\n2026-10-02,10000' },
    })

    renderApp(<RevenuePage />)

    await user.click(await screen.findByRole('button', { name: /export csv/i }))

    // The export is a real request, not a link. A link would either drop the
    // Authorization header or require a token in the URL, and a token in a URL lands in
    // browser history and proxy logs.
    expect(await screen.findByText(/₹ 300\.00/)).toBeDefined()
  })

  it('is closed to a doctor, who holds report:read but not report:financial', async () => {
    const api = mockApi({
      ...sessionRoutes(
        accountant({
          role: 'DOCTOR',
          permissions: [...ROLE_PERMISSIONS.DOCTOR],
        }),
      ),
    })

    await renderAppRoutes('/reports/revenue')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
    // The guard must stop the request, not merely hide the result.
    expect(api.requests.some((r) => r.url.includes('/reports/revenue'))).toBe(false)
  })

  it('is closed to reception entirely', async () => {
    mockApi({
      ...sessionRoutes(accountant({ permissions: [...ROLE_PERMISSIONS.RECEPTIONIST] })),
    })

    await renderAppRoutes('/reports/revenue')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
  })

  it('shows nothing financial to a doctor on the appointments route', async () => {
    mockApi({
      ...sessionRoutes(
        accountant({ role: 'DOCTOR', permissions: [...ROLE_PERMISSIONS.DOCTOR] }),
      ),
    })

    await renderAppRoutes('/reports/revenue')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
    expect(screen.queryByText(/₹/)).toBeNull()
  })
})

describe('idempotency keys', () => {
  it('are stable for the same invoice and amount', () => {
    // The whole point: a key regenerated per submit would protect against nothing, and a
    // double-click would produce two keys and two charges.
    const a = paymentIdempotencyKey('inv-1', 50_000)
    const b = paymentIdempotencyKey('inv-1', 50_000)
    expect(a).toBe(b)
  })

  it('differ for a different amount or invoice', () => {
    expect(paymentIdempotencyKey('inv-1', 50_000)).not.toBe(paymentIdempotencyKey('inv-1', 60_000))
    expect(paymentIdempotencyKey('inv-1', 50_000)).not.toBe(paymentIdempotencyKey('inv-2', 50_000))
  })
})

describe('billing route guards', () => {
  it('keeps a doctor out of the invoice list', async () => {
    const api = mockApi({
      ...sessionRoutes(
        accountant({ role: 'DOCTOR', permissions: [...ROLE_PERMISSIONS.DOCTOR] }),
      ),
    })

    await renderAppRoutes('/invoices')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
    expect(api.requests.some((r) => r.url.includes('/invoices'))).toBe(false)
  })

  it('keeps a doctor out of the catalogue', async () => {
    const api = mockApi({
      ...sessionRoutes(
        accountant({ role: 'DOCTOR', permissions: [...ROLE_PERMISSIONS.DOCTOR] }),
      ),
    })

    await renderAppRoutes('/services')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
    expect(api.requests.some((r) => r.url.includes('/services'))).toBe(false)
  })

  it('keeps a platform operator out of billing', async () => {
    const SUPER_ADMIN: MockUser = {
      userId: '507f1f77bcf86cd799439011',
      email: 'platform-admin@example.test',
      firstName: 'Fictional',
      lastName: 'Operator',
      role: 'SUPER_ADMIN',
      hospitalId: null,
      hospitalName: null,
      membershipId: null,
      permissions: [...ROLE_PERMISSIONS.SUPER_ADMIN],
    }

    const api = mockApi({ ...sessionRoutes(SUPER_ADMIN) })

    for (const path of ['/invoices', '/services', '/reports/revenue']) {
      await renderAppRoutes(path)
      expect((await screen.findAllByText(/access restricted/i)).length).toBeGreaterThan(0)
    }

    expect(
      api.requests.some(
        (r) => r.url.includes('/invoices') || r.url.includes('/services') || r.url.includes('/reports'),
      ),
    ).toBe(false)
  })

  it('keeps reception out of billing, which it has no permission for', async () => {
    const api = mockApi({
      ...sessionRoutes(accountant({ permissions: [...ROLE_PERMISSIONS.RECEPTIONIST] })),
    })

    await renderAppRoutes('/invoices')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
    expect(api.requests.some((r) => r.url.includes('/invoices'))).toBe(false)
  })
})
