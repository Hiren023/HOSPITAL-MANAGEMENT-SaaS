/**
 * Notification provider adapter.
 *
 * ── Why `DELIVERED` is unreachable from here ───────────────────────────────────
 *
 * The honest problem with this interface is that it is tempting to write
 *
 * ```ts
 * send(input): Promise<{ status: 'SENT' | 'DELIVERED' }>
 * ```
 *
 * and then to have the placeholder return `DELIVERED` because "it went out, right?".
 * That is how a system starts asserting that a patient read a message when the only
 * evidence is that an API accepted it.
 *
 * Most SMS gateways genuinely cannot tell the difference. They report "delivered" for a
 * number that was disconnected six months ago. A design that lets a provider say
 * `DELIVERED` therefore records a provider's guess as a fact, and a delivery log built on
 * guesses is worse than no delivery log, because it looks like evidence.
 *
 * So `ProviderOutcome` has no `DELIVERED` member. A provider may report `SENT` (it accepted
 * the message for delivery), `FAILED` (it did not accept it), or `PERMANENT` (the address
 * itself is the problem — malformed, undeliverable, on a suppression list). `DELIVERED`
 * exists in the stored vocabulary because a real gateway integration would need somewhere
 * to put a verified delivery receipt reconciled by a human, and it is unreachable in this
 * MVP for exactly the reason `VERIFIED` is unreachable in the payment adapter.
 *
 * ── No provider is wired up ────────────────────────────────────────────────────
 *
 * `NullNotificationProvider` contacts nobody and returns `SENT` semantics of "accepted for
 * processing, outcome unknown", which stores as `PENDING`.
 */

import type { NotificationChannel } from '@infinigrow/shared'

export interface ProviderSendInput {
  /** Already-resolved contact point. Looked up at send time, never stored on the message. */
  to: string
  subject?: string | undefined
  body: string
  /** The message's own id, so a provider's logs can be tied back to a row. */
  reference: string
}

export type ProviderOutcome =
  /** Accepted for delivery. NOT a statement that anybody received it. */
  | { outcome: 'ACCEPTED'; providerMessageId: string }
  /** The provider refused it; the address or content was the problem. Do not retry. */
  | { outcome: 'PERMANENT'; reason: string }
  /** Transient failure; the backoff schedule decides whether to try again. */
  | { outcome: 'TRANSIENT'; reason: string }

export interface NotificationProvider {
  readonly name: string
  readonly channel: NotificationChannel
  send(input: ProviderSendInput): Promise<ProviderOutcome>
}

/**
 * The default: no provider, nothing sent, nothing claimed.
 *
 * `ACCEPTED` here is the weakest possible truth — "the module accepted it and will do
 * nothing" — and it stores as `PENDING` precisely so a screen cannot render it as sent.
 */
export const nullNotificationProvider: NotificationProvider = {
  name: 'none',
  channel: 'SMS',

  async send(input: ProviderSendInput): Promise<ProviderOutcome> {
    return { outcome: 'ACCEPTED', providerMessageId: `null-${input.reference}` }
  },
}

/**
 * The provider per channel. `const` because the map is mutated in place, not replaced —
 * rebinding it would drop the other channel's provider without anybody noticing.
 */
const providers: Partial<Record<NotificationChannel, NotificationProvider>> = {
  SMS: nullNotificationProvider,
  EMAIL: nullNotificationProvider,
}

export function providerFor(channel: NotificationChannel): NotificationProvider {
  return providers[channel] ?? nullNotificationProvider
}

/**
 * Replace the provider for a channel.
 *
 * Exists so a real integration is one wiring change rather than an edit scattered through
 * the services. Setting it is a deliberate act: it means credentials, patient contact
 * details leaving the system, and a vendor data-processing agreement — see
 * `docs/SECURITY.md` R16. The verification path is unchanged either way.
 */
export function setNotificationProvider(provider: NotificationProvider): void {
  providers[provider.channel] = provider
}

/** Restore the null provider for a channel. Used by tests and by a deliberate rollback. */
export function resetNotificationProvider(channel: NotificationChannel): void {
  providers[channel] = nullNotificationProvider
}