import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ROLE_PERMISSIONS, type Permission } from '@infinigrow/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PatientsPage } from './PatientsPage.js'
import { SchedulePage } from './SchedulePage.js'
import { addDaysToKey, ageFrom, formatMinuteOfDay, hospitalToday, statusTone } from './api.js'
import {
  mockApi,
  renderApp,
  renderAppRoutes,
  sessionRoutes,
  type MockUser,
} from '../../test/harness.js'

/**
 * Clinic screens — patients and appointments.
 *
 * Everything here is fictional. No real patient data appears anywhere in this file.
 *
 * Mock route keys are `"METHOD /pathname"` with NO query string. The harness strips the
 * query before matching, so a key containing `?` can never match — and the symptom is a
 * bare 404 with no obvious cause, which is how several of these first failed.
 */

const HOSPITAL_ID = '507f1f77bcf86cd7994390b1'
const TIMEZONE = 'Asia/Kolkata'

function hospitalUser(overrides: Partial<MockUser> = {}): MockUser {
  return {
    userId: '507f1f77bcf86cd7994390c1',
    email: 'meera.nair@example.test',
    firstName: 'Meera',
    lastName: 'Nair',
    role: 'HOSPITAL_ADMIN',
    hospitalId: HOSPITAL_ID,
    hospitalName: 'Kaveri Diagnostics Centre',
    membershipId: '507f1f77bcf86cd7994390c2',
    permissions: [...ROLE_PERMISSIONS.HOSPITAL_ADMIN],
    ...overrides,
  }
}

const PATIENT = {
  id: '507f1f77bcf86cd7994390e1',
  patientNumber: 'PT-000001',
  firstName: 'Anaya',
  lastName: 'Testpatient',
  dateOfBirth: '1991-04-17',
  gender: 'FEMALE',
  isActive: true,
  contactVisible: true,
  phone: '+91 90000 00000',
  email: 'anaya@example.test',
  address: { city: 'Ahmedabad', state: 'Gujarat' },
  emergencyContact: { name: 'Ravi Testpatient', relationship: 'Spouse', phone: '+91 90000 00001' },
  registeredByUserId: '507f1f77bcf86cd7994390c1',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
}

function page<TItem>(items: TItem[], total = items.length) {
  return { items, page: { page: 1, pageSize: 20, total, totalPages: total === 0 ? 0 : 1 } }
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
})

describe('clinic helpers', () => {
  it('computes an age from a date of birth', () => {
    const thisYear = new Date().getUTCFullYear()
    expect(ageFrom(`${thisYear - 30}-01-01`)).toBe(30)
    expect(ageFrom('not-a-date')).toBeNull()
    // A date in the future would give a negative age; refuse it rather than render "-3".
    expect(ageFrom('2999-01-01')).toBeNull()
  })

  it('formats minutes from midnight', () => {
    expect(formatMinuteOfDay(570)).toBe('09:30')
    expect(formatMinuteOfDay(-5)).toBe('00:00')
  })

  it('adds days without drifting across a month boundary', () => {
    expect(addDaysToKey('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDaysToKey('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('reads today in the hospital zone, not the browser zone', () => {
    expect(hospitalToday(TIMEZONE)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('maps statuses onto tones a person can read', () => {
    expect(statusTone('SCHEDULED')).toBe('info')
    expect(statusTone('CANCELLED')).toBe('danger')
    expect(statusTone('COMPLETED')).toBe('neutral')
  })
})

describe('patient register', () => {
  it('lists the patients the API returned', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/patients': { data: page([PATIENT]) },
    })

    renderApp(<PatientsPage />)

    expect(await screen.findByText('Anaya Testpatient')).toBeDefined()
    expect(screen.getByText('PT-000001')).toBeDefined()
  })

  it('says why contact details are blank rather than showing an empty cell', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/patients': {
        data: page([{ ...PATIENT, contactVisible: false, phone: null, email: null }]),
      },
    })

    renderApp(<PatientsPage />)

    await screen.findByText('Anaya Testpatient')
    // An empty column reads as missing data. This says the server withheld it.
    expect(screen.getAllByText(/hidden — read-only access/i).length).toBeGreaterThan(0)
  })

  it('offers no registration control to a reader who cannot write', async () => {
    const readOnly: Permission[] = ['hospital:read', 'patient:read']

    mockApi({
      ...sessionRoutes(hospitalUser({ permissions: readOnly })),
      'GET /api/v1/patients': { data: page([PATIENT]) },
    })

    renderApp(<PatientsPage />)

    await screen.findByText('Anaya Testpatient')
    expect(screen.queryByRole('button', { name: /register patient/i })).toBeNull()
  })

  it('will not submit registration without a way to contact the patient', async () => {
    const user = userEvent.setup()

    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/patients': { data: page([PATIENT]) },
    })

    renderApp(<PatientsPage />)
    await screen.findByText('Anaya Testpatient')

    const openButtons = screen.getAllByRole('button', { name: /register patient/i })
    await user.click(openButtons[0] as HTMLElement)

    await user.type(screen.getByLabelText(/first name/i), 'Nandini')
    await user.type(screen.getByLabelText(/last name/i), 'Testpatient')
    await user.type(screen.getByLabelText(/date of birth/i), '1990-05-05')

    // No phone and no email, so the API would answer 422. The button reflects that
    // rather than letting someone fill the form and be rejected at the end.
    const submit = screen.getByRole('button', { name: /^register$/i })
    expect(submit.hasAttribute('disabled')).toBe(true)

    await user.type(screen.getByLabelText(/^phone/i), '9000000000')
    await waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false))
  })

  it('registers a patient through the real endpoint', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/patients': [{ data: page([PATIENT]) }, { data: page([PATIENT]) }],
      'POST /api/v1/patients': { status: 201, data: PATIENT },
      'POST /api/v1/patients/duplicate-check': { data: { matches: [], exactMatches: 0 } },
    })

    renderApp(<PatientsPage />)
    await screen.findByText('Anaya Testpatient')

    const openButtons = screen.getAllByRole('button', { name: /register patient/i })
    await user.click(openButtons[0] as HTMLElement)

    await user.type(screen.getByLabelText(/first name/i), 'Nandini')
    await user.type(screen.getByLabelText(/last name/i), 'Testpatient')
    await user.type(screen.getByLabelText(/date of birth/i), '1990-05-05')
    await user.type(screen.getByLabelText(/^phone/i), '9000000000')

    await user.click(screen.getByRole('button', { name: /^register$/i }))

    await waitFor(() => {
      const post = api.requests.find(
        (r) => r.method === 'POST' && r.url.includes('/patients') && !r.url.includes('duplicate'),
      )
      expect(post?.body).toMatchObject({
        firstName: 'Nandini',
        lastName: 'Testpatient',
        dateOfBirth: '1990-05-05',
      })
    })
  })

  it('warns about a possible duplicate without blocking registration', async () => {
    const user = userEvent.setup()

    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/patients': { data: page([]) },
      'POST /api/v1/patients': { status: 201, data: PATIENT },
      'POST /api/v1/patients/duplicate-check': {
        data: {
          matches: [
            {
              id: PATIENT.id,
              patientNumber: PATIENT.patientNumber,
              firstName: PATIENT.firstName,
              lastName: PATIENT.lastName,
              dateOfBirth: PATIENT.dateOfBirth,
            },
          ],
          exactMatches: 1,
        },
      },
    })

    renderApp(<PatientsPage />)
    await screen.findByText('No patients registered yet')

    const openButtons = screen.getAllByRole('button', { name: /register patient/i })
    await user.click(openButtons[0] as HTMLElement)

    await user.type(screen.getByLabelText(/first name/i), 'Anaya')
    await user.type(screen.getByLabelText(/last name/i), 'Testpatient')
    await user.type(screen.getByLabelText(/date of birth/i), '1991-04-17')
    await user.type(screen.getByLabelText(/^phone/i), '9000000000')

    expect(await screen.findByText(/this may already be a patient here/i)).toBeDefined()
    // A warning, not a block: two siblings can genuinely share a name and a birthday, and
    // refusing to register the second child would be a far worse failure than a duplicate
    // record someone can merge. The contact requirement still applies independently.
    expect(
      screen.getByRole('button', { name: /^register$/i }).hasAttribute('disabled'),
    ).toBe(false)
  })
})

describe('the clinic day', () => {
  const APPOINTMENT = {
    id: '507f1f77bcf86cd7994390a1',
    patientId: PATIENT.id,
    doctorUserId: '507f1f77bcf86cd7994390c2',
    doctorProfileId: null,
    departmentId: null,
    startAt: '2026-10-14T04:30:00.000Z',
    endAt: '2026-10-14T04:50:00.000Z',
    status: 'SCHEDULED' as const,
    reason: 'Follow-up',
    statusHistory: [],
    cancelledAt: null,
    cancellationReason: null,
    patientName: 'Anaya Testpatient',
    doctorName: 'Arjun Mehta',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    localTime: '10:00',
    localWeekday: 1,
  }

  const dayView = {
    date: '2026-10-14',
    timezone: TIMEZONE,
    generatedAt: '2026-10-01T09:00:00.000Z',
    appointments: [APPOINTMENT],
    counts: { SCHEDULED: 1 },
  }

  const availability = {
    date: '2026-10-14',
    timezone: TIMEZONE,
    closed: false,
    durationMinutes: 20,
    doctors: [
      {
        doctorUserId: '507f1f77bcf86cd7994390c2',
        doctorProfileId: '507f1f77bcf86cd7994390d1',
        freeSlots: [
          { startAt: '2026-10-14T05:00:00.000Z', localTime: '10:30' },
          { startAt: '2026-10-14T05:20:00.000Z', localTime: '10:50' },
        ],
      },
    ],
  }

  const routes = {
    'GET /api/v1/appointments/day': { data: dayView },
    'GET /api/v1/appointments/availability': { data: availability },
  }

  it('shows the day, using the local time the server derived', async () => {
    mockApi({ ...sessionRoutes(hospitalUser()), ...routes })

    renderApp(<SchedulePage />)

    expect(await screen.findByText('Anaya Testpatient')).toBeDefined()
    // 04:30 UTC is 10:00 in Asia/Kolkata. The SERVER supplies that string; the client
    // never converts it, which is precisely why it cannot get it wrong.
    expect(screen.getByText('10:00')).toBeDefined()
    expect(screen.getByText('Arjun Mehta')).toBeDefined()
  })

  it('offers the free slots the server reported, and nothing else', async () => {
    mockApi({ ...sessionRoutes(hospitalUser()), ...routes })

    renderApp(<SchedulePage />)

    expect(await screen.findByRole('button', { name: '10:30' })).toBeDefined()
    expect(screen.getByRole('button', { name: '10:50' })).toBeDefined()
    // 10:00 is already booked, so it must not appear as bookable.
    expect(screen.queryByRole('button', { name: /^10:00$/ })).toBeNull()
  })

  it('books an appointment using the instant the server proposed', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      ...sessionRoutes(hospitalUser()),
      ...routes,
      'GET /api/v1/patients': { data: page([PATIENT]) },
      'POST /api/v1/appointments': { status: 201, data: APPOINTMENT },
    })

    renderApp(<SchedulePage />)

    await user.click(await screen.findByRole('button', { name: '10:30' }))

    const dialog = await screen.findByRole('dialog')
    // `selectOptions` is the correct way to drive a <select>; clicking it and then
    // clicking an <option> does not reliably fire change in jsdom, so the value never
    // reaches state and the submit button stays disabled.
    await user.selectOptions(
      within(dialog).getByLabelText('Choose a patient') as HTMLSelectElement,
      PATIENT.id,
    )

    // Scoped to the dialog: the page header carries a button with the same name, so an
    // unscoped query matches two elements.
    await user.click(within(dialog).getByRole('button', { name: /book appointment/i }))

    await waitFor(() => {
      const post = api.requests.find((r) => r.method === 'POST' && r.url.includes('/appointments'))
      // The exact instant from the availability list, verbatim — not re-derived here.
      expect(post?.body).toMatchObject({
        patientId: PATIENT.id,
        doctorUserId: '507f1f77bcf86cd7994390c2',
        startAt: '2026-10-14T05:00:00.000Z',
      })
    })
  })

  it('will not cancel without a reason worth recording', async () => {
    const user = userEvent.setup()

    mockApi({
      ...sessionRoutes(hospitalUser()),
      ...routes,
      [`POST /api/v1/appointments/${APPOINTMENT.id}/cancel`]: { data: APPOINTMENT },
    })

    renderApp(<SchedulePage />)
    await screen.findByText('Anaya Testpatient')

    await user.click(screen.getByRole('button', { name: /^cancel$/i }))

    const confirm = await screen.findByRole('button', { name: /cancel appointment/i })
    expect(confirm.hasAttribute('disabled')).toBe(true)

    await user.type(screen.getByLabelText(/reason for cancelling/i), 'busy')
    expect(confirm.hasAttribute('disabled')).toBe(true)

    await user.type(screen.getByLabelText(/reason for cancelling/i), ' today')
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false))
  })

  it('cancels through the real endpoint', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      ...sessionRoutes(hospitalUser()),
      ...routes,
      [`POST /api/v1/appointments/${APPOINTMENT.id}/cancel`]: { data: APPOINTMENT },
    })

    renderApp(<SchedulePage />)
    await screen.findByText('Anaya Testpatient')

    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    await user.type(
      await screen.findByLabelText(/reason for cancelling/i),
      'Patient reported they cannot travel today.',
    )
    await user.click(screen.getByRole('button', { name: /cancel appointment/i }))

    await waitFor(() => {
      const post = api.requests.find((r) => r.method === 'POST' && r.url.includes('/cancel'))
      expect(post?.body).toMatchObject({
        reason: 'Patient reported they cannot travel today.',
      })
    })
  })

  it('offers a doctor no controls over another doctor\'s schedule', async () => {
    const doctorPermissions: Permission[] = ['hospital:read', 'patient:read', 'appointment:read']

    mockApi({
      ...sessionRoutes(hospitalUser({ permissions: doctorPermissions })),
      ...routes,
    })

    renderApp(<SchedulePage />)

    await screen.findByText('Anaya Testpatient')
    // No booking control at all: booking for others needs `appointment:write:any`.
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /book appointment/i })).toBeNull()
  })
})

describe('clinic route guards', () => {
  const SUPER_ADMIN: MockUser = {
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

  it('keeps a platform operator out of the patient register', async () => {
    const api = mockApi({ ...sessionRoutes(SUPER_ADMIN) })

    await renderAppRoutes('/patients')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
    // The guard must stop the request, not merely hide the result.
    expect(api.requests.some((r) => r.url.includes('/patients'))).toBe(false)
  })

  it('keeps a hospital user out of the platform console', async () => {
    mockApi({ ...sessionRoutes(hospitalUser()) })

    await renderAppRoutes('/platform/hospitals')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
  })

  it('refuses the patient register to a user without patient:read', async () => {
    mockApi({ ...sessionRoutes(hospitalUser({ permissions: ['hospital:read', 'user:read'] })) })

    await renderAppRoutes('/patients')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
  })

  it('refuses the schedule to a user without appointment:read', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser({ permissions: ['hospital:read', 'patient:read'] })),
    })

    await renderAppRoutes('/schedule')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
  })
})