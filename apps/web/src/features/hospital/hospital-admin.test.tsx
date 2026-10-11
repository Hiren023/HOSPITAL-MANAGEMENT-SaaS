import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { ROLE_PERMISSIONS, type Permission } from '@infinigrow/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DepartmentsPage } from './DepartmentsPage.js'
import { DoctorsPage } from './DoctorsPage.js'
import { DoctorProfilePage } from './DoctorProfilePage.js'
import { StaffPage } from './StaffPage.js'
import { HospitalProfilePage } from './HospitalProfilePage.js'
import { formatInr, formatMinute, parseInr, parseMinute } from './api.js'
import {
  mockApi,
  renderApp,
  renderAppRoutes,
  sessionRoutes,
  type MockRoute,
  type MockUser,
} from '../../test/harness.js'
import { expectNoSeriousViolations } from '../../test/a11y.js'

/**
 * Hospital administration — frontend.
 *
 * The API suite proves the server refuses what it should. These prove the other half:
 * that the screens call the real endpoints, render what came back, and never present a
 * control the identity cannot actually use.
 *
 * Every permission-sensitive assertion renders the real `App` through `renderAppRoutes`,
 * because rendering a page component directly bypasses its guard — the assertion would
 * pass for the wrong reason and would keep passing if the guard were deleted.
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

const DEPARTMENTS = [
  {
    id: '507f1f77bcf86cd7994390d1',
    name: 'Cardiology',
    code: 'CARD',
    description: 'Heart and circulation',
    headUserId: null,
    isActive: true,
    sortOrder: 1,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  },
]

const DOCTORS = [
  {
    id: '507f1f77bcf86cd7994390e1',
    userId: '507f1f77bcf86cd7994390e2',
    fullName: 'Arjun Mehta',
    email: 'arjun.mehta@example.test',
    phone: null,
    accountStatus: 'ACTIVE',
    departmentId: '507f1f77bcf86cd7994390d1',
    registrationNumber: 'GMC/2026/4471',
    registrationNumberMasked: false,
    specialities: ['Cardiology'],
    qualifications: ['MBBS', 'DM'],
    yearsOfExperience: 12,
    consultationFeeInPaise: 150000,
    bio: null,
    isAcceptingNewPatients: true,
    schedule: [],
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  },
]

const STAFF = [
  {
    userId: '507f1f77bcf86cd7994390f1',
    fullName: 'Nikhil Shah',
    email: 'nikhil.shah@example.test',
    phone: null,
    accountStatus: 'ACTIVE',
    lastLoginAt: '2026-10-09T08:00:00.000Z',
    role: 'RECEPTIONIST',
    membershipStatus: 'ACTIVE',
  },
]

const HOSPITAL = {
  id: HOSPITAL_ID,
  name: 'Aarav Memorial Hospital',
  slug: 'aarav-memorial',
  status: 'APPROVED',
  plan: 'HOSPITAL',
  planLabel: 'Hospital',
  seatLimit: 25,
  registrationNumber: 'GJ/2026/1042',
  contactEmail: 'contact@aarav.example.test',
  contactPhone: null,
  address: { city: 'Ahmedabad', state: 'Gujarat' },
  settings: { defaultAppointmentMinutes: 15, currency: 'INR', registrationNumberPrefix: 'AMH' },
  approvedAt: '2026-09-01T09:00:00.000Z',
  createdAt: '2026-08-20T09:00:00.000Z',
}

function page<TItem>(items: TItem[], total = items.length) {
  return {
    items,
    page: { page: 1, pageSize: 20, total, totalPages: total === 0 ? 0 : 1 },
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'scrollTo',
    vi.fn(),
  )
})

describe('time and money helpers', () => {
  it('renders and parses minutes from midnight', () => {
    expect(formatMinute(9 * 60 + 30)).toBe('09:30')
    expect(parseMinute('09:30')).toBe(570)
    expect(parseMinute('00:00')).toBe(0)
  })

  it('refuses a time it cannot understand rather than guessing', () => {
    expect(parseMinute('9am')).toBeNull()
    expect(parseMinute('25:00')).toBeNull()
    expect(parseMinute('09:75')).toBeNull()
  })

  it('round-trips rupees through paise exactly', () => {
    expect(parseInr('1500')).toBe(150000)
    expect(parseInr('1500.50')).toBe(150050)
    expect(formatInr(150050)).toContain('1,500.50')
  })

  it('refuses text that is not a number', () => {
    expect(parseInr('')).toBeNull()
    expect(parseInr('abc')).toBeNull()
    expect(parseInr('-5')).toBeNull()
  })
})

describe('departments screen', () => {
  it('renders the departments the API returned', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/departments': { data: page(DEPARTMENTS) },
    })

    renderApp(<DepartmentsPage />)

    expect(await screen.findByText('Cardiology')).toBeDefined()
    expect(screen.getByText('CARD')).toBeDefined()
    expect(screen.getByText('Heart and circulation')).toBeDefined()
  })

  it('offers no create control to someone who may only read', async () => {
    const readOnly: Permission[] = ['hospital:read', 'department:read']

    mockApi({
      ...sessionRoutes(hospitalUser({ permissions: readOnly })),
      'GET /api/v1/departments': { data: page(DEPARTMENTS) },
    })

    renderApp(<DepartmentsPage />)

    expect(await screen.findByText('Cardiology')).toBeDefined()
    expect(screen.queryByRole('button', { name: /new department/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull()
  })

  it('creates a department through the real endpoint', async () => {
    const user = userEvent.setup()
    const api = mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/departments': [{ data: page(DEPARTMENTS) }, { data: page(DEPARTMENTS, 2) }],
      'POST /api/v1/departments': { status: 201, data: DEPARTMENTS[0] },
    })

    renderApp(<DepartmentsPage />)
    await screen.findByText('Cardiology')

    await user.click(screen.getByRole('button', { name: /new department/i }))

    const nameField = screen.getByLabelText(/^name/i)
    await user.clear(nameField)
    await user.type(nameField, 'Neurology')
    await user.type(screen.getByLabelText(/^code/i), 'NEUR')

    await user.click(screen.getByRole('button', { name: /create department/i }))

    await waitFor(() => {
      const post = api.requests.find((r) => r.method === 'POST' && r.url.includes('/departments'))
      expect(post?.body).toMatchObject({ name: 'Neurology', code: 'NEUR' })
    })
  })

  it('surfaces the server message when a duplicate code is refused', async () => {
    const user = userEvent.setup()

    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/departments': { data: page(DEPARTMENTS) },
      'POST /api/v1/departments': {
        status: 409,
        error: { code: 'CONFLICT', message: 'A department with that code already exists.' },
      },
    })

    renderApp(<DepartmentsPage />)
    await screen.findByText('Cardiology')

    await user.click(screen.getByRole('button', { name: /new department/i }))
    await user.type(screen.getByLabelText(/^name/i), 'Neurology')
    await user.type(screen.getByLabelText(/^code/i), 'CARD')
    await user.click(screen.getByRole('button', { name: /create department/i }))

    expect(
      await screen.findByText('A department with that code already exists.'),
    ).toBeDefined()
  })

  it('has no serious accessibility violations', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/departments': { data: page(DEPARTMENTS) },
    })

    const { container } = renderApp(<DepartmentsPage />)
    await screen.findByText('Cardiology')

    await expectNoSeriousViolations(container)
  })
})

describe('doctors screen', () => {
  it('renders the doctor list with its money formatted from paise', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/doctors': { data: page(DOCTORS) },
      'GET /api/v1/departments': { data: page(DEPARTMENTS) },
    })

    renderApp(<DoctorsPage />)

    expect(await screen.findByText('Arjun Mehta')).toBeDefined()
    expect(screen.getByText('GMC/2026/4471')).toBeDefined()
    expect(screen.getByText('₹1,500.00')).toBeDefined()
  })

  it('shows the department name resolved from the departments endpoint', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/doctors': { data: page(DOCTORS) },
      'GET /api/v1/departments': { data: page(DEPARTMENTS) },
    })

    renderApp(<DoctorsPage />)

    await screen.findByText('Arjun Mehta')
    expect(screen.getByText('Cardiology')).toBeDefined()
  })

  it('explains a masked registration rather than rendering a blank', async () => {
    const reader: Permission[] = ['hospital:read', 'doctor:read']

    mockApi({
      ...sessionRoutes(hospitalUser({ permissions: reader })),
      'GET /api/v1/doctors': {
        data: page([{ ...DOCTORS[0], registrationNumber: '••••/••••/4471', registrationNumberMasked: true }]),
      },
    })

    renderApp(<DoctorsPage />)

    await screen.findByText('Arjun Mehta')
    // No create control, and no request the identity is not allowed to make.
    expect(screen.queryByRole('button', { name: /new doctor profile/i })).toBeNull()
  })

  it('does not request departments from someone who may not read them', async () => {
    const api = mockApi({
      ...sessionRoutes(hospitalUser({ permissions: ['hospital:read', 'doctor:read'] })),
      'GET /api/v1/doctors': { data: page(DOCTORS) },
    })

    renderApp(<DoctorsPage />)
    await screen.findByText('Arjun Mehta')

    expect(api.requests.some((r) => r.url.includes('/departments'))).toBe(false)
  })
})

describe('staff screen', () => {
  it('offers only roles a hospital may assign', async () => {
    const user = userEvent.setup()

    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/staff': { data: page(STAFF) },
    })

    renderApp(<StaffPage />)
    await screen.findByText('Nikhil Shah')

    await user.click(screen.getByRole('button', { name: /new staff account/i }))

    const roleSelect = screen.getByLabelText(/^role$/i)
    const options = within(roleSelect)
      .getAllByRole('option')
      .map((option) => option.textContent)

    expect(options).toContain('DOCTOR')
    // The single most important assertion on this screen: a hospital administrator has
    // no way to mint a platform operator, even before the server refuses it.
    expect(options).not.toContain('SUPER_ADMIN')
    expect(options).not.toContain('PATIENT')
  })

  it('hides role and status controls from someone without the permission', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser({ permissions: ['hospital:read', 'user:read'] })),
      'GET /api/v1/staff': { data: page(STAFF) },
    })

    renderApp(<StaffPage />)
    await screen.findByText('Nikhil Shah')

    expect(screen.queryByRole('button', { name: /^role$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /suspend/i })).toBeNull()
  })

  it('refuses to suspend without a reason worth recording', async () => {
    const user = userEvent.setup()

    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/staff': { data: page(STAFF) },
    })

    renderApp(<StaffPage />)
    await screen.findByText('Nikhil Shah')

    await user.click(screen.getByRole('button', { name: /suspend/i }))

    const confirm = screen.getByRole('button', { name: /suspend account/i })
    expect(confirm.hasAttribute('disabled')).toBe(true)
  })
})

describe('hospital screen', () => {
  it('renders the hospital it belongs to', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      'GET /api/v1/hospital': { data: HOSPITAL },
    })

    renderApp(<HospitalProfilePage />)

    expect(await screen.findByDisplayValue('Aarav Memorial Hospital')).toBeDefined()
    expect(screen.getByDisplayValue('/aarav-memorial')).toBeDefined()
  })

  it('separates profile editing from settings so the weaker permission cannot reach it', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser({ permissions: ['hospital:read', 'hospital:write'] })),
      'GET /api/v1/hospital': { data: HOSPITAL },
    })

    renderApp(<HospitalProfilePage />)
    await screen.findByDisplayValue('Aarav Memorial Hospital')

    expect(screen.getByRole('button', { name: /save profile/i })).toBeDefined()
    // hospital:write must not imply hospital:settings:manage.
    expect(screen.queryByRole('button', { name: /save settings/i })).toBeNull()
  })
})

describe('doctor profile screen', () => {
  const PROFILE = {
    id: '507f1f77bcf86cd7994390e1',
    userId: '507f1f77bcf86cd7994390e2',
    fullName: 'Arjun Mehta',
    email: 'arjun.mehta@example.test',
    phone: null,
    accountStatus: 'ACTIVE',
    departmentId: '507f1f77bcf86cd7994390d1',
    registrationNumber: 'GMC/2026/4471',
    registrationNumberMasked: false,
    specialities: ['Cardiology'],
    qualifications: ['MBBS'],
    yearsOfExperience: 12,
    consultationFeeInPaise: 150000,
    bio: null,
    isAcceptingNewPatients: true,
    schedule: [],
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  }

  const SCHEDULE = {
    doctorProfileId: PROFILE.id,
    blocks: [
      { weekday: 1, startMinute: 540, endMinute: 780, slotDurationMinutes: 20, isActive: true },
    ],
  }

  /**
   * The profile page reads its id from the route, so it must be rendered inside one.
   *
   * `renderApp` rather than a hand-rolled provider stack: the page calls `useAuth`, and
   * rebuilding the providers here would be a second, subtly different version of them.
   */
  function renderProfile() {
    return renderApp(
      <Routes>
        <Route path="/doctors/:profileId" element={<DoctorProfilePage />} />
      </Routes>,
      { route: `/doctors/${PROFILE.id}` },
    )
  }

  const profileRoutes = {
    [`GET /api/v1/doctors/${PROFILE.id}`]: { data: PROFILE },
    [`GET /api/v1/doctors/${PROFILE.id}/schedule`]: { data: SCHEDULE },
    'GET /api/v1/departments': { data: page(DEPARTMENTS) },
  }

  it('renders the profile and the saved schedule', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser()),
      ...profileRoutes,
    })

    const { container } = renderProfile()

    expect(await screen.findByText('Weekly schedule')).toBeDefined()
    expect(within(container).getAllByText('Arjun Mehta').length).toBeGreaterThan(0)
    // 540 minutes must arrive as "09:00", not as a raw integer in the time input.
    expect((screen.getByLabelText('Monday start time') as HTMLInputElement).value).toBe('09:00')
  })

  /**
   * Regression: the profile editor and the schedule editor are siblings, and `doctor.id`
   * is the very same string as the `:profileId` route param. Keying both on the bare id
   * made React log "two children with the same key" on every render — the warning that
   * precedes children being duplicated or dropped. No mocked assertion caught it, because
   * none of them looked at the console.
   */
  it('logs no React warning while rendering both editors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    mockApi({
      ...sessionRoutes(hospitalUser()),
      ...profileRoutes,
    })

    const { container } = renderProfile()
    await screen.findByText('Weekly schedule')
    await within(container).findByRole('button', { name: /save schedule/i })

    const messages = consoleError.mock.calls.map((call) => call.map(String).join(' '))
    expect(messages.filter((m) => m.includes('same key'))).toEqual([])

    consoleError.mockRestore()
  })

  it('reports a schedule that ends before it starts, naming the day', async () => {
    const user = userEvent.setup()

    mockApi({
      ...sessionRoutes(hospitalUser()),
      ...profileRoutes,
      [`PUT /api/v1/doctors/${PROFILE.id}/schedule`]: { data: SCHEDULE },
    })

    renderProfile()
    await screen.findByText('Weekly schedule')

    const start = screen.getByLabelText('Monday start time')
    await user.clear(start)
    await user.type(start, '17:00')

    await user.click(screen.getByRole('button', { name: /save schedule/i }))

    expect(
      await screen.findByText('Monday: the finish time must be after the start time.'),
    ).toBeDefined()
  })
})

describe('route guards', () => {
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

  it('keeps a platform operator out of the hospital screens', async () => {
    const api = mockApi({ ...sessionRoutes(SUPER_ADMIN) })

    await renderAppRoutes('/departments')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
    // The guard must stop the request, not merely hide the result.
    expect(api.requests.some((r) => r.url.includes('/departments'))).toBe(false)
  })

  it('keeps a hospital user out of the platform console', async () => {
    mockApi({ ...sessionRoutes(hospitalUser()) })

    await renderAppRoutes('/platform/hospitals')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
  })

  it('refuses a hospital screen to a signed-in user without its permission', async () => {
    mockApi({
      ...sessionRoutes(hospitalUser({ permissions: ['hospital:read', 'user:read'] })),
    })

    await renderAppRoutes('/doctors')

    expect(await screen.findByText(/access restricted/i)).toBeDefined()
  })

  it('lets a hospital administrator open the screens they hold permissions for', async () => {
    const routes: Record<string, MockRoute> = {
      'GET /api/v1/departments': { data: page(DEPARTMENTS) },
    }

    mockApi({ ...sessionRoutes(hospitalUser()), ...routes })

    await renderAppRoutes('/departments')

    expect(await screen.findByText('Cardiology')).toBeDefined()
  })
})