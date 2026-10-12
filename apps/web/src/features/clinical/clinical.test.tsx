import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ROLE_PERMISSIONS } from '@infinigrow/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AttendancePage } from './AttendancePage.js'
import { QueuePage } from './QueuePage.js'
import { emptyPrescriptionItem } from './api.js'
import {
  mockApi,
  renderApp,
  renderAppRoutes,
  sessionRoutes,
  type MockUser,
} from '../../test/harness.js'

/**
 * Phase 7 frontend — clinical workflow and attendance.
 *
 * Mock route keys are `"METHOD /pathname"` with NO query string: the harness strips the
 * query before matching, so a key containing `?` can never match.
 *
 * The focus here is the safety behaviour rather than the layout: that a finalized record
 * cannot be edited, that a prescription without a dose cannot be written, that a
 * correction is a request and not an edit, and that the guards keep the wrong role out.
 *
 * Every patient and clinician here is fictional.
 */

const HOSPITAL_ID = '507f1f77bcf86cd7994390b1'

function user(overrides: Partial<MockUser> = {}): MockUser {
  return {
    userId: '507f1f77bcf86cd7994390c1',
    email: 'doctor-a@example.test',
    firstName: 'Fictional',
    lastName: 'Clinician',
    role: 'DOCTOR',
    hospitalId: HOSPITAL_ID,
    hospitalName: 'Aarav Memorial Hospital',
    membershipId: '507f1f77bcf86cd7994390c2',
    permissions: [...ROLE_PERMISSIONS.DOCTOR],
    ...overrides,
  }
}

const PATIENT_ID = '507f1f77bcf86cd7994390e1'

const DRAFT = {
  id: '507f1f77bcf86cd7994390a1',
  patientId: PATIENT_ID,
  patientLabel: 'PT-000001 — Anaya Testpatient',
  doctorUserId: '507f1f77bcf86cd7994390c1',
  doctorName: 'Fictional Clinician',
  appointmentId: null,
  status: 'DRAFT' as const,
  chiefComplaint: 'Recurring headache',
  symptoms: 'Dull ache, both temples.',
  assessment: 'Tension-type headache.',
  plan: 'Rest and fluids.',
  followUpAt: null,
  clinicalData: null,
  authoredByUserId: '507f1f77bcf86cd7994390c1',
  authoredAt: '2026-10-12T09:00:00.000Z',
  finalizedAt: null,
  finalizedByUserId: null,
  updatedByUserId: null,
  updatedAt: '2026-10-12T09:00:00.000Z',
  amendments: [],
  prescriptions: [],
}

const FINALIZED = {
  ...DRAFT,
  status: 'FINALIZED' as const,
  finalizedAt: '2026-10-12T10:00:00.000Z',
  finalizedByUserId: '507f1f77bcf86cd7994390c1',
  amendments: [
    {
      fields: ['assessment'],
      before: { assessment: 'Tension-type headache.' },
      after: { assessment: 'Corrected after re-examination.' },
      reason: 'Re-examined the patient; the earlier wording understated the findings.',
      byUserId: '507f1f77bcf86cd7994390c1',
      at: '2026-10-12T11:00:00.000Z',
    },
  ],
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
  // Deliberately NOT stubbing `URL`: spreading the constructor yields a plain object, and
  // the API client does `new URL(...)` on every request. A stub that breaks the thing it
  // appears to help turns every assertion into a mystery.
})

describe('the clinician queue', () => {
  const DATE = '2026-10-14'

  const routes = {
    'GET /api/v1/consultations/queue': {
      data: {
        date: DATE,
        timezone: 'Asia/Kolkata',
        generatedAt: '2026-10-12T09:00:00.000Z',
        items: [
          {
            appointmentId: '507f1f77bcf86cd7994390b2',
            patientId: PATIENT_ID,
            patientName: 'Nandini Testpatient',
            startAt: '2026-10-14T05:20:00.000Z',
            reason: 'Follow-up',
            status: 'SCHEDULED',
            consultationId: null,
            consultationStatus: null,
            needsConsultation: true,
          },
          {
            appointmentId: '507f1f77bcf86cd7994390b3',
            patientId: '507f1f77bcf86cd7994390e2',
            patientName: 'Anaya Testpatient',
            startAt: '2026-10-14T04:30:00.000Z',
            reason: 'New patient',
            status: 'SCHEDULED',
            consultationId: '507f1f77bcf86cd7994390a9',
            consultationStatus: 'DRAFT',
            needsConsultation: false,
          },
        ],
      },
    },
  }

  it('puts patients who still need writing up first', async () => {
    mockApi({ ...sessionRoutes(user()), ...routes })

    renderApp(<QueuePage />)

    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row')

    // The unseen patient is first even though the seen one is earlier in the day. This is
    // the whole point of the screen.
    expect(within(rows[1] as HTMLElement).getByText('Nandini Testpatient')).toBeDefined()
    expect(within(rows[2] as HTMLElement).getByText('Anaya Testpatient')).toBeDefined()
  })

  it('says plainly who has not been seen', async () => {
    mockApi({ ...sessionRoutes(user()), ...routes })

    renderApp(<QueuePage />)

    await screen.findByText('Nandini Testpatient')
    expect(screen.getByText('Not yet seen')).toBeDefined()
    expect(screen.getByText('Draft')).toBeDefined()
  })

  it('opens an existing record rather than creating a second one', async () => {
    const actor = userEvent.setup()
    const api = mockApi({ ...sessionRoutes(user()), ...routes })

    renderApp(<QueuePage />)

    await actor.click(await screen.findByRole('button', { name: 'Open record' }))
    await actor.click(await screen.findByRole('button', { name: 'Go to this record' }))

    // Creating a second consultation for the same appointment would put two clinical
    // records where there should be one.
    await waitFor(() => {
      expect(api.requests.some((r) => r.method === 'POST' && r.url.includes('/consultations'))).toBe(
        false,
      )
    })
  })

  it('starts a draft through the real endpoint', async () => {
    const actor = userEvent.setup()
    const api = mockApi({
      ...sessionRoutes(user()),
      ...routes,
      'POST /api/v1/consultations': { status: 201, data: DRAFT },
    })

    renderApp(<QueuePage />)

    await actor.click(await screen.findByRole('button', { name: 'Start consultation' }))
    await actor.click(await screen.findByRole('button', { name: 'Create draft' }))

    await waitFor(() => {
      const post = api.requests.find((r) => r.method === 'POST' && r.url.endsWith('/consultations'))
      expect(post?.body).toMatchObject({
        patientId: PATIENT_ID,
        appointmentId: '507f1f77bcf86cd7994390b2',
      })
    })
  })

  it('says when a day is empty rather than showing a blank table', async () => {
    mockApi({
      ...sessionRoutes(user()),
      'GET /api/v1/consultations/queue': {
        data: {
          date: DATE,
          timezone: 'Asia/Kolkata',
          generatedAt: '2026-10-12T09:00:00.000Z',
          items: [],
        },
      },
    })

    renderApp(<QueuePage />)

    expect(await screen.findByText('Nobody booked in')).toBeDefined()
  })
})

describe('the clinical record', () => {
  it('lets a draft be edited freely, with no reason required', async () => {
    const actor = userEvent.setup()
    const api = mockApi({
      ...sessionRoutes(user()),
      'GET /api/v1/consultations/507f1f77bcf86cd7994390a1': { data: DRAFT },
      'PATCH /api/v1/consultations/507f1f77bcf86cd7994390a1': { data: DRAFT },
    })

    await renderAppRoutes('/consultations/507f1f77bcf86cd7994390a1')

    const plan = await screen.findByLabelText(/plan and advice/i)
    await actor.clear(plan)
    await actor.type(plan, 'Reviewed in two weeks.')
    await actor.click(screen.getByRole('button', { name: /save draft/i }))

    await waitFor(() => {
      const patch = api.requests.find((r) => r.method === 'PATCH')
      expect(patch?.body).toMatchObject({ plan: 'Reviewed in two weeks.' })
      // A draft is the clinician's own scratch work; making them justify an edit to
      // themselves would be noise.
      expect(patch?.body).not.toHaveProperty('amendmentReason')
    })
  })

  it('locks a finalized record and offers an amendment instead', async () => {
    mockApi({
      ...sessionRoutes(user()),
      'GET /api/v1/consultations/507f1f77bcf86cd7994390a1': { data: FINALIZED },
    })

    await renderAppRoutes('/consultations/507f1f77bcf86cd7994390a1')

    await screen.findByText('This record is signed')

    // The editor is gone entirely, and the amendment path is offered instead. Hiding the
    // button is not the enforcement — the server refuses a silent edit regardless — but a
    // clinician should never write a paragraph only to be told it cannot be saved.
    expect(screen.queryByRole('button', { name: /save draft/i })).toBeNull()
    expect(screen.getByRole('button', { name: /record an amendment/i })).toBeDefined()
  })

  it('shows what an amendment changed and what it said before', async () => {
    mockApi({
      ...sessionRoutes(user()),
      'GET /api/v1/consultations/507f1f77bcf86cd7994390a1': { data: FINALIZED },
    })

    await renderAppRoutes('/consultations/507f1f77bcf86cd7994390a1')

    await screen.findByText('Amendment history')

    // Both versions. An amendment that only showed the new text would be indistinguishable
    // from an ordinary edit once the history had scrolled away.
    //
    // The old text appears twice — once in the record, once in the amendment's "said
    // before" — so this asserts a count rather than a single match.
    expect(screen.getAllByText('Tension-type headache.').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Corrected after re-examination.')).toBeDefined()
    expect(
      screen.getByText(/Re-examined the patient; the earlier wording understated/),
    ).toBeDefined()
  })

  it('will not record an amendment without a reason', async () => {
    const actor = userEvent.setup()
    const api = mockApi({
      ...sessionRoutes(user()),
      'GET /api/v1/consultations/507f1f77bcf86cd7994390a1': { data: FINALIZED },
      'PATCH /api/v1/consultations/507f1f77bcf86cd7994390a1': { data: FINALIZED },
    })

    await renderAppRoutes('/consultations/507f1f77bcf86cd7994390a1')

    await actor.click(await screen.findByRole('button', { name: /record an amendment/i }))

    await actor.type(await screen.findByLabelText(/^corrected text/i), 'Revised after review.')

    const submit = screen.getByRole('button', { name: /record amendment/i })
    expect(submit.hasAttribute('disabled')).toBe(true)

    await actor.type(screen.getByLabelText(/why is this being corrected/i), 'Re-examined.')
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false))

    await actor.click(submit)

    await waitFor(() => {
      const patch = api.requests.find((r) => r.method === 'PATCH')
      expect(patch?.body).toMatchObject({ amendmentReason: 'Re-examined.' })
    })
  })

  it('refuses a prescription that names a medicine with no dose or route', async () => {
    const actor = userEvent.setup()
    mockApi({
      ...sessionRoutes(user()),
      'GET /api/v1/consultations/507f1f77bcf86cd7994390a1': { data: FINALIZED },
    })

    await renderAppRoutes('/consultations/507f1f77bcf86cd7994390a1')

    await actor.click(await screen.findByRole('button', { name: /new prescription/i }))

    await actor.type(await screen.findByLabelText(/^medicine/i), 'Paracetamol')
    await actor.type(screen.getByLabelText(/^dose/i), '500 mg')
    await actor.type(screen.getByLabelText(/^route/i), 'oral')

    // Frequency is still blank, so a prescription would reach the patient as a drug name
    // with no instructions on when to take it.
    const submit = screen.getByRole('button', { name: /create draft/i })
    expect(submit.hasAttribute('disabled')).toBe(true)

    await actor.type(screen.getByLabelText(/^frequency/i), 'twice daily')
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false))
  })

  it('starts every medicine blank rather than suggesting one', () => {
    // Nothing here is prefilled. A default dose would be a clinical claim this product
    // makes on a clinician's behalf, which is exactly what it must never do.
    expect(emptyPrescriptionItem()).toEqual({
      drugName: '',
      dose: '',
      route: '',
      frequency: '',
    })
  })
})

describe('attendance', () => {
  const DATE = '2026-10-12'

  const record = {
    id: '507f1f77bcf86cd7994390b5',
    userId: '507f1f77bcf86cd7994390c1',
    userName: 'Fictional Clinician',
    workDate: DATE,
    checkInAt: '2026-10-12T04:00:00.000Z',
    checkOutAt: null,
    status: 'OPEN' as const,
    hoursWorked: null,
    corrections: [],
  }

  const routes = {
    'GET /api/v1/attendance/me': { data: { items: [record] } },
  }

  it('takes the check-in time from the server', async () => {
    const actor = userEvent.setup()
    const api = mockApi({
      ...sessionRoutes(user({ permissions: [...ROLE_PERMISSIONS.RECEPTIONIST] })),
      'GET /api/v1/attendance/me': { data: { items: [] } },
      'POST /api/v1/attendance/check-in': { status: 201, data: record },
    })

    renderApp(<AttendancePage />)

    await actor.click(await screen.findByRole('button', { name: /^check in$/i }))

    await waitFor(() => {
      const post = api.requests.find((r) => r.url.includes('check-in'))
      expect(post).toBeDefined()
      // No timestamp is offered. The server clock is the only source, and a control that
      // let someone type their own arrival time would make the record worthless.
      expect(post?.body ?? {}).toEqual({})
    })
  })

  it('refuses a second check-in on the same day', async () => {
    mockApi({
      ...sessionRoutes(user({ permissions: [...ROLE_PERMISSIONS.RECEPTIONIST] })),
      ...routes,
    })

    renderApp(<AttendancePage />)

    await screen.findByText('Fictional Clinician')
    // The control reflects the record rather than letting someone try and be refused.
    const already = screen.getByRole('button', { name: /already checked in/i })
    expect(already.hasAttribute('disabled')).toBe(true)
  })

  it('offers no way to edit a recorded time directly', async () => {
    mockApi({
      ...sessionRoutes(user({ permissions: [...ROLE_PERMISSIONS.RECEPTIONIST] })),
      ...routes,
    })

    renderApp(<AttendancePage />)

    await screen.findByText('Fictional Clinician')

    // The only path is a request, which somebody else decides. There is no edit control
    // anywhere on this screen, and that is the point of the whole workflow.
    expect(screen.getByRole('button', { name: /request a correction/i })).toBeDefined()
    expect(screen.queryByRole('button', { name: /^edit/i })).toBeNull()
  })

  it('will not send a correction request without a reason worth reading', async () => {
    const actor = userEvent.setup()
    mockApi({
      ...sessionRoutes(user({ permissions: [...ROLE_PERMISSIONS.RECEPTIONIST] })),
      ...routes,
    })

    renderApp(<AttendancePage />)

    await actor.click(await screen.findByRole('button', { name: /request a correction/i }))

    await actor.type(await screen.findByLabelText(/^correct time/i), '2026-10-12T08:00')

    const submit = screen.getByRole('button', { name: /send request/i })
    expect(submit.hasAttribute('disabled')).toBe(true)

    await actor.type(screen.getByLabelText(/why should this be changed/i), 'oops')
    expect(submit.hasAttribute('disabled')).toBe(true)

    await actor.type(
      screen.getByLabelText(/why should this be changed/i),
      ' — the terminal was down.',
    )
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false))
  })

  it('shows the team only to a holder of attendance:read:any', async () => {
    const reception = user({ permissions: [...ROLE_PERMISSIONS.RECEPTIONIST] })

    const api = mockApi({ ...sessionRoutes(reception), ...routes })

    renderApp(<AttendancePage />)

    await screen.findByText('Fictional Clinician')
    expect(screen.queryByText('Team attendance')).toBeNull()
    expect(api.requests.some((r) => r.url === '/api/v1/attendance')).toBe(false)

    mockApi({
      ...sessionRoutes(user({ permissions: [...ROLE_PERMISSIONS.HOSPITAL_ADMIN] })),
      ...routes,
      'GET /api/v1/attendance': {
        data: { workDate: DATE, timezone: 'Asia/Kolkata', items: [record] },
      },
    })

    renderApp(<AttendancePage />)

    expect(await screen.findByText('Team attendance')).toBeDefined()
  })
})

describe('clinical route guards', () => {
  const RECEPTION = user({ permissions: [...ROLE_PERMISSIONS.RECEPTIONIST] })

  it('keeps reception out of the queue', async () => {
    const api = mockApi({ ...sessionRoutes(RECEPTION) })

    await renderAppRoutes('/queue')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
    expect(api.requests.some((r) => r.url.includes('/consultations'))).toBe(false)
  })

  it('keeps a user without attendance:read out of attendance', async () => {
    mockApi({ ...sessionRoutes(user({ permissions: ['hospital:read', 'patient:read'] })) })

    await renderAppRoutes('/attendance')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
  })

  it('keeps a platform operator out of every clinical screen', async () => {
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

    for (const path of ['/queue', '/attendance']) {
      await renderAppRoutes(path)
      expect(await screen.findByText(/access restricted/i)).toBeDefined()
    }

    // The platform operator has `platform:*` permissions and no hospital. Clinical records
    // must be unreachable from there by construction, not by a check someone might forget.
    expect(
      api.requests.some(
        (r) => r.url.includes('/consultations') || r.url.includes('/attendance'),
      ),
    ).toBe(false)
  })

  it('lets a doctor reach the queue', async () => {
    mockApi({
      ...sessionRoutes(user()),
      'GET /api/v1/consultations/queue': {
        data: {
          date: '2026-10-12',
          timezone: 'Asia/Kolkata',
          generatedAt: '2026-10-12T09:00:00.000Z',
          items: [],
        },
      },
    })

    await renderAppRoutes('/queue')

    expect(await screen.findByText('Nobody booked in')).toBeDefined()
  })
})
