import type { ApiErrorCode, ModuleKey, SubscriptionStatus } from '@infinigrow/shared'

import { apiClient, ApiClientError } from '../../lib/api-client.js'

/**
 * Subscription API client (tenant side).
 *
 * Read-only, and there is deliberately no `hospitalId` argument anywhere: the hospital is
 * whatever the signed session says. A hospital cannot renew, upgrade or un-suspend itself
 * — those are platform-operator actions — so there is no mutation here to offer, and no
 * button that would fail when pressed.
 */

export interface UsageEntry {
  used: number
  /** `null` means unlimited. */
  limit: number | null
  displayLimit: string
}

export interface SubscriptionSummary {
  /** False when no subscription row exists — an anomaly, not a normal state. */
  configured: boolean
  plan: string
  planLabel: string
  status: SubscriptionStatus
  paymentState: string
  entitlements: ModuleKey[]
  mayRead: boolean
  mayWrite: boolean
  denied: string | null
  trialEndsAt: string | null
  currentPeriodEndsAt: string
  gracePeriodEndsAt: string | null
  suspendedAt: string | null
  cancelAtPeriodEnd: boolean
  limits: { seats: number | null; departments: number | null }
  /**
   * Counted live on the server, not read from a cache.
   *
   * Keyed by the resource being limited rather than by module: a usage bar says "12 of 50
   * seats", and naming the module that happens to own the seat count would make the
   * client do a lookup to render a label it already has.
   */
  usage: { seats: UsageEntry; departments: UsageEntry }
  hospitalName: string | null
}

export async function fetchOwnSubscription(signal?: AbortSignal): Promise<SubscriptionSummary> {
  return apiClient.get<SubscriptionSummary>('/hospital/subscription', { signal })
}

/**
 * The banner a suspended or lapsed tenant sees.
 *
 * Reads like a message rather than an error, and says explicitly that nothing was
 * deleted. A hospital in a billing dispute still needs to open its patient list, and an
 * alarming red "ACCESS DENIED" on every screen would be both untrue and useless.
 */
export function accessNotice(subscription: SubscriptionSummary): {
  tone: 'warning' | 'danger'
  title: string
  body: string
} | null {
  if (subscription.status === 'SUSPENDED') {
    return {
      tone: 'danger',
      title: 'Your subscription is suspended',
      body: 'You can read every existing record, but new records cannot be added until payment is confirmed. Nothing has been deleted.',
    }
  }

  if (subscription.status === 'PAST_DUE') {
    return {
      tone: 'warning',
      title: 'Payment is overdue',
      body: subscription.gracePeriodEndsAt
        ? `You keep full access until ${formatDate(subscription.gracePeriodEndsAt)}, after which records become read-only.`
        : 'You keep full access for the grace period. Contact your account manager.',
    }
  }

  if (subscription.status === 'EXPIRED' || subscription.status === 'CANCELLED') {
    return {
      tone: 'danger',
      title: 'Your subscription has ended',
      body: 'Records are no longer available here. Renew to restore access. Nothing has been deleted.',
    }
  }

  return null
}

/** Whole days until an instant, floored at zero. */
export function daysUntil(iso: string, now: Date = new Date()): number {
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) return 0
  return Math.max(0, Math.floor((target - now.getTime()) / 86_400_000))
}

/**
 * Format a date for display, in the browser's locale.
 *
 * Deliberately NOT converted to the hospital's timezone here. `docs/TIMEZONE.md` is
 * explicit that the client echoes the instants the API returns rather than re-projecting
 * them, and a renewal date that shifts by a day depending on where the reader is sitting
 * is worse than one that is stated once, plainly.
 */
export function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) return '—'

  return value.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function isEntitledError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.code === ('FORBIDDEN' as ApiErrorCode)
}