/**
 * Payment provider adapter.
 *
 * ── Why this interface has no "confirm success" method ────────────────────────
 *
 * It is tempting to write:
 *
 * ```ts
 * confirmPayment(ref: string): Promise<'SUCCESS'>
 * ```
 *
 * and then to have the MVP's placeholder return `SUCCESS` because there is no real
 * provider yet. That is how a system ends up treating a provider's *claim* as settled cash,
 * and every downstream report inherits the lie.
 *
 * So the interface physically cannot do it. There is no method that returns a verified
 * state, and `confirmCheckout` may only return `PENDING` or `FAILED`. A future adapter that
 * wants the subscription to be paid must go through the same reconciliation path a person
 * uses — which means somebody looked at a bank statement.
 *
 * This is deliberately the same rule as Phase 8's payment records, where a `MANUAL` payment
 * is always `UNVERIFIED` and only an explicit reconciliation promotes it. One rule,
 * applied twice, is easier to keep honest than two rules each invented separately.
 *
 * ── No provider is wired up ───────────────────────────────────────────────────
 *
 * `NullPaymentProvider` creates no checkout, contacts nobody and reports `NONE`/`PENDING`.
 * It is the default so the system is runnable, and it is incapable of producing a
 * verified subscription.
 */

import type { PaymentState } from '@infinigrow/shared'

export interface CheckoutRequest {
  hospitalId: string
  plan: string
  /** Integer minor units. See docs/MONEY.md. */
  amountMinor: number
  currency: string
  returnUrl: string
}

export interface CheckoutSession {
  /** Where the payer would go. Never populated by the null provider. */
  checkoutUrl: string
  providerRef: string
  state: PaymentState
}

export interface ProviderConfirmation {
  providerRef: string
  /**
   * What the provider says happened.
   *
   * `PENDING` and `FAILED` are the only outcomes a provider may report. There is no
   * `VERIFIED` here by design — see the note at the top of this file.
   */
  state: Exclude<PaymentState, 'NONE' | 'VERIFIED'>
  /** Populated on failure so an operator can see why without reading provider logs. */
  reason?: string
}

export interface PaymentProvider {
  readonly name: string

  /** Begin a checkout. Returns `state: 'PENDING'` at best. */
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>

  /** Ask the provider what it believes happened. Cannot confirm. */
  confirmCheckout(providerRef: string): Promise<ProviderConfirmation>

  /** Cancel at the provider, if one exists. Best-effort; failures are not fatal. */
  cancelSubscription(providerSubscriptionId: string): Promise<void>
}

/**
 * The default: no provider, no money moved, nothing verified.
 *
 * `createCheckout` returns an empty URL and `PENDING`. A caller that tries to redirect a
 * payer here gets nothing, which is correct — there is nowhere to send them.
 */
export const nullPaymentProvider: PaymentProvider = {
  name: 'none',

  async createCheckout(): Promise<CheckoutSession> {
    return {
      checkoutUrl: '',
      providerRef: '',
      state: 'PENDING',
    }
  },

  async confirmCheckout(): Promise<ProviderConfirmation> {
    return { providerRef: '', state: 'PENDING', reason: 'No payment provider is configured.' }
  },

  async cancelSubscription(): Promise<void> {
    // Nothing to cancel. Intentionally silent: a no-op provider must not make an operator
    // think a real cancellation failed somewhere.
  },
}

let activeProvider: PaymentProvider = nullPaymentProvider

/** The configured provider. Null until a real one is wired, which requires a security review. */
export function paymentProvider(): PaymentProvider {
  return activeProvider
}

/**
 * Replace the provider.
 *
 * Exists so a future integration is one wiring change rather than an edit scattered through
 * the services. Setting it is a deliberate act — see `docs/SECURITY.md` R16 — and the
 * verification path is unchanged either way.
 */
export function setPaymentProvider(provider: PaymentProvider): void {
  activeProvider = provider
}

/** Restore the null provider. Used by tests, and by a deliberate rollback. */
export function resetPaymentProvider(): void {
  activeProvider = nullPaymentProvider
}