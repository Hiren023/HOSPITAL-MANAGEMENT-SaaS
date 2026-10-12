import { apiClient, ApiClientError } from '../../lib/api-client.js'

/**
 * Clinical records and attendance.
 *
 * Tenant-scoped like every other hospital endpoint: the hospital is whatever the signed
 * session says, so there is no `hospitalId` argument anywhere below and nothing for a
 * client to tamper with.
 *
 * Two things this client deliberately does not do:
 *
 * - **It never sends a timestamp for check-in or check-out.** Those endpoints take no body.
 *   The server owns the clock; letting the browser state its own arrival time would make
 *   the record worth nothing.
 * - **It never receives a document URL.** `documentAvailable` is a boolean, and the bytes
 *   come from an authorized fetch at download time. A URL handed to the browser is a
 *   capability that outlives the permission decision behind it.
 */

export interface Amendment {
  fields: string[]
  before: Record<string, unknown>
  after: Record<string, unknown>
  reason: string
  byUserId: string | null
  at: string | null
}

export interface Consultation {
  id: string
  patientId: string
  patientLabel: string | null
  doctorUserId: string
  doctorName: string | null
  appointmentId: string | null
  status: 'DRAFT' | 'FINALIZED'
  chiefComplaint: string | null
  symptoms: string | null
  assessment: string | null
  plan: string | null
  followUpAt: string | null
  clinicalData: unknown
  authoredByUserId: string
  authoredAt: string
  finalizedAt: string | null
  finalizedByUserId: string | null
  updatedByUserId: string | null
  updatedAt: string | null
  amendments: Amendment[]
  prescriptions?: Prescription[]
}

export interface PrescriptionItem {
  drugName: string
  dose: string
  route: string
  frequency: string
  duration?: string
  quantity?: string
  instructions?: string
}

export interface Prescription {
  id: string
  consultationId: string
  patientId: string
  doctorUserId: string
  items: PrescriptionItem[]
  notes: string | null
  status: 'DRAFT' | 'FINALIZED'
  authoredByUserId: string
  authoredAt: string
  finalizedAt: string | null
  finalizedByUserId: string | null
  documentAvailable: boolean
}

export interface QueueEntry {
  appointmentId: string
  patientId: string
  patientName: string | null
  startAt: string
  reason: string | null
  status: string
  consultationId: string | null
  consultationStatus: 'DRAFT' | 'FINALIZED' | null
  needsConsultation: boolean
}

export interface Queue {
  date: string
  timezone: string
  generatedAt: string
  items: QueueEntry[]
}

export interface PatientSummary {
  patient: {
    id: string
    patientNumber: string
    firstName: string
    lastName: string
    dateOfBirth: string
    gender: string
  }
  totalConsultationsInHospital: number
  visibleConsultations: number
  scopedToOwnRecords: boolean
  consultations: Consultation[]
  prescriptions: Prescription[]
}

/** A blank prescription item, shaped so every required field is visibly missing. */
export function emptyPrescriptionItem(): PrescriptionItem {
  return { drugName: '', dose: '', route: '', frequency: '' }
}

// ───────────────────────────── consultations ─────────────────────────────

export function fetchQueue(date: string, signal?: AbortSignal): Promise<Queue> {
  return apiClient.get('/consultations/queue', { query: { date }, signal })
}

export function fetchConsultation(id: string, signal?: AbortSignal): Promise<Consultation> {
  return apiClient.get(`/consultations/${id}`, { signal })
}

export function fetchConsultations(
  query: { patientId?: string; status?: string; pageSize?: number },
  signal?: AbortSignal,
): Promise<{ items: Consultation[] }> {
  return apiClient.get('/consultations', { query: { ...query }, signal })
}

export function createConsultation(input: {
  patientId: string
  appointmentId?: string
  chiefComplaint?: string
  symptoms?: string
  assessment?: string
  plan?: string
}): Promise<Consultation> {
  return apiClient.post('/consultations', input)
}

/**
 * Edit a consultation.
 *
 * `amendmentReason` is required by the SERVER once the record is finalized, and the button
 * that submits it is disabled without one. The client is not the security boundary — the
 * service refuses a silent edit regardless of what this sends — but reflecting the rule
 * here means a clinician is never told "you cannot do this" after writing their notes.
 */
export function updateConsultation(
  id: string,
  input: Partial<{
    chiefComplaint: string
    symptoms: string
    assessment: string
    plan: string
    followUpAt: string
  }> & { amendmentReason?: string },
): Promise<Consultation> {
  return apiClient.patch(`/consultations/${id}`, input)
}

export function finalizeConsultation(id: string): Promise<Consultation> {
  return apiClient.post(`/consultations/${id}/finalize`, { attestation: true })
}

export function fetchPatientSummary(
  patientId: string,
  signal?: AbortSignal,
): Promise<PatientSummary> {
  return apiClient.get(`/patients/${patientId}/clinical-summary`, { signal })
}

// ───────────────────────────── prescriptions ─────────────────────────────

export function createPrescription(input: {
  consultationId: string
  items: PrescriptionItem[]
  notes?: string
}): Promise<Prescription> {
  return apiClient.post('/prescriptions', input)
}

export function issuePrescription(id: string): Promise<Prescription> {
  return apiClient.post(`/prescriptions/${id}/issue`, { attestation: true })
}

/**
 * Download the generated PDF.
 *
 * Fetched with the access token rather than navigated to, because a plain link or
 * `window.open` would either drop the Authorization header or require a token in the URL
 * — and a token in a URL is a token in browser history, a proxy log and a referrer header.
 */
export async function downloadPrescriptionDocument(
  prescriptionId: string,
): Promise<{ fileName: string; blob: Blob }> {
  const token = apiClient.accessToken()

  const response = await fetch(
    `${apiClient.baseUrl}/prescriptions/${prescriptionId}/document`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  )

  if (!response.ok) {
    throw new ApiClientError(
      response.status === 403 ? 'FORBIDDEN' : response.status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
      response.status === 403 || response.status === 404
        ? 'You are not allowed to download this prescription.'
        : 'The prescription could not be downloaded.',
      response.status,
    )
  }

  const disposition = response.headers.get('content-disposition') ?? ''
  const match = /filename="([^"]+)"/.exec(disposition)

  return {
    fileName: match?.[1] ?? `prescription-${prescriptionId}.pdf`,
    blob: await response.blob(),
  }
}

// ─────────────────────────────── attendance ───────────────────────────────

export type AttendanceStatus = 'OPEN' | 'CLOSED' | 'CORRECTED'

export interface AttendanceCorrection {
  field: 'checkInAt' | 'checkOutAt'
  previousValue: string | null
  requestedValue: string | null
  reason: string
  requestedByUserId: string | null
  requestedAt: string | null
  decision: 'APPROVED' | 'REJECTED' | null
  decisionNote: string | null
  decidedByUserId: string | null
  decidedAt: string | null
}

export interface AttendanceRecord {
  id: string
  userId: string
  userName: string | null
  workDate: string
  checkInAt: string
  checkOutAt: string | null
  status: AttendanceStatus
  hoursWorked: number | null
  corrections: AttendanceCorrection[]
}

/**
 * Check in. Deliberately sends no body.
 *
 * The endpoint accepts no timestamp, so there is nothing for the client to offer: the
 * server clock is the only source of when this happened, which is the only thing that
 * makes the record worth keeping.
 */
export function checkIn(): Promise<AttendanceRecord> {
  return apiClient.post('/attendance/check-in', {})
}

export function checkOut(): Promise<AttendanceRecord> {
  return apiClient.post('/attendance/check-out', {})
}

export function fetchMyAttendance(
  workDate?: string,
  signal?: AbortSignal,
): Promise<{ items: AttendanceRecord[] }> {
  return apiClient.get('/attendance/me', {
    query: { workDate, pageSize: 31 },
    signal,
  })
}

export function fetchTeamAttendance(
  workDate: string,
  signal?: AbortSignal,
): Promise<{ workDate: string; timezone: string; items: AttendanceRecord[] }> {
  return apiClient.get('/attendance', { query: { workDate, pageSize: 100 }, signal })
}

/**
 * Ask for a correction. This does NOT change the record — that is the whole point, and it
 * is why the reason is mandatory here rather than optional.
 */
export function requestAttendanceCorrection(
  recordId: string,
  input: { field: 'checkInAt' | 'checkOutAt'; value: string; reason: string },
): Promise<AttendanceRecord> {
  return apiClient.post(`/attendance/${recordId}/correction-requests`, input)
}

export function decideAttendanceCorrection(
  recordId: string,
  decision: 'approve' | 'reject',
  note?: string,
): Promise<AttendanceRecord> {
  return apiClient.post(
    `/attendance/${recordId}/correction-requests/${decision}/decision`,
    { note },
  )
}

export { ApiClientError }