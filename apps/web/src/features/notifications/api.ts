import type {
  NotificationCategory,
  NotificationChannel,
  NotificationStatus,
} from '@infinigrow/shared'

import { apiClient } from '../../lib/api-client.js'

/**
 * Notification API client.
 *
 * Read and queue. There is no template-editing call anywhere, and there is no
 * "send this text" call either — the server composes every message from a reviewed
 * template, so the client has nothing to compose.
 *
 * Deliberately no `hospitalId` argument: the hospital is whatever the signed session says,
 * so there is nothing here for a caller to tamper with.
 */

export interface NotificationRow {
  id: string
  channel: NotificationChannel
  templateKey: string
  recipientKind: 'PATIENT' | 'USER'
  recipientRef: string | null
  category: NotificationCategory
  status: NotificationStatus
  attempts: number
  maxAttempts: number
  nextAttemptAt: string | null
  providerMessageId: string | null
  failureReason: string | null
  suppressionReason: string | null
  sentAt: string | null
  deliveredAt: string | null
  createdAt: string | null
  attemptsLog: Array<{
    attempt: number | null
    at: string | null
    outcome: string | null
    reason: string | null
  }>
}

export interface PageMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface NotificationTemplate {
  key: string
  channel: NotificationChannel
  category: NotificationCategory
  description: string
  subject: string | null
  body: string
  active: boolean
}

export interface ConsentRecord {
  channel: NotificationChannel
  granted: boolean
  grantedAt: string | null
  revokedAt: string | null
  source: string | null
}

export async function fetchNotifications(
  query: { page?: number; pageSize?: number; status?: NotificationStatus } = {},
  signal?: AbortSignal,
): Promise<{ items: NotificationRow[]; meta: PageMeta }> {
  const params = new URLSearchParams()
  params.set('page', String(query.page ?? 1))
  params.set('pageSize', String(query.pageSize ?? 20))
  if (query.status) params.set('status', query.status)

  return apiClient.get(`/notifications?${params.toString()}`, { signal })
}

export async function fetchNotification(
  id: string,
  signal?: AbortSignal,
): Promise<NotificationRow> {
  return apiClient.get(`/notifications/${id}`, { signal })
}

export async function retryNotification(id: string): Promise<NotificationRow> {
  return apiClient.post(`/notifications/${id}/retry`, {})
}

/**
 * Queue a message.
 *
 * There is no `body` parameter and no way to add one. The five substitution values are the
 * whole of what a caller can influence, which is the same boundary the server enforces.
 */
export async function queueNotification(input: {
  templateKey: string
  recipientKind: 'PATIENT' | 'USER'
  recipientRef: string
  substitutions?: {
    recipientName?: string
    dateLabel?: string
    timeLabel?: string
    departmentName?: string
    locationName?: string
  }
}): Promise<{ queued: boolean; notification: NotificationRow }> {
  return apiClient.post('/notifications', input)
}

export async function fetchTemplates(signal?: AbortSignal): Promise<NotificationTemplate[]> {
  const data = await apiClient.get<{ items: NotificationTemplate[] }>('/notifications/templates', {
    signal,
  })
  return data.items
}

export interface MyPreferences {
  items: Array<{ channel: NotificationChannel; category: NotificationCategory; enabled: boolean }>
}

export async function fetchMyPreferences(signal?: AbortSignal): Promise<MyPreferences> {
  return apiClient.get('/notifications/preferences', { signal })
}

export async function updateMyPreference(input: {
  channel: NotificationChannel
  category: NotificationCategory
  enabled: boolean
}): Promise<MyPreferences> {
  return apiClient.put('/notifications/preferences', input)
}

export async function fetchConsents(
  recipientRef: string,
  recipientKind: 'PATIENT' | 'USER' = 'PATIENT',
  signal?: AbortSignal,
): Promise<{ consents: ConsentRecord[] }> {
  return apiClient.get(
    `/notifications/consents?recipientKind=${recipientKind}&recipientRef=${recipientRef}`,
    { signal },
  )
}

export async function recordConsent(input: {
  recipientRef: string
  recipientKind?: 'PATIENT' | 'USER'
  channel: NotificationChannel
  granted: boolean
  source?: string
}): Promise<{ consents: ConsentRecord[] }> {
  return apiClient.post(
    `/notifications/consents?recipientRef=${input.recipientRef}`,
    {
      recipientKind: input.recipientKind ?? 'PATIENT',
      channel: input.channel,
      granted: input.granted,
      source: input.source,
    },
  )
}

/** Human wording for a suppression reason. Never "error". */
export function suppressionLabel(reason: string | null): string | null {
  switch (reason) {
    case 'NO_CONSENT':
      return 'No consent recorded for this channel'
    case 'CONSENT_REVOKED':
      return 'Consent was withdrawn'
    case 'PREFERENCE_DISABLED':
      return 'The recipient opted out of this category'
    case 'NO_CONTACT_DETAILS':
      return 'No phone number or email on file'
    case 'UNSAFE_PREVIEW':
      return 'Blocked: the message could not be composed safely'
    default:
      return null
  }
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—'
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) return '—'

  return value.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}