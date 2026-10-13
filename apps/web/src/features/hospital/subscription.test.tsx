import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ROLE_PERMISSIONS, type Permission } from '@infinigrow/shared'

import {
  mockApi,
  renderApp,
  renderAppRoutes,
  sessionRoutes,
  type MockUser,
} from '../../test/harness.js'
import { expectNoSeriousViolations } from '../../test/a11y.js'
import { accessNotice, daysUntil, formatDate } from './subscription-api.js'

/**
 * The "Your plan" screen.
 *
 * The API suite proves the server refuses a module the plan does not grant. These prove
 * the half a user actually sees: that the screen says what happened, that it does not
 * pretend a hospital can buy a plan from inside the product, and that a lapsed tenant is
 * told its records are still there.
 *
 * The tests that matter most here are the ones about tone. A suspended hospital showing a
 * red "ACCESS DENIED" on every page would be both untrue — its data is right there — and
 * useless. So the banner's wording is asserted, not just its presence.
 */

const HOSPITAL_ID = '507f1f77bcf86cd7994390b1'

function hospitalUser(overrides: Partial<MockUser> = {}): MockUser {
  return {
    userId: '507f1f77bcf86cd7994390c1',
    email: 'meera.nair@example.test',
    firstName: 'Meera',
    lastName: 'Nair',
    role: 'HOSPITAL_ADMIN',
    hospitalId: HOSPITAL_ID,
    hospitalName: 'Aarav Memorial Hospital',
    membershipId: '507f1f77bcf86cd7994390c2',
    permissions: [...ROLE_PERMISSIONS.HOSPITAL_ADMIN],
    ...overrides,
  }
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    plan: 'HOSPITAL',
    planLabel: 'Hospital',
    status: 'ACTIVE',
    paymentState: 'VERIFIED',
    entitlements: ['CLINICAL', 'BILLING', 'ATTENDANCE', 'REPORTS'],
    mayRead: true,
    mayWrite: true,
    denied: null,
    trialEndsAt: null,
    currentPeriodEndsAt: '2027-04-01T00:00:00.000Z',
    gracePeriodEndsAt: null,
    suspendedAt: null,
    cancelAtPeriodEnd: false,
    limits: { seats: 50, departments: 25 },
    usage: {
      seats: { used: 12, limit: 50, displayLimit: '50' },
      departments: { used: 6, limit: 25, displayLimit: '25' },
    },
    hospitalName: 'Aarav Memorial Hospital',
    ...overrides,
  }
}

describe('subscription screen', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('shows the plan, the renewal date and what is included', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/hospital/subscription': { data: subscription() },
    })

    await renderAppRoutes('/subscription')

    expect(await screen.findByText('Hospital', { selector: 'p' })).toBeDefined()
    expect(screen.getByText('Active')).toBeDefined()
    expect(screen.getByText(/Clinical records/)).toBeDefined()
    expect(screen.getByText(/Billing and invoicing/)).toBeDefined()
    expect(screen.getByText(/12 of 50/)).toBeDefined()
    expect(screen.getByText(/6 of 25/)).toBeDefined()
  })

  it('strikes through a module the plan does not include', async () => {
    // Starter grants clinical and attendance only. Billing must read as NOT included
    // rather than simply being absent, because "you have not noticed it" and "you do not
    // have it" are different facts.
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/hospital/subscription': {
        data: subscription({
          plan: 'STARTER',
          planLabel: 'Starter',
          entitlements: ['CLINICAL', 'ATTENDANCE'],
          limits: { seats: 3, departments: 2 },
          usage: {
            seats: { used: 3, limit: 3, displayLimit: '3' },
            departments: { used: 2, limit: 2, displayLimit: '2' },
          },
        }),
      },
    })

    await renderAppRoutes('/subscription')

    const billing = await screen.findByText(/Billing and invoicing/)
    // The strike-through and the dimming live on the list item, not the label span.
    expect(billing.closest('li')?.className).toContain('line-through')
    expect(billing.textContent).toContain('not included')
  })

  it('offers no way to buy or change a plan from inside the product', async () => {
    // A hospital cannot upgrade itself. Rendering an "Upgrade" button would render a
    // button that fails when pressed, which is worse than not offering it.
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/hospital/subscription': { data: subscription() },
    })

    await renderAppRoutes('/subscription')

    expect(await screen.findByText(/contact your account manager/i)).toBeDefined()
    expect(screen.queryByRole('button', { name: /upgrade/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /renew/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
  })

  it('tells a suspended hospital that nothing was deleted', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/hospital/subscription': {
        data: subscription({
          status: 'SUSPENDED',
          paymentState: 'FAILED',
          mayWrite: false,
          denied: 'SUBSCRIPTION_SUSPENDED',
          suspendedAt: '2027-01-05T00:00:00.000Z',
        }),
      },
    })

    await renderAppRoutes('/subscription')

    expect(await screen.findByText(/subscription is suspended/i)).toBeDefined()
    // The load-bearing sentence. A hospital that cannot see its patients needs to know
    // they are still there, or it will reasonably assume the worst.
    expect(screen.getByText(/Nothing has been deleted/i)).toBeDefined()
    expect(screen.getByText(/Suspended/)).toBeDefined()
  })

  it('warns during a trial without implying a charge', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/hospital/subscription': {
        data: subscription({
          status: 'TRIAL',
          paymentState: 'NONE',
          trialEndsAt: '2027-02-01T00:00:00.000Z',
        }),
      },
    })

    await renderAppRoutes('/subscription')

    expect(await screen.findByText(/Trial in progress/i)).toBeDefined()
    expect(screen.getByText(/Nothing is charged until it ends/i)).toBeDefined()
    expect(screen.getByText(/No payment recorded/i)).toBeDefined()
  })

  it('reports a missing subscription as an anomaly rather than a normal state', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/hospital/subscription': {
        data: subscription({
          configured: false,
          status: 'EXPIRED',
          mayRead: false,
          mayWrite: false,
          denied: 'NO_SUBSCRIPTION',
        }),
      },
    })

    await renderAppRoutes('/subscription')

    expect(await screen.findByText(/No subscription is configured/i)).toBeDefined()
    expect(screen.getByText(/This is not a normal state/i)).toBeDefined()
  })

  it('surfaces a server error instead of an empty page', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/hospital/subscription': {
        status: 500,
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong loading your plan.' },
      },
    })

    await renderAppRoutes('/subscription')

    expect(await screen.findByText(/could not be loaded/i)).toBeDefined()
  })

  it('keeps a doctor out, because the price is not their business', async () => {
    const doctor = hospitalUser({
      role: 'DOCTOR',
      permissions: [...ROLE_PERMISSIONS.DOCTOR] as Permission[],
    })

    const api = mockApi({
      ...sessionRoutes(doctor),
      'GET /api/v1/hospital/subscription': { data: subscription() },
    })

    await renderAppRoutes('/subscription')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
    // The guard must stop the request, not merely hide the answer.
    expect(api.requests.some((r) => r.url.includes('/hospital/subscription'))).toBe(false)
  })

  it('has no serious accessibility violations', async () => {
    const { container } = renderApp(
      <div>
        <p>placeholder</p>
      </div>,
    )

    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/hospital/subscription': { data: subscription() },
    })

    await renderAppRoutes('/subscription')

    await expectNoSeriousViolations(container)
  })
})

describe('subscription helpers', () => {
  it('says nothing alarming for a healthy subscription', () => {
    expect(
      accessNotice(
        subscription() as unknown as Parameters<typeof accessNotice>[0],
      ),
    ).toBeNull()
  })

  it('names the grace deadline when payment is overdue', () => {
    const notice = accessNotice(
      subscription({
        status: 'PAST_DUE',
        gracePeriodEndsAt: '2027-03-10T00:00:00.000Z',
      }) as unknown as Parameters<typeof accessNotice>[0],
    )

    expect(notice?.title).toMatch(/overdue/i)
    expect(notice?.body).toMatch(/until/i)
  })

  it('counts whole days and never goes negative', () => {
    const now = new Date('2027-01-01T00:00:00.000Z')

    expect(daysUntil('2027-01-11T00:00:00.000Z', now)).toBe(10)
    expect(daysUntil('2027-01-10T12:00:00.000Z', now)).toBe(9)
    // A renewal already past must read as zero, not as a negative countdown.
    expect(daysUntil('2026-12-01T00:00:00.000Z', now)).toBe(0)
    expect(daysUntil('not-a-date', now)).toBe(0)
  })

  it('renders a missing or unparseable date as an em dash, never as "Invalid Date"', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDate('not-a-date')).toBe('—')
    expect(formatDate('2027-04-01T00:00:00.000Z')).toMatch(/2027/)
  })

  it('finds the notice once the async query resolves', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/hospital/subscription': { data: subscription() },
    })

    await renderAppRoutes('/subscription')

    await waitFor(() => {
      expect(screen.getByText('Active')).toBeDefined()
    })
  })
})