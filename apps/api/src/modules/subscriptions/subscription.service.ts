import { Types, type Model } from 'mongoose'
import type { ModuleKey, Permission, SubscriptionStatus } from '@infinigrow/shared'
import {
  PAYMENT_STATES,
  PLANS,
  SUBSCRIPTION_STATUSES,
  formatLimit,
  isModuleKey,
  planDefinition,
  statusAllowsWrite,
} from '@infinigrow/shared'

import { ApiError } from '../../infrastructure/api-error.js'
import { withPlatformScope } from '../../infrastructure/db/tenant-plugin.js'
import { findManyViaAggregate } from '../../utilities/mongo-compat.js'
import { AUDIT_ACTIONS } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'

import { SubscriptionModel } from './subscription.models.js'
import { paymentProvider } from './payment-provider.js'

/**
 * Subscriptions, entitlements and usage.
 *
 * ── Three properties this module exists to guarantee ──────────────────────────
 *
 * 1. **An entitlement is checked on the server, on every route, and fails closed.** A
 *    missing subscription, an unreadable one, or an unknown module key all DENY. A gate
 *    that fails open is a gate that will fail open somewhere.
 *
 * 2. **Status is derived, not typed in.** Trial expiry, overdue and suspension are
 *    consequences of dates plus `paymentState`. `evaluate()` computes them so a status can
 *    never disagree with the dates that justify it.
 *
 * 3. **Suspension never deletes data, and never blocks reads.** A hospital in dispute must
 *    be able to look at its own patients and its own books. Writes stop; reading does not.
 *    A suspended tenant with an unreadable patient list is a patient-safety problem, not a
 *    billing one.
 */

export interface SubscriptionActor {
  userId: string
  role: string
  hospitalId: string
  permissions: Permission[]
}

export interface Meta {
  ip: string
  requestId: string
  /** Recorded on the platform-scope audit entry. Optional so read-only paths need not supply it. */
  actorUserId?: string
  actorRole?: string
}

type Row = Record<string, unknown>

const subscriptionModel = () => SubscriptionModel as unknown as Model<Row>

/** Why access was refused, so the UI can explain itself and a log can prove it. */
export type DenialReason =
  | 'NO_SUBSCRIPTION'
  | 'NOT_ENTITLED'
  | 'SUBSCRIPTION_SUSPENDED'
  | 'SUBSCRIPTION_EXPIRED'
  | 'UNKNOWN_MODULE'

export interface EntitlementContext {
  plan: string
  status: SubscriptionStatus
  entitlements: readonly ModuleKey[]
  mayRead: boolean
  mayWrite: boolean
  /** Present when access is denied. */
  denied?: DenialReason
  trialEndsAt: string | null
  currentPeriodEndsAt: string
  gracePeriodEndsAt: string | null
}

function safeId(value: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw ApiError.notFound()
  return new Types.ObjectId(value)
}

function findMany(model: Model<Row>, match: Row, limit = 1000): Promise<Row[]> {
  return findManyViaAggregate<Row>(model, match, limit)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null
}

/**
 * Run a platform-level operation with tenant scoping lifted, and leave an audit trace.
 *
 * ── Why this wrapper exists ───────────────────────────────────────────────────
 *
 * A SUPER_ADMIN has no hospital membership, so no tenant context is bound to the request
 * and the tenant plugin **throws** rather than defaulting to "all tenants". That default
 * is exactly how a cross-tenant leak happens, so it does not exist.
 *
 * Every platform operation therefore goes through here, which forces two things to happen
 * together: the scope is lifted deliberately, and the grant is recorded. Doing the second
 * without the first would be pointless; doing the first without the second would mean
 * reading across hospitals leaves no trace (docs/SECURITY.md R1).
 *
 * Not re-entrant, matching `withPlatformScope`. Nesting would suggest a control-flow
 * misunderstanding, so the helper refuses it rather than papering over it.
 */
async function asPlatform<T>(operation: string, meta: Meta | undefined, fn: () => Promise<T>): Promise<T> {
  const result = withPlatformScope(fn)

  if (meta) {
    await recordAudit({
      action: AUDIT_ACTIONS.PLATFORM_SCOPE_USED,
      actorUserId: meta.actorUserId ?? '',
      actorRole: meta.actorRole ?? 'SUPER_ADMIN',
      resourceType: 'Subscription',
      resourceId: operation,
      ip: meta.ip,
      requestId: meta.requestId,
      metadata: { operation: `subscription_${operation}` },
    })
  }

  return result
}

// ─────────────────────────── reading state ───────────────────────────

async function loadSubscription(hospitalId: string): Promise<Row | null> {
  const [row] = await findMany(subscriptionModel(), { hospitalId: safeId(hospitalId) }, 1)
  return row ?? null
}

/**
 * Read the entitlement context for a tenant, denying by default.
 *
 * Never throws. A caller that only wants to render a banner should get an answer rather
 * than an exception, and the answer is "no" unless positively proven otherwise.
 */
export async function entitlementContext(hospitalId: string): Promise<EntitlementContext> {
  const row = await loadSubscription(hospitalId)

  const denied: EntitlementContext = {
    plan: 'STARTER',
    status: 'EXPIRED',
    entitlements: [],
    mayRead: false,
    mayWrite: false,
    denied: 'NO_SUBSCRIPTION',
    trialEndsAt: null,
    currentPeriodEndsAt: new Date(0).toISOString(),
    gracePeriodEndsAt: null,
  }

  if (!row) return denied

  const status = String(row['status'] ?? 'EXPIRED') as SubscriptionStatus
  const plan = String(row['plan'] ?? 'STARTER')
  const definition = planDefinition(plan)

  const expired = status === 'EXPIRED' || status === 'CANCELLED'
  const suspended = status === 'SUSPENDED'

  // Reads stop only when the subscription has genuinely ended. PAST_DUE and SUSPENDED
  // both keep read access on purpose.
  const mayRead = !expired
  const mayWrite = statusAllowsWrite(status)

  const context: EntitlementContext = {
    plan,
    status,
    entitlements: definition.entitlements,
    mayRead,
    mayWrite,
    trialEndsAt: iso(row['trialEndsAt']),
    currentPeriodEndsAt: iso(row['currentPeriodEndsAt']) ?? new Date(0).toISOString(),
    gracePeriodEndsAt: iso(row['gracePeriodEndsAt']),
  }

  if (!mayRead) context.denied = 'SUBSCRIPTION_EXPIRED'
  else if (suspended) context.denied = 'SUBSCRIPTION_SUSPENDED'

  return context
}

/**
 * Throw unless this tenant may use this module.
 *
 * Called by services, not by the UI. A hidden menu item is a courtesy; this is the control.
 */
export async function requireEntitlement(
  actor: SubscriptionActor,
  moduleKey: ModuleKey,
): Promise<EntitlementContext> {
  // Fail closed on anything unrecognised. A typo in a module key must not become a
  // silently-enabled module.
  if (!isModuleKey(moduleKey)) {
    throw ApiError.forbidden('That module is not recognised.')
  }

  const context = await entitlementContext(actor.hospitalId)

  if (!context.mayRead) {
    throw ApiError.forbidden(
      context.status === 'SUSPENDED'
        ? 'This hospital’s subscription is suspended. Records remain readable and no data has been removed.'
        : 'This hospital’s subscription has expired. Renew to restore access.',
    )
  }

  if (!context.entitlements.includes(moduleKey)) {
    throw ApiError.forbidden(
      `The ${planDefinition(context.plan).label} plan does not include ${moduleKey.toLowerCase()}. Upgrade to enable it.`,
    )
  }

  return context
}

/** Refuse a write when the subscription does not permit one. */
export function requireWritable(context: EntitlementContext): void {
  if (!context.mayWrite) {
    throw ApiError.forbidden(
      'This hospital’s subscription does not permit changes at the moment. Existing records remain readable.',
    )
  }
}

// ─────────────────────────── the status rules ───────────────────────────

/**
 * Apply the date-driven rules to one subscription.
 *
 * In order, because each depends on the one before:
 *
 * 1. trial ended and never converted → `EXPIRED`
 * 2. period ended without verified payment → `PAST_DUE`, with a grace deadline
 * 3. grace ran out → `SUSPENDED`
 *
 * A subscription that is already `SUSPENDED`, `EXPIRED` or `CANCELLED` is left alone.
 * These are terminal until somebody acts, and a sweep must not quietly un-suspend a
 * tenant that has been cancelled.
 */
export function deriveStatus(
  subscription: Row,
  now: Date = new Date(),
): { status: SubscriptionStatus; gracePeriodEndsAt: Date | null } {
  const current = String(subscription['status']) as SubscriptionStatus

  if (current === 'SUSPENDED' || current === 'EXPIRED' || current === 'CANCELLED') {
    return { status: current, gracePeriodEndsAt: null }
  }

  const paymentState = String(subscription['paymentState'] ?? 'NONE')
  const periodEndsAt = subscription['currentPeriodEndsAt']
  const trialEndsAt = subscription['trialEndsAt']
  const definition = planDefinition(String(subscription['plan']))

  // A trial that ran out without payment. Data is untouched; access is what stops.
  if (trialEndsAt instanceof Date && now >= trialEndsAt && paymentState !== 'VERIFIED') {
    return { status: 'EXPIRED', gracePeriodEndsAt: null }
  }

  if (!(periodEndsAt instanceof Date) || now < periodEndsAt) {
    return { status: current === 'TRIAL' ? 'TRIAL' : 'ACTIVE', gracePeriodEndsAt: null }
  }

  // The period ended. Verified payment means it renewed quietly; anything else is overdue.
  if (paymentState === 'VERIFIED') {
    return { status: 'ACTIVE', gracePeriodEndsAt: null }
  }

  const graceEndsAt =
    subscription['gracePeriodEndsAt'] instanceof Date
      ? (subscription['gracePeriodEndsAt'] as Date)
      : new Date(periodEndsAt.getTime() + definition.gracePeriodDays * 86_400_000)

  if (now >= graceEndsAt) {
    return { status: 'SUSPENDED', gracePeriodEndsAt: graceEndsAt }
  }

  return { status: 'PAST_DUE', gracePeriodEndsAt: graceEndsAt }
}

/**
 * Run the rules now.
 *
 * Idempotent: running it twice changes nothing the second time. That matters because it is
 * invoked from a sweep, from the platform UI, and from a status endpoint a user refreshes
 * — and an endpoint that behaved differently on a second call would be impossible to reason
 * about.
 */
export async function evaluateSubscription(
  hospitalId: string,
  now: Date = new Date(),
  meta?: Meta,
): Promise<{ changed: boolean; status: SubscriptionStatus }> {
  // Always lifted. A sweep runs on the platform's behalf across every tenant, and the
  // tenant plugin would otherwise throw for every one of them — which is the correct
  // behaviour for an accidental cross-tenant read and the wrong one for a deliberate,
  // audited sweep.
  return asPlatform('evaluate_subscription', meta, async () => {
    const row = await loadSubscription(hospitalId)
    if (!row) return { changed: false, status: 'EXPIRED' as SubscriptionStatus }

    const derived = deriveStatus(row, now)
    const current = String(row['status']) as SubscriptionStatus

    if (derived.status === current) {
      // The grace deadline may still need recording even when the status is unchanged.
      if (derived.gracePeriodEndsAt && !(row['gracePeriodEndsAt'] instanceof Date)) {
        await subscriptionModel().updateOne(
          { _id: row['_id'] },
          { $set: { gracePeriodEndsAt: derived.gracePeriodEndsAt } },
        )
      }
      return { changed: false, status: current }
    }

    await subscriptionModel().updateOne(
      { _id: row['_id'] },
      {
        $set: {
          status: derived.status,
          gracePeriodEndsAt: derived.gracePeriodEndsAt,
          ...(derived.status === 'SUSPENDED' ? { suspendedAt: now } : {}),
        },
        $push: {
          history: {
            status: derived.status,
            reason: `Set automatically: ${derived.status.toLowerCase().replace('_', ' ')}.`,
            actorKind: 'SYSTEM',
            at: now,
          },
        },
      },
    )

    return { changed: true, status: derived.status }
  })
}

// ─────────────────────────── platform management ───────────────────────────

export async function assignPlan(
  actor: SubscriptionActor,
  meta: Meta,
  hospitalId: string,
  input: {
    plan: string
    startTrial?: boolean
    periodDays?: number
    reason?: string
  },
): Promise<unknown> {
  if (!(PLANS as readonly string[]).includes(input.plan)) {
    throw ApiError.badRequest('That is not a plan this platform offers')
  }

  const now = new Date()
  const definition = planDefinition(input.plan)
  const periodDays = Math.max(1, Math.min(366, input.periodDays ?? 30))

  const usesTrial = input.startTrial === true && definition.trialDays > 0
  const periodEnd = new Date(now.getTime() + periodDays * 86_400_000)
  const trialEnd = usesTrial ? new Date(now.getTime() + definition.trialDays * 86_400_000) : null

  const status: SubscriptionStatus = usesTrial ? 'TRIAL' : 'ACTIVE'

  const history = [
    {
      plan: input.plan,
      status,
      reason: input.reason ?? 'Plan assigned',
      actorUserId: safeId(actor.userId),
      actorKind: 'USER',
      at: now,
    },
  ]

  await asPlatform('assign_plan', meta, async () => {
    await subscriptionModel().updateOne(
      { hospitalId: safeId(hospitalId) },
      {
        $set: {
          plan: input.plan,
          status,
          currentPeriodStartsAt: now,
          currentPeriodEndsAt: periodEnd,
          trialEndsAt: trialEnd ?? undefined,
          gracePeriodEndsAt: null,
          suspendedAt: null,
          cancelAtPeriodEnd: false,
          paymentState: 'NONE',
          updatedByUserId: safeId(actor.userId),
        },
        $setOnInsert: { createdByUserId: safeId(actor.userId) },
        $push: { history: { $each: history } },
      },
      { upsert: true },
    )

    // `Hospital.plan` is what Phase 4 reads and what the nav shows. Keeping the two in
    // step here means there is one writer rather than two that can disagree — and the
    // gate reads the subscription, so a divergence would show the hospital one set of
    // capabilities and enforce another.
    //
    // `hospitalId` is NOT in the `$set`: `stripTenantFromUpdates` removes it, and the
    // query filter is what selects the document.
    const { HospitalModel } = await import('../identity/models.js')
    await (
      HospitalModel as unknown as {
        updateOne(q: unknown, u: unknown): { exec(): Promise<unknown> }
      }
    )
      .updateOne(
        { _id: safeId(hospitalId) },
        { $set: { plan: input.plan, planChangedAt: now, planChangedBy: safeId(actor.userId) } },
      )
      .exec()

  })

  return await readSubscriptionForPlatform(actor, meta, hospitalId)
}

export async function updateSubscription(
  actor: SubscriptionActor,
  meta: Meta,
  hospitalId: string,
  input: {
    plan?: string
    cancelAtPeriodEnd?: boolean
    cancelNow?: boolean
    reactivate?: boolean
    reason?: string
  },
): Promise<unknown> {
  await asPlatform('update_subscription', meta, async () => {
    const row = await loadSubscription(hospitalId)
    if (!row) throw ApiError.notFound()

    const now = new Date()
    const set: Row = { updatedByUserId: safeId(actor.userId) }
    const history: Row[] = []

    if (input.plan) {
      if (!(PLANS as readonly string[]).includes(input.plan)) {
        throw ApiError.badRequest('That is not a plan this platform offers')
      }
      set['plan'] = input.plan
      history.push({
        plan: input.plan,
        reason: input.reason ?? `Plan changed to ${input.plan}`,
        actorUserId: safeId(actor.userId),
        actorKind: 'USER',
        at: now,
      })
    }

    if (input.cancelAtPeriodEnd !== undefined) {
      set['cancelAtPeriodEnd'] = input.cancelAtPeriodEnd
    }

    if (input.reactivate) {
      // Reactivation clears the suspension but does NOT invent a payment. The subscription
      // goes to PAST_DUE and runs its own grace period, because somebody still has to
      // confirm that money arrived. Un-suspending is not paying.
      set['status'] = 'PAST_DUE'
      set['suspendedAt'] = null
      const periodEnd = row['currentPeriodEndsAt']
      set['gracePeriodEndsAt'] =
        periodEnd instanceof Date
          ? new Date(periodEnd.getTime() + 86_400_000 * 14)
          : new Date(now.getTime() + 14 * 86_400_000)
      history.push({
        status: 'PAST_DUE',
        reason: input.reason ?? 'Reactivated pending payment',
        actorUserId: safeId(actor.userId),
        actorKind: 'USER',
        at: now,
      })
    }

    if (input.cancelNow) {
      set['status'] = 'CANCELLED'
      history.push({
        status: 'CANCELLED',
        reason: input.reason ?? 'Cancelled',
        actorUserId: safeId(actor.userId),
        actorKind: 'USER',
        at: now,
      })

      const providerRef = str(row['providerSubscriptionId'])
      if (providerRef) {
        // Best-effort, and deliberately swallowed. A provider that cannot cancel must not
        // block recording the fact that WE cancelled; retrying the local state forever
        // because a remote call failed would leave the tenant in a limbo nobody can fix.
        try {
          await paymentProvider().cancelSubscription(providerRef)
        } catch {
          // The local record is the source of truth for our own state.
        }
      }
    }

    await subscriptionModel().updateOne(
      { _id: row['_id'] },
      {
        $set: set,
        ...(history.length > 0 ? { $push: { history: { $each: history } } } : {}),
      },
    )

    if (input.plan) {
      const { HospitalModel } = await import('../identity/models.js')
      await (
        HospitalModel as unknown as {
          updateOne(q: unknown, u: unknown): { exec(): Promise<unknown> }
        }
      )
        .updateOne(
          { _id: safeId(hospitalId) },
          { $set: { plan: input.plan, planChangedAt: now, planChangedBy: safeId(actor.userId) } },
        )
        .exec()
    }
  })

  return await readSubscriptionForPlatform(actor, meta, hospitalId)
}

/**
 * Reconcile a payment.
 *
 * The ONLY path to `VERIFIED`, and it is a person acting. No adapter can reach it — see
 * `payment-provider.ts`.
 */
export async function reconcilePayment(
  actor: SubscriptionActor,
  meta: Meta,
  hospitalId: string,
  input: {
    paymentState: 'VERIFIED' | 'FAILED' | 'PENDING'
    providerSubscriptionId?: string
    reason?: string
  },
): Promise<unknown> {
  await asPlatform('reconcile_payment', meta, async () => {
    const row = await loadSubscription(hospitalId)
    if (!row) throw ApiError.notFound()

    const now = new Date()

    const set: Row = {
      paymentState: input.paymentState,
      updatedByUserId: safeId(actor.userId),
    }

    if (input.providerSubscriptionId) {
      set['providerSubscriptionId'] = input.providerSubscriptionId
      set['provider'] = paymentProvider().name
    }

    // A verified payment clears a lapse and rolls the period forward a month.
    if (input.paymentState === 'VERIFIED') {
      const currentEnd = row['currentPeriodEndsAt']
      const base = currentEnd instanceof Date && currentEnd > now ? currentEnd : now
      set['currentPeriodStartsAt'] = base
      set['currentPeriodEndsAt'] = new Date(base.getTime() + 30 * 86_400_000)
      set['trialEndsAt'] = null
      set['gracePeriodEndsAt'] = null
      set['suspendedAt'] = null
      set['status'] = 'ACTIVE'
      set['cancelAtPeriodEnd'] = false
    }

    if (input.paymentState === 'FAILED') {
      const periodEnd = row['currentPeriodEndsAt']
      const base = periodEnd instanceof Date ? periodEnd : now
      set['gracePeriodEndsAt'] = new Date(base.getTime() + 86_400_000 * 7)
    }

    await subscriptionModel().updateOne(
      { _id: row['_id'] },
      {
        $set: set,
        $push: {
          history: {
            status: str(row['status']),
            reason: `Payment ${input.paymentState.toLowerCase()}${input.reason ? `: ${input.reason}` : ''}`,
            actorUserId: safeId(actor.userId),
            actorKind: 'USER',
            at: now,
          },
        },
      },
    )
  })

  return await readSubscriptionForPlatform(actor, meta, hospitalId)
}

export async function readSubscriptionForPlatform(
  _actor: SubscriptionActor,
  meta: Meta,
  hospitalId: string,
): Promise<unknown> {
  const row = await asPlatform('read_subscription', meta, async () => loadSubscription(hospitalId))
  if (!row) throw ApiError.notFound()

  return {
    id: String(row['_id']),
    hospitalId: String(row['hospitalId']),
    plan: row['plan'],
    status: row['status'],
    paymentState: row['paymentState'],
    provider: row['provider'] ?? null,
    providerSubscriptionId: row['providerSubscriptionId'] ?? null,
    currentPeriodStartsAt: iso(row['currentPeriodStartsAt']),
    currentPeriodEndsAt: iso(row['currentPeriodEndsAt']),
    trialEndsAt: iso(row['trialEndsAt']),
    gracePeriodEndsAt: iso(row['gracePeriodEndsAt']),
    suspendedAt: iso(row['suspendedAt']),
    cancelAtPeriodEnd: Boolean(row['cancelAtPeriodEnd']),
    entitlements: planDefinition(String(row['plan'])).entitlements,
    history: Array.isArray(row['history'])
      ? (row['history'] as Row[]).map((entry) => ({
          plan: entry['plan'] ?? null,
          status: entry['status'] ?? null,
          reason: entry['reason'] ?? null,
          actorUserId: entry['actorUserId'] ? String(entry['actorUserId']) : null,
          actorKind: entry['actorKind'] ?? null,
          at: iso(entry['at']),
        }))
      : [],
  }
}

// ─────────────────────────── tenant view ───────────────────────────

/**
 * What a hospital administrator sees: plan, entitlements, usage and renewal.
 *
 * Never 404s. A tenant with no subscription gets an explicit "none configured" answer,
 * because an empty list would read as "you have nothing" rather than "we do not know",
 * and the operator needs to see the difference.
 */
export async function readOwnSubscription(actor: SubscriptionActor): Promise<unknown> {
  const context = await entitlementContext(actor.hospitalId)
  const row = await loadSubscription(actor.hospitalId)
  const usage = await readUsage(actor.hospitalId, context.plan)

  const { HospitalModel } = await import('../identity/models.js')
  const hospital = await (
    HospitalModel as unknown as {
      findById(id: unknown): { lean(): { exec(): Promise<Row | null> } }
    }
  )
    .findById(safeId(actor.hospitalId))
    .lean()
    .exec()

  return {
    configured: row !== null,
    plan: context.plan,
    planLabel: planDefinition(context.plan).label,
    status: context.status,
    paymentState: row ? row['paymentState'] : 'NONE',
    entitlements: context.entitlements,
    mayRead: context.mayRead,
    mayWrite: context.mayWrite,
    denied: context.denied ?? null,
    trialEndsAt: context.trialEndsAt,
    currentPeriodEndsAt: context.currentPeriodEndsAt,
    gracePeriodEndsAt: context.gracePeriodEndsAt,
    suspendedAt: iso(row?.['suspendedAt']),
    cancelAtPeriodEnd: Boolean(row?.['cancelAtPeriodEnd']),
    limits: {
      seats: planDefinition(context.plan).seatLimit,
      departments: planDefinition(context.plan).departmentLimit,
    },
    usage,
    hospitalName: (hospital?.['name'] as string | undefined) ?? null,
  }
}

/** Just the module keys, for the shell to decide what to render. */
export async function readOwnEntitlements(actor: SubscriptionActor): Promise<unknown> {
  const context = await entitlementContext(actor.hospitalId)
  return {
    plan: context.plan,
    status: context.status,
    mayRead: context.mayRead,
    mayWrite: context.mayWrite,
    entitlements: context.entitlements,
  }
}

// ─────────────────────────── usage ───────────────────────────

/**
 * Read live usage against the plan's limits.
 *
 * ── Counted, not cached ───────────────────────────────────────────────────────
 *
 * This was originally a `UsageCounter` collection, written on plan assignment. It was
 * removed, and the reason is worth keeping:
 *
 * A stored counter has to be updated on **every** path that changes what it counts — new
 * staff, deleted staff, a deactivated membership, a role change, a reactivation. Miss one
 * and the cache disagrees with reality, and the screen says "3 of 3 seats" while four
 * people hold seats. A usage figure that can be wrong is worse than a slightly slower
 * one, because it is presented with the same confidence either way.
 *
 * Two indexed `countDocuments` calls on one screen is not a performance problem. The
 * collection, its index and the code that could drift are all gone.
 *
 * ── Keyed by module because the UI already thinks in modules ───────────────────
 *
 * `CLINICAL` holds seats and `ATTENDANCE` holds departments, which looks odd until you
 * notice the client renders a usage card per module. Keying by resource (`seats`,
 * `departments`) and having the UI map that onto a card is clearer, so that is what this
 * returns; the mapping lives in `SubscriptionPage` where the labels are.
 */
async function readUsage(
  hospitalId: string,
  plan: string,
): Promise<Record<string, { used: number; limit: number | null; displayLimit: string }>> {
  const definition = planDefinition(plan)

  const [seats, departments] = await Promise.all([
    countSeats(hospitalId),
    countDepartments(hospitalId),
  ])

  return {
    seats: entry(seats, definition.seatLimit),
    departments: entry(departments, definition.departmentLimit),
  }
}

function entry(used: number, limit: number | null) {
  return { used, limit, displayLimit: formatLimit(limit) }
}

async function countSeats(hospitalId: string): Promise<number> {
  const { MembershipModel } = await import('../identity/models.js')
  const rows = await (
    MembershipModel as unknown as {
      aggregate<T>(stages: unknown[]): { exec(): Promise<T[]> }
    }
  )
    .aggregate<{ count: number }>([
      { $match: { hospitalId: safeId(hospitalId), status: 'ACTIVE' } },
      { $count: 'count' },
    ])
    .exec()

  return rows[0]?.count ?? 0
}

async function countDepartments(hospitalId: string): Promise<number> {
  const { DepartmentModel } = await import('../hospital-admin/hospital-admin.models.js')
  const rows = await (
    DepartmentModel as unknown as {
      aggregate<T>(stages: unknown[]): { exec(): Promise<T[]> }
    }
  )
    .aggregate<{ count: number }>([
      { $match: { hospitalId: safeId(hospitalId) } },
      { $count: 'count' },
    ])
    .exec()

  return rows[0]?.count ?? 0
}

/**
 * Would adding one more seat or department exceed the plan?
 *
 * Returns the refusal rather than throwing, because callers need to build a specific
 * error naming the limit they hit — "You have used 2 of 2 departments" is actionable and
 * "limit reached" is not.
 */
export async function checkLimit(
  hospitalId: string,
  kind: 'SEATS' | 'DEPARTMENTS',
  adding: number,
): Promise<{ allowed: boolean; limit: number | null; used: number; message?: string }> {
  const row = await loadSubscription(hospitalId)
  const definition = planDefinition(row ? String(row['plan']) : 'STARTER')
  const limit = kind === 'SEATS' ? definition.seatLimit : definition.departmentLimit

  // `null` is unlimited. An unlimited plan is not an unlimited-number plan with a null
  // limit — it is no limit at all.
  if (limit === null) return { allowed: true, limit: null, used: 0 }

  const used =
    kind === 'SEATS' ? await countSeats(hospitalId) : await countDepartments(hospitalId)

  if (used + adding > limit) {
    const noun = kind === 'SEATS' ? 'staff seat' : 'department'
    return {
      allowed: false,
      limit,
      used,
      message: `The ${definition.label} plan includes ${limit} ${noun}${limit === 1 ? '' : 's'}. This hospital already has ${used}. Upgrade to add more.`,
    }
  }

  return { allowed: true, limit, used }
}

export { PAYMENT_STATES, SUBSCRIPTION_STATUSES }