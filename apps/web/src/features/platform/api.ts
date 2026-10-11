import type { ApiErrorCode, Permission } from '@infinigrow/shared'

import { apiClient, ApiClientError } from '../../lib/api-client.js'

/**
 * Platform console API client.
 *
 * Every call here goes to a real `/api/v1/platform/*` endpoint that is
 * `SUPER_ADMIN`-only and independently re-checks the permission on the server. Nothing
 * in this module invents, caches optimistically, or falls back to sample data: the
 * console's job is to show platform truth, and a fabricated figure in an operator's
 * view is worse than an error.
 */

export interface PlatformMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface HospitalSummary {
  id: string
  name: string
  slug: string
  status: string
  plan: string
  planLabel: string
  seatLimit: number | null
  registrationNumber: string | null
  contactEmail: string | null
  city: string | null
  state: string | null
  createdAt: string
  approvedAt: string | null
  suspendedAt: string | null
  suspensionReason: string | null
}

export interface HospitalDetail extends HospitalSummary {
  departmentLimit: number | null
  indicativeMonthlyPriceInr: number
  approvedBy: string | null
  reactivatedAt: string | null
  planChangedAt: string | null
  address: Record<string, unknown> | null
  usersByRole: Record<string, number>
  totalUsers: number
}

export interface TenantUser {
  userId: string
  email: string
  firstName: string
  lastName: string
  status: string
  emailVerified: boolean
  lastLoginAt: string | null
  role: string | null
  membershipStatus: string | null
}

export interface AuditEvent {
  id: string
  action: string
  actorUserId: string | null
  actorRole: string | null
  hospitalId: string | null
  resourceType: string | null
  resourceId: string | null
  outcome: string | null
  ip: string | null
  createdAt: string
  metadata: Record<string, unknown> | null
}

export interface PlatformOverview {
  tenants: {
    total: number
    pending: number
    approved: number
    suspended: number
    rejected: number
  }
  identity: {
    totalUsers: number
    activeMemberships: number
  }
  plans: Record<string, number>
  recentActivity: { last24h: number; mostRecentAt: string | null }
}

export interface OperationalReport {
  windowDays: number
  since: string
  tenants: {
    active: number
    registeredInWindow: number
    byStatus: Record<string, number>
    byPlan: Record<string, number>
  }
  growth: { date: string; count: number }[]
}

// ───────────────────────────────────────── queries ─────────────────────────────────────────

export function fetchPlatformOverview(): Promise<PlatformOverview> {
  return apiClient.get<PlatformOverview>('/platform/overview')
}

export interface HospitalListQuery {
  page?: number
  pageSize?: number
  q?: string
  status?: string
  plan?: string
  sort?: 'createdAt' | 'name'
}

export function fetchHospitals(
  query: HospitalListQuery,
  signal?: AbortSignal,
): Promise<{ items: HospitalSummary[]; page: PlatformMeta }> {
  return apiClient.get('/platform/hospitals', { query: { ...query }, signal })
}

export function fetchHospitalDetail(hospitalId: string): Promise<HospitalDetail> {
  return apiClient.get<HospitalDetail>(`/platform/hospitals/${hospitalId}`)
}

export function fetchTenantUsers(
  hospitalId: string,
  query: { page?: number; pageSize?: number; q?: string; role?: string; status?: string },
  signal?: AbortSignal,
): Promise<{ items: TenantUser[]; page: PlatformMeta }> {
  return apiClient.get(`/platform/hospitals/${hospitalId}/users`, { query: { ...query }, signal })
}

// ───────────────────────────────────────── mutations ───────────────────────────────────────

export function approveHospital(
  hospitalId: string,
): Promise<{ hospitalId: string; status: string }> {
  return apiClient.post(`/platform/hospitals/${hospitalId}/approve`, {})
}

export function suspendHospital(
  hospitalId: string,
  reason: string,
): Promise<{ hospitalId: string; status: string }> {
  return apiClient.post(`/platform/hospitals/${hospitalId}/suspend`, { reason })
}

export function reactivateHospital(
  hospitalId: string,
  note?: string,
): Promise<{ hospitalId: string; status: string }> {
  return apiClient.post(`/platform/hospitals/${hospitalId}/reactivate`, note ? { note } : {})
}

export function assignPlan(
  hospitalId: string,
  plan: string,
  reason?: string,
): Promise<{ hospitalId: string; plan: string; planLabel: string; seatLimit: number | null }> {
  return apiClient.put(
    `/platform/hospitals/${hospitalId}/plan`,
    reason ? { plan, reason } : { plan },
  )
}

export function changeUserStatus(
  userId: string,
  status: 'ACTIVE' | 'SUSPENDED',
  reason: string,
): Promise<{ userId: string; status: string; email: string }> {
  return apiClient.patch(`/platform/users/${userId}/status`, { status, reason })
}

// ───────────────────────────────────────── audit ───────────────────────────────────────────

export interface AuditQuery {
  cursor?: string
  limit?: number
  q?: string
  action?: string
  actorUserId?: string
  hospitalId?: string
  from?: string
  to?: string
}

export function fetchAuditEvents(
  query: AuditQuery,
  signal?: AbortSignal,
): Promise<{ items: AuditEvent[]; nextCursor: string | null; limit: number }> {
  return apiClient.get('/platform/audit', { query: { ...query }, signal })
}

export function fetchOperationalReport(days: number): Promise<OperationalReport> {
  return apiClient.get('/platform/reports/operational', { query: { days } })
}

// ───────────────────────────────────────── helpers ────────────────────────────────────────

export { ApiClientError }
export type { ApiErrorCode, Permission }
