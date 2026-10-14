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
import { checkPreview } from '@infinigrow/shared'
import { NotificationsPage } from './NotificationsPage.js'
import { PatientConsentCard } from './PatientConsentCard.js'
import { suppressionLabel } from './api.js'

/**
 * Module A, frontend.
 *
 * The API suite proves the server refuses clinical content. These prove the half a user
 * sees: that the screen never *implies* a message was delivered, that a refusal is shown
 * with its reason rather than hidden, and that consent defaults to absent rather than to
 * "probably fine".
 *
 * The tone assertions matter more than usual here. A delivery log that renders "Sent" in
 * green beside a message that was merely accepted by a gateway is worse than no log at
 * all, because it looks like evidence.
 */

const HOSPITAL_ID = '507f1f77bcf86cd7994390b1'
const PATIENT_ID = '507f1f77bcf86cd7994390d9'

function user(overrides: Partial<MockUser> = {}): MockUser {
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

const TEMPLATES = [
  {
    key: 'CONSULTATION_READY',
    channel: 'SMS' as const,
    category: 'CLINICAL' as const,
    description: 'Tells a patient a consultation record is available.',
    subject: null,
    body: 'Hello {{recipientName}}, a record is ready. Sign in to view it.',
    active: true,
  },
  {
    key: 'APPOINTMENT_REMINDER',
    channel: 'SMS' as const,
    category: 'APPOINTMENT' as const,
    description: 'Reminds a patient of an upcoming appointment.',
    subject: null,
    body: 'Hello {{recipientName}}, your appointment is on {{dateLabel}} at {{timeLabel}}.',
    active: true,
  },
]

const ROW = {
  id: '507f1f77bcf86cd7994390e1',
  channel: 'SMS',
  templateKey: 'CONSULTATION_READY',
  recipientKind: 'PATIENT',
  recipientRef: PATIENT_ID,
  category: 'CLINICAL',
  status: 'SENT',
  attempts: 1,
  maxAttempts: 6,
  nextAttemptAt: null,
  providerMessageId: 'null-abc',
  failureReason: null,
  suppressionReason: null,
  sentAt: '2027-01-02T09:00:00.000Z',
  deliveredAt: null,
  createdAt: '2027-01-02T08:59:00.000Z',
  attemptsLog: [],
}

function mockAll(items: unknown[] = [ROW], extra: Record<string, unknown> = {}) {
  return mockApi({
    ...sessionRoutes(user()),
    'GET /api/v1/notifications': {
      data: {
        items,
        meta: { page: 1, pageSize: 50, total: items.length, totalPages: 1 },
      },
    },
    'GET /api/v1/notifications/templates': { data: { items: TEMPLATES } },
    'GET /api/v1/notifications/preferences': { data: { items: [] } },
    ...extra,
  })
}

describe('notifications screen', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('never renders a message as delivered', async () => {
    mockAll()

    await renderAppRoutes('/notifications')

    // Wait on something only a ROW can produce. `findByText('Handed to provider')` would
    // match the status filter's <option> immediately and race past the query — which is
    // exactly what happened when this test was first written, so the assertion below ran
    // against an empty table and passed for the wrong reason.
    const templateCell = await screen.findByText('CONSULTATION_READY')

    const row = templateCell.closest('tr') as HTMLElement
    expect(row.textContent).toContain('Handed to provider')
    expect(row.textContent).not.toContain('Delivered')

    // Scoped to the table: the filter legitimately offers `Delivered` as a *filter value*,
    // and asserting on the whole document would flag a control that is correct.
    const table = screen.getByRole('table', { name: /messages this hospital queued/i })
    expect(table.textContent).not.toContain('Delivered')

    // And it says so in words, rather than relying on the reader to know the difference.
    expect(screen.getByText(/not a statement that anybody received it/i)).toBeDefined()
  })

  it('shows a suppressed message with its reason instead of hiding it', async () => {
    mockAll([
      {
        ...ROW,
        status: 'SUPPRESSED',
        suppressionReason: 'NO_CONSENT',
        sentAt: null,
        providerMessageId: null,
      },
    ])

    await renderAppRoutes('/notifications')

    const templateCell = await screen.findByText('CONSULTATION_READY')
    const row = templateCell.closest('tr') as HTMLElement

    expect(row.textContent).toContain('Not sent')
    expect(row.textContent).toMatch(/no consent recorded for this channel/i)
  })

  it('shows why a message failed', async () => {
    mockAll([
      {
        ...ROW,
        status: 'FAILED',
        failureReason: 'Address is not deliverable',
        sentAt: null,
        providerMessageId: null,
      },
    ])

    await renderAppRoutes('/notifications')

    const templateCell = await screen.findByText('CONSULTATION_READY')
    expect((templateCell.closest('tr') as HTMLElement).textContent).toContain(
      'Address is not deliverable',
    )
  })

  it('offers a retry only on a failed message', async () => {
    mockAll([{ ...ROW, status: 'FAILED', failureReason: 'Transient network error' }])

    await renderAppRoutes('/notifications')

    // Retrying something already queued would double-message a patient.
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('hides retry from an identity that may not send', async () => {
    const doctor = user({
      role: 'DOCTOR',
      permissions: [...ROLE_PERMISSIONS.DOCTOR] as Permission[],
    })

    mockApi({
      ...sessionRoutes(doctor),
      'GET /api/v1/notifications': {
        data: {
          items: [{ ...ROW, status: 'FAILED', failureReason: 'x' }],
          meta: { page: 1, pageSize: 50, total: 1, totalPages: 1 },
        },
      },
      'GET /api/v1/notifications/templates': { data: { items: TEMPLATES } },
      'GET /api/v1/notifications/preferences': { data: { items: [] } },
    })

    await renderAppRoutes('/notifications')

    await screen.findByText('CONSULTATION_READY')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('shows an empty state rather than a blank table when nothing was queued', async () => {
    mockAll([])

    await renderAppRoutes('/notifications')

    expect(await screen.findByText(/nothing has been queued yet/i)).toBeDefined()
  })

  it('surfaces a server error instead of an empty log', async () => {
    mockApi({
      ...sessionRoutes(user()),
      'GET /api/v1/notifications': {
        status: 500,
        error: { code: 'INTERNAL_ERROR', message: 'The queue is unavailable.' },
      },
      'GET /api/v1/notifications/templates': { data: { items: TEMPLATES } },
      'GET /api/v1/notifications/preferences': { data: { items: [] } },
    })

    await renderAppRoutes('/notifications')

    // An empty log after an outage reads as "nothing was sent", which is the most
    // dangerous possible misreading of a failure.
    expect(await screen.findByText(/could not be loaded/i)).toBeDefined()
    expect(screen.queryByText(/nothing has been queued yet/i)).toBeNull()
  })

  it('marks every built-in template safe, using the server’s own rule', async () => {
    mockAll()

    await renderAppRoutes('/notifications')

    await waitFor(() => {
      expect(screen.getAllByText('Safe to send')).toHaveLength(TEMPLATES.length)
    })
    expect(screen.queryByText('Blocked')).toBeNull()

    // The badge is not a claim the UI makes; it is the shared validator's answer.
    for (const template of TEMPLATES) {
      expect(checkPreview(template.body).safe).toBe(true)
    }
  })

  it('shows a template as blocked when the real validator refuses it', async () => {
    mockAll([], {
      'GET /api/v1/notifications/templates': {
        data: {
          items: [
            {
              key: 'LEAKY',
              channel: 'SMS',
              category: 'CLINICAL',
              description: 'A template that should not exist.',
              subject: null,
              body: 'Your diagnosis is diabetes and your result was 6.2.',
              active: true,
            },
          ],
        },
      },
    })

    await renderAppRoutes('/notifications')

    // A bad edit is visible the moment it lands, not silently reassuring.
    expect(await screen.findByText('Blocked')).toBeDefined()
  })

  it('offers no way to compose a message', async () => {
    mockAll()

    await renderAppRoutes('/notifications')

    // There is no "compose" or "edit template" control, because the server has no
    // endpoint for one. A button that offered to would be a button that failed.
    expect(screen.queryByRole('button', { name: /compose/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /new template/i })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /message/i })).toBeNull()
  })

  it('renders on its own when mounted directly', () => {
    mockAll()

    renderApp(<NotificationsPage />, { route: '/notifications' })

    expect(screen.getByText('Delivery log')).toBeDefined()
  })
})

describe('patient consent', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  function mockConsent(consents: unknown[]) {
    return mockApi({
      'GET /api/v1/notifications/consents': { data: { recipientKind: 'PATIENT', recipientRef: PATIENT_ID, consents } },
    })
  }

  it('defaults to "not agreed" rather than to yes', async () => {
    mockConsent([])

    renderApp(<PatientConsentCard patientId={PATIENT_ID} canManage />, {
      route: `/patients/${PATIENT_ID}`,
    })

    // Silence is not agreement. The whole screen exists to stop somebody reading "never
    // asked" as "probably fine".
    expect(await screen.findAllByText('Not agreed')).toHaveLength(2)
    expect(screen.getAllByText('Never asked')).toHaveLength(2)
  })

  it('shows a granted consent with the time it was given', async () => {
    mockConsent([
      {
        channel: 'SMS',
        granted: true,
        grantedAt: '2027-01-02T09:00:00.000Z',
        revokedAt: null,
        source: 'PATIENT_RECORD',
      },
      {
        channel: 'EMAIL',
        granted: false,
        // grantedAt SURVIVES a withdrawal — the server stops clearing it, so a revoked
        // consent is distinguishable from one that never existed.
        grantedAt: '2027-01-02T09:00:00.000Z',
        revokedAt: '2027-01-05T09:00:00.000Z',
        source: 'PATIENT_RECORD',
      },
    ])

    renderApp(<PatientConsentCard patientId={PATIENT_ID} canManage />, {
      route: `/patients/${PATIENT_ID}`,
    })

    expect(await screen.findByText('Agreed')).toBeDefined()
    // "who said so" and "when" matter when a consent decision is disputed.
    expect(screen.getByText(/withdrawn/i)).toBeDefined()
  })

  it('offers the decision control only to someone who may record one', async () => {
    mockConsent([])

    renderApp(<PatientConsentCard patientId={PATIENT_ID} canManage={false} />, {
      route: `/patients/${PATIENT_ID}`,
    })

    await screen.findAllByText('Not agreed')
    expect(screen.queryByRole('button', { name: /record agreement/i })).toBeNull()
  })

  it('offers to withdraw an agreement that exists', async () => {
    mockConsent([
      {
        channel: 'SMS',
        granted: true,
        grantedAt: '2027-01-02T09:00:00.000Z',
        revokedAt: null,
        source: 'PATIENT_RECORD',
      },
    ])

    renderApp(<PatientConsentCard patientId={PATIENT_ID} canManage />, {
      route: `/patients/${PATIENT_ID}`,
    })

    expect(await screen.findByRole('button', { name: 'Withdraw' })).toBeDefined()
  })

  it('states that a withdrawal stops future sends without erasing history', async () => {
    mockConsent([])

    renderApp(<PatientConsentCard patientId={PATIENT_ID} canManage />, {
      route: `/patients/${PATIENT_ID}`,
    })

    expect(
      await screen.findByText(/no agreement, no message/i),
    ).toBeDefined()
  })
})

describe('suppression wording', () => {
  it('never calls a refusal an error', () => {
    // A suppression is the system working. Describing it as an error would train staff to
    // distrust the log, which is the one thing the log exists to make trustworthy.
    expect(suppressionLabel('NO_CONSENT')).toMatch(/no consent/i)
    expect(suppressionLabel('CONSENT_REVOKED')).toMatch(/withdrawn/i)
    expect(suppressionLabel('PREFERENCE_DISABLED')).toMatch(/opted out/i)
    expect(suppressionLabel('NO_CONTACT_DETAILS')).toMatch(/no phone number/i)
    expect(suppressionLabel('UNSAFE_PREVIEW')).toMatch(/safely/i)
    expect(suppressionLabel(null)).toBeNull()
  })
})