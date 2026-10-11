/**
 * Subscription plans.
 *
 * SCOPE — Phase 4 covers **plan assignment only**: recording which plan a tenant is on
 * and enforcing the plan's seat limit. There is no payment gateway, no invoicing, no
 * proration and no automatic suspension for non-payment. Nothing here talks to a payment
 * provider, and nothing should be wired to one without a separate security review
 * (docs/SECURITY.md R16).
 */

export const PLANS = ['STARTER', 'HOSPITAL', 'ENTERPRISE'] as const

export type Plan = (typeof PLANS)[number]

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value)
}

export interface PlanDefinition {
  plan: Plan
  label: string
  /** Maximum active staff seats. `null` means unlimited. */
  seatLimit: number | null
  /** Maximum departments. `null` means unlimited. */
  departmentLimit: number | null
  /** Included in the display price. Intended for the UI only — never used for charging. */
  indicativeMonthlyPriceInr: number
}

/**
 * Plan limits are enforced server-side on seat assignment. Storing them in the shared
 * package means the client and the server agree on what "on the Starter plan" means,
 * instead of the browser showing a limit the API does not enforce.
 */
export const PLAN_DEFINITIONS: Readonly<Record<Plan, PlanDefinition>> = Object.freeze({
  STARTER: {
    plan: 'STARTER',
    label: 'Starter',
    seatLimit: 3,
    departmentLimit: 2,
    indicativeMonthlyPriceInr: 2499,
  },
  HOSPITAL: {
    plan: 'HOSPITAL',
    label: 'Hospital',
    seatLimit: 50,
    departmentLimit: 25,
    indicativeMonthlyPriceInr: 7999,
  },
  ENTERPRISE: {
    plan: 'ENTERPRISE',
    label: 'Enterprise',
    seatLimit: null,
    departmentLimit: null,
    indicativeMonthlyPriceInr: 0,
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
