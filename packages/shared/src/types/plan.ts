/**
 * Subscription plans and feature entitlements.
 *
 * ── Plan ≠ Permission ────────────────────────────────────────────────────────
 *
 * A **permission** says who you are. An **entitlement** says what this hospital bought.
 * They are deliberately separate and both are enforced server-side.
 *
 * Conflating them would mean a plan purchase could grant clinical access, and a role
 * change could silently remove billing. Neither is something a commercial decision should
 * be able to do, so `entitlements` lives here, beside the plan, and never travels in a
 * request.
 *
 * ── Fail closed ──────────────────────────────────────────────────────────────
 *
 * A module that is not explicitly granted is refused. An unknown module key, a missing
 * subscription, or a subscription that cannot be read all deny access rather than
 * allowing it. A gate that fails open is a gate that will fail open somewhere.
 */

export const PLANS = ['STARTER', 'HOSPITAL', 'ENTERPRISE'] as const

export type Plan = (typeof PLANS)[number]

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value)
}

/**
 * Modules a plan can grant.
 *
 * A closed union on purpose: an unknown string cannot be smuggled in and cannot silently
 * match nothing while appearing to be enabled.
 */
export const MODULE_KEYS = [
  'CLINICAL',
  'BILLING',
  'ATTENDANCE',
  'PHARMACY',
  'LABORATORY',
  'REPORTS',
] as const

export type ModuleKey = (typeof MODULE_KEYS)[number]

export function isModuleKey(value: unknown): value is ModuleKey {
  return typeof value === 'string' && (MODULE_KEYS as readonly string[]).includes(value)
}

/** Subscription lifecycle. Not the same axis as `Hospital.status` (approval, not payment). */
export const SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'EXPIRED',
  'CANCELLED',
] as const

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

/**
 * Payment confirmation state.
 *
 * Mirrors Phase 8's manual-versus-verified rule exactly, for the same reason: a provider
 * asserting that money arrived is a **claim**, not a fact. `VERIFIED` is only ever set by
 * an explicit reconciliation naming a person, so no adapter can grant itself one.
 */
export const PAYMENT_STATES = ['NONE', 'PENDING', 'VERIFIED', 'FAILED'] as const

export type PaymentState = (typeof PAYMENT_STATES)[number]

export interface PlanDefinition {
  plan: Plan
  label: string
  /** Maximum active staff seats. `null` means unlimited. */
  seatLimit: number | null
  /** Maximum departments. `null` means unlimited. Enforced server-side since Phase 9. */
  departmentLimit: number | null
  /** Modules this plan grants. Anything absent is refused. */
  entitlements: readonly ModuleKey[]
  /** Days of full access before payment is expected. 0 means no trial. */
  trialDays: number
  /**
   * Display price in the hospital's currency, as integer minor units.
   *
   * Integer because `docs/MONEY.md` says every monetary value is, and because this figure
   * starts life as a label on a plan card and ends up on an invoice sooner than anyone
   * expects.
   */
  monthlyPriceMinor: number
  /**
   * Days a tenant keeps access after a payment fails, before suspension.
   *
   * This is the difference between a billing hiccup and a hospital losing access to its
   * own patients mid-shift.
   */
  gracePeriodDays: number
}

/**
 * Plan limits live in the shared package so the client and the server agree on what "on the
 * Starter plan" means, instead of the browser showing a limit the API does not enforce.
 */
export const PLAN_DEFINITIONS: Readonly<Record<Plan, PlanDefinition>> = Object.freeze({
  STARTER: {
    plan: 'STARTER',
    label: 'Starter',
    seatLimit: 3,
    departmentLimit: 2,
    // Billing is the notable exclusion: a three-seat clinic can see its appointments and
    // keep attendance, but cannot run a revenue function.
    entitlements: ['CLINICAL', 'ATTENDANCE'],
    trialDays: 14,
    monthlyPriceMinor: 249_900,
    gracePeriodDays: 7,
  },
  HOSPITAL: {
    plan: 'HOSPITAL',
    label: 'Hospital',
    seatLimit: 50,
    departmentLimit: 25,
    entitlements: ['CLINICAL', 'BILLING', 'ATTENDANCE', 'REPORTS'],
    trialDays: 14,
    monthlyPriceMinor: 799_900,
    gracePeriodDays: 7,
  },
  ENTERPRISE: {
    plan: 'ENTERPRISE',
    label: 'Enterprise',
    seatLimit: null,
    departmentLimit: null,
    entitlements: [...MODULE_KEYS],
    trialDays: 0,
    monthlyPriceMinor: 0,
    gracePeriodDays: 14,
  },
})

export const DEFAULT_PLAN: Plan = 'STARTER'

export function planDefinition(plan: string | null | undefined): PlanDefinition {
  return isPlan(plan) ? PLAN_DEFINITIONS[plan] : PLAN_DEFINITIONS[DEFAULT_PLAN]
}

/** Human label for a plan, falling back to the raw value for an unknown code. */
export function planLabel(plan: string | null | undefined): string {
  return isPlan(plan) ? PLAN_DEFINITIONS[plan].label : (plan ?? 'Unknown')
}

/** Formats a seat limit for display: `null` renders as "Unlimited". */
export function formatLimit(limit: number | null): string {
  return limit === null ? 'Unlimited' : String(limit)
}

/**
 * Does this plan grant this module?
 *
 * `entitlements.includes` rather than a lookup, so a module key that is somehow not in the
 * union cannot match. Unknown input is refused.
 */
export function planGrants(plan: string | null | undefined, moduleKey: unknown): boolean {
  if (!isModuleKey(moduleKey)) return false
  return planDefinition(plan).entitlements.includes(moduleKey)
}

/**
 * Entitlements a status permits.
 *
 * A `SUSPENDED` tenant may still READ — a hospital mid-dispute must be able to look at its
 * own patients, its own stock and its own books. It may not WRITE. Suspending must never
 * be indistinguishable from data loss, and a locked-out hospital with an unreadable
 * patient list is a patient-safety problem, not a billing one.
 *
 * `EXPIRED` and `CANCELLED` deny reads too: the subscription has genuinely ended, and a
 * tenant should be told to renew rather than left browsing a stale copy.
 */
export function statusAllowsRead(status: SubscriptionStatus): boolean {
  return status === 'TRIAL' || status === 'ACTIVE' || status === 'PAST_DUE' || status === 'SUSPENDED'
}

export function statusAllowsWrite(status: SubscriptionStatus): boolean {
  return status === 'TRIAL' || status === 'ACTIVE' || status === 'PAST_DUE'
}

/** A short, honest label. `PAST_DUE` is not a failure state a UI should dress up as normal. */
export function subscriptionStatusLabel(status: SubscriptionStatus): string {
  switch (status) {
    case 'TRIAL':
      return 'Trial'
    case 'ACTIVE':
      return 'Active'
    case 'PAST_DUE':
      return 'Payment overdue'
    case 'SUSPENDED':
      return 'Suspended'
    case 'EXPIRED':
      return 'Expired'
    case 'CANCELLED':
      return 'Cancelled'
  }
}