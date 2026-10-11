import type { ApiErrorCode, Permission } from '@infinigrow/shared'

import { apiClient, ApiClientError } from '../../lib/api-client.js'

/**
 * Clinic API client — patients and appointments.
 *
 * These endpoints are tenant-scoped; a `SUPER_ADMIN` is refused every one. There is
 * deliberately no `hospitalId` argument anywhere below: the hospital is whatever the
 * signed session says, so the client has nothing to tamper with.
 *
 * **Booking takes an instant the server chose.** `freeSlots` come back as ISO 8601
 * instants, and the client sends one back verbatim. The alternative — the browser
 * converting a local "09:00" into an instant itself — is where timezone bugs live, and
 * near a DST transition some local times do not exist at all. Letting the server propose
 * the slots removes the conversion from the client entirely.
 */

export interface PageMeta {
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

export interface EmergencyContact {
  name?: string | null
  relationship?: string | null
  phone?: string | null
}

export interface Patient {
  id: string
  patientNumber: string
  firstName: string
  lastName: string
  dateOfBirth: string
  gender: string
  isActive: boolean

  /**
   * False when the caller may read demographics but not contact details.
   *
   * The interface uses this to explain WHY a field is blank, instead of rendering an empty
   * column that reads as missing data.
   */
  contactVisible: boolean
  phone: string | null
  email: string | null
  address: Address | null
  emergencyContact: EmergencyContact | null

  registeredByUserId: string | null
  createdAt: string
  updatedAt: string
}

export interface PatientPage {
  items: Patient[]
  page: PageMeta
}

export interface PatientListQuery {
  page?: number
  pageSize?: number
  q?: string
  gender?: string
  isActive?: boolean
  patientNumber?: string
  phone?: string
}

export interface DuplicateMatch {
  id: string
  patientNumber: string
  firstName: string
  lastName: string
  dateOfBirth: string
}

export const APPOINTMENT_STATUSES = [
  'SCHEDULED',
  'CONFIRMED',
  'CHECKED_IN',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]

export interface StatusEvent {
  from: AppointmentStatus | null
  to: AppointmentStatus
  at: string
  byUserId: string | null
  reason: string | null
}

export interface Appointment {
  id: string
  patientId: string
  doctorUserId: string
  doctorProfileId: string | null
  departmentId: string | null
  startAt: string
  endAt: string
  status: AppointmentStatus
  reason: string | null
  statusHistory: StatusEvent[]
  cancelledAt: string | null
  cancellationReason: string | null
  patientName: string | null
  doctorName: string | null
  createdAt: string
  updatedAt: string

  /** Present only on the day view; derived from the instant in the hospital's zone. */
  localTime?: string
  localWeekday?: number
}

export interface DayView {
  date: string
  timezone: string
  generatedAt: string
  appointments: Appointment[]
  counts: Record<string, number>
}

export interface FreeSlot {
  startAt: string
  localTime: string
}

export interface DoctorAvailability {
  doctorUserId: string
  doctorProfileId: string
  freeSlots: FreeSlot[]
}

export interface Availability {
  date: string
  timezone: string
  closed: boolean
  durationMinutes: number
  doctors: DoctorAvailability[]
}

export interface AppointmentListQuery {
  page?: number
  pageSize?: number
  status?: AppointmentStatus
  doctorUserId?: string
  patientId?: string
  from?: string
  to?: string
}

// ───────────────────────────────────────── patients ────────────────────────────────────────

export function fetchPatients(
  query: PatientListQuery,
  signal?: AbortSignal,
): Promise<PatientPage> {
  return apiClient.get('/patients', {
    query: {
      ...query,
      isActive: query.isActive === undefined ? undefined : String(query.isActive),
    },
    signal,
  })
}

export function fetchPatient(patientId: string, signal?: AbortSignal): Promise<Patient> {
  return apiClient.get<Patient>(`/patients/${patientId}`, { signal })
}

export function registerPatient(input: {
  firstName: string
  lastName: string
  dateOfBirth: string
  gender?: string
  phone?: string
  email?: string
  address?: Record<string, string | undefined>
  emergencyContact?: Record<string, string | undefined>
}): Promise<Patient> {
  return apiClient.post('/patients', input)
}

export function updatePatient(
  patientId: string,
  input: Record<string, unknown>,
): Promise<Patient> {
  return apiClient.patch(`/patients/${patientId}`, input)
}

/**
 * Possible duplicates for the values in a partially completed registration form.
 *
 * A warning, not a gate: siblings genuinely share a name and a birthday, and refusing the
 * second one would be a worse failure than a duplicate record someone can merge.
 */
export function checkDuplicate(input: {
  firstName: string
  lastName: string
  dateOfBirth: string
}): Promise<{ matches: DuplicateMatch[]; exactMatches: number }> {
  return apiClient.post('/patients/duplicate-check', input)
}

// ────────────────────────────────────── appointments ───────────────────────────────────────

export function fetchDayView(
  query: { date: string; doctorUserId?: string; departmentId?: string },
  signal?: AbortSignal,
): Promise<DayView> {
  return apiClient.get('/appointments/day', { query: { ...query }, signal })
}

export function fetchAppointments(
  query: AppointmentListQuery,
  signal?: AbortSignal,
): Promise<{ items: Appointment[]; page: PageMeta }> {
  return apiClient.get('/appointments', { query: { ...query }, signal })
}

export function fetchAvailability(
  query: { date: string; doctorUserId?: string; departmentId?: string; durationMinutes?: number },
  signal?: AbortSignal,
): Promise<Availability> {
  return apiClient.get('/appointments/availability', { query: { ...query }, signal })
}

export function bookAppointment(input: {
  patientId: string
  doctorUserId: string
  startAt: string
  durationMinutes?: number
  reason?: string
  confirm?: boolean
}): Promise<Appointment> {
  return apiClient.post('/appointments', input)
}

export function rescheduleAppointment(
  appointmentId: string,
  input: { startAt: string; durationMinutes?: number; reason: string },
): Promise<Appointment> {
  return apiClient.patch(`/appointments/${appointmentId}/reschedule`, input)
}

/**
 * Cancel, freeing the slot.
 *
 * A POST rather than a DELETE: cancelling is not removal. The appointment stays, its status
 * history keeps every transition, and the slot is released so someone else can take it.
 */
export function cancelAppointment(
  appointmentId: string,
  reason: string,
): Promise<Appointment> {
  return apiClient.post(`/appointments/${appointmentId}/cancel`, { reason })
}

export function updateWorkingHours(
  workingHours: Record<string, { opensAtMinute: number; closesAtMinute: number } | null>,
): Promise<{ workingHours: Record<string, unknown>; timezone: string }> {
  return apiClient.patch('/appointments/working-hours', { workingHours })
}

// ───────────────────────────────────────── helpers ─────────────────────────────────────────

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export function statusTone(
  status: string,
): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  switch (status) {
    case 'SCHEDULED':
      return 'info'
    case 'CONFIRMED':
    case 'CHECKED_IN':
      return 'success'
    case 'COMPLETED':
      return 'neutral'
    case 'CANCELLED':
    case 'NO_SHOW':
      return 'danger'
    default:
      return 'warning'
  }
}

/** Minutes from midnight → "09:30". */
export function formatMinuteOfDay(minute: number): string {
  const safe = Math.max(0, Math.min(24 * 60, Math.trunc(minute)))
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

export function ageFrom(dateOfBirth: string): number | null {
  const born = new Date(`${dateOfBirth}T00:00:00.000Z`)
  if (Number.isNaN(born.getTime())) return null

  const now = new Date()
  let age = now.getUTCFullYear() - born.getUTCFullYear()
  const monthDelta = now.getUTCMonth() - born.getUTCMonth()
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < born.getUTCDate())) age -= 1

  return age >= 0 && age < 130 ? age : null
}

/** Today in the hospital's own calendar — not the caller's, which may be a different day. */
export function hospitalToday(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export function addDaysToKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export { ApiClientError }
export type { ApiErrorCode, Permission }