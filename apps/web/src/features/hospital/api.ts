import { HOSPITAL_ASSIGNABLE_ROLES, type ApiErrorCode, type Permission } from '@infinigrow/shared'

import { apiClient, ApiClientError } from '../../lib/api-client.js'

/**
 * Hospital administration API client.
 *
 * These endpoints are mounted at the API root, not under `/platform`: they are
 * tenant-scoped, and a `SUPER_ADMIN` cannot reach them. There is deliberately no
 * `hospitalId` argument on any function below — the hospital is whatever the signed
 * session says, so the client has nothing to tamper with. Every call independently
 * re-checks its permission on the server.
 */

export interface HospitalMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface Address {
  line1?: string | null
  line2?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
  country?: string | null
}

export interface HospitalProfile {
  id: string
  name: string
  slug: string
  status: string
  plan: string
  planLabel: string
  seatLimit: number | null
  registrationNumber: string | null
  contactEmail: string | null
  contactPhone: string | null
  address: Address | null
  settings: Record<string, unknown> | null
  approvedAt: string | null
  createdAt: string
}

export interface Department {
  id: string
  name: string
  code: string
  description: string | null
  headUserId: string | null
  isActive: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface ScheduleBlock {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number
  /** Minutes from midnight. Stored numerically so ordering and overlap checks are exact. */
  startMinute: number
  endMinute: number
  slotDurationMinutes: number
  isActive: boolean
}

export interface DoctorProfile {
  id: string
  userId: string
  fullName: string | null
  email: string | null
  phone: string | null
  accountStatus: string | null
  departmentId: string | null
  /**
   * The council registration number, masked unless the caller holds `doctor:write`.
   *
   * This is professional-registry data, not decoration: the server decides what to
   * return and this client has no way to unmask it.
   */
  registrationNumber: string | null
  registrationNumberMasked: boolean
  specialities: string[]
  qualifications: string[]
  yearsOfExperience: number
  consultationFeeInPaise: number
  bio: string | null
  isAcceptingNewPatients: boolean
  schedule: ScheduleBlock[]
  createdAt: string
  updatedAt: string
}

export interface StaffMember {
  userId: string
  fullName: string
  email: string
  phone: string | null
  accountStatus: string
  lastLoginAt: string | null
  role: string | null
  membershipStatus: string | null
}

export interface Page<TItem> {
  items: TItem[]
  page: HospitalMeta
}

export interface ListQuery {
  page?: number
  pageSize?: number
  q?: string
}

// ───────────────────────────────────────── hospital ────────────────────────────────────────

export function fetchHospitalProfile(signal?: AbortSignal): Promise<HospitalProfile> {
  return apiClient.get<HospitalProfile>('/hospital', { signal })
}

export function updateHospitalProfile(
  input: Partial<Pick<HospitalProfile, 'name' | 'registrationNumber' | 'contactEmail' | 'contactPhone' | 'address'>>,
): Promise<HospitalProfile> {
  return apiClient.patch('/hospital', input)
}

/**
 * Settings are patched under their own path and under their own permission.
 *
 * Separating them from the profile is deliberate: operational settings (appointment
 * duration, currency, registration prefix) are governed by `hospital:settings:manage`,
 * while the profile is `hospital:write`. Merging them would mean one of the two
 * permissions could silently edit the other's fields.
 */
export function updateHospitalSettings(
  input: Record<string, unknown>,
): Promise<HospitalProfile> {
  return apiClient.patch('/hospital/settings', input)
}

// ───────────────────────────────────────── departments ──────────────────────────────────────

export function fetchDepartments(
  query: ListQuery & { isActive?: boolean },
  signal?: AbortSignal,
): Promise<Page<Department>> {
  return apiClient.get('/departments', {
    query: { ...query, isActive: query.isActive === undefined ? undefined : String(query.isActive) },
    signal,
  })
}

export function createDepartment(input: {
  name: string
  code: string
  description?: string
  sortOrder?: number
}): Promise<Department> {
  return apiClient.post('/departments', input)
}

export function updateDepartment(
  departmentId: string,
  input: Partial<Pick<Department, 'name' | 'description' | 'isActive' | 'sortOrder'>>,
): Promise<Department> {
  return apiClient.patch(`/departments/${departmentId}`, input)
}

// ───────────────────────────────────────── doctors ─────────────────────────────────────────

export function fetchDoctors(query: ListQuery, signal?: AbortSignal): Promise<Page<DoctorProfile>> {
  return apiClient.get('/doctors', { query: { ...query }, signal })
}

export function fetchDoctor(profileId: string, signal?: AbortSignal): Promise<DoctorProfile> {
  return apiClient.get<DoctorProfile>(`/doctors/${profileId}`, { signal })
}

export function createDoctorProfile(input: {
  userId: string
  registrationNumber: string
  departmentId?: string
  specialities?: string[]
  qualifications?: string[]
  yearsOfExperience?: number
  consultationFeeInPaise?: number
  bio?: string
  isAcceptingNewPatients?: boolean
}): Promise<DoctorProfile> {
  return apiClient.post('/doctors', input)
}

export function updateDoctorProfile(
  profileId: string,
  input: Partial<
    Pick<
      DoctorProfile,
      | 'departmentId'
      | 'registrationNumber'
      | 'specialities'
      | 'qualifications'
      | 'yearsOfExperience'
      | 'consultationFeeInPaise'
      | 'bio'
      | 'isAcceptingNewPatients'
    >
  >,
): Promise<DoctorProfile> {
  return apiClient.patch(`/doctors/${profileId}`, input)
}

// ───────────────────────────────────────── schedule ─────────────────────────────────────────

export function fetchSchedule(
  profileId: string,
  signal?: AbortSignal,
): Promise<{ doctorProfileId: string; blocks: ScheduleBlock[] }> {
  return apiClient.get(`/doctors/${profileId}/schedule`, { signal })
}

/** Replaces the whole week. The server does not merge, and neither does this client. */
export function replaceSchedule(
  profileId: string,
  blocks: Omit<ScheduleBlock, 'isActive'>[],
): Promise<{ doctorProfileId: string; blocks: ScheduleBlock[] }> {
  return apiClient.put(`/doctors/${profileId}/schedule`, { blocks })
}

// ───────────────────────────────────────── staff ───────────────────────────────────────────

export function fetchStaff(
  query: ListQuery & { role?: string; membershipStatus?: string },
  signal?: AbortSignal,
): Promise<Page<StaffMember>> {
  return apiClient.get('/staff', { query: { ...query }, signal })
}

export function createStaffAccount(input: {
  email: string
  firstName: string
  lastName: string
  phone?: string
  role: string
  grantedPermissions?: string[]
}): Promise<{ userId: string; email: string; fullName: string; role: string; accountStatus: string }> {
  return apiClient.post('/staff', input)
}

export function changeStaffRole(
  userId: string,
  role: string,
  grantedPermissions?: string[],
): Promise<{ userId: string; role: string }> {
  return apiClient.patch(`/staff/${userId}/role`, grantedPermissions ? { role, grantedPermissions } : { role })
}

export function setStaffStatus(
  userId: string,
  status: 'ACTIVE' | 'SUSPENDED',
  reason: string,
): Promise<{ userId: string; status: string }> {
  return apiClient.patch(`/staff/${userId}/status`, { status, reason })
}

// ───────────────────────────────────────── helpers ─────────────────────────────────────────

export const ASSIGNABLE_ROLES = HOSPITAL_ASSIGNABLE_ROLES

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/** Minutes from midnight → "09:30". The inverse is `parseMinute`. */
export function formatMinute(minute: number): string {
  const safe = Number.isFinite(minute) ? Math.max(0, Math.min(24 * 60, Math.trunc(minute))) : 0
  const hours = Math.floor(safe / 60)
  return `${String(hours).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

/** "09:30" → 570. Returns null for anything unparseable so the caller can reject it. */
export function parseMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 24 || minutes > 59) return null

  const total = hours * 60 + minutes
  return total > 24 * 60 ? null : total
}

/** Paise → "₹1,500.00". Fees are stored in paise to keep arithmetic exact. */
export function formatInr(paise: number): string {
  const rupees = (Number.isFinite(paise) ? paise : 0) / 100
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(rupees)
}

/** Rupees as typed by a person → paise. Returns null when the text is not a number. */
export function parseInr(value: string): number | null {
  const trimmed = value.trim()

  // A leading minus must be rejected outright. Stripping every non-digit first would
  // quietly turn "-50" into 5000, so a negative price becomes a positive one with no
  // error anywhere — the sort of failure nobody notices until the books are wrong.
  if (trimmed.startsWith('-')) return null

  const cleaned = trimmed.replace(/[^0-9.]/g, '')
  if (cleaned === '' || cleaned === '.') return null

  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed) || parsed < 0) return null

  return Math.round(parsed * 100)
}

export { ApiClientError }
export type { ApiErrorCode, Permission }