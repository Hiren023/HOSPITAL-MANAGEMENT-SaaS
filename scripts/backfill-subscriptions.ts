/**
 * Backfill subscriptions for hospitals that predate Phase 9.
 *
 * ── Why this is needed, and why it is a script and not automatic code ──────────
 *
 * Phase 9 puts a subscription entitlement in front of every tenant route, and the gate
 * **fails closed**: a hospital with no subscription row is refused. That is the correct
 * behaviour for a brand-new tenant, but it means every hospital that already existed
 * before this release is locked out of its own records the moment the API restarts.
 *
 * Signing in still works. Every screen then returns `403` with "This hospital's
 * subscription has expired", which reads as a broken product rather than as a migration
 * that has not been run.
 *
 * Automatic provisioning at boot was considered and rejected. A gate that quietly creates
 * the thing it is checking for is not a gate — and it would make "no subscription" an
 * unreachable state, which is precisely the state that proves the gate fails closed. The
 * gate is kept honest and the migration is an explicit, auditable step instead.
 *
 * Run once per deployment that skips Phase 8 -> Phase 9. Idempotent: a hospital that
 * already has a subscription is left alone.
 *
 *   npx tsx scripts/backfill-subscriptions.ts                          # dry run
 *   npx tsx scripts/backfill-subscriptions.ts --apply                  # write
 *   npx tsx scripts/backfill-subscriptions.ts --apply --plan=HOSPITAL  # override
 */

import { isPlan, planDefinition, type Plan } from '@infinigrow/shared'

/**
 * The plan given to a hospital whose recorded `plan` is not a known plan.
 *
 * ── Why ENTERPRISE and not the stricter STARTER ─────────────────────────────────
 *
 * "Default to least privilege" is the right rule for a **new** tenant and the wrong rule
 * for a backfill.
 *
 * A hospital with no recorded plan predates Phase 4, which is the phase that introduced
 * plans. Before that, every hospital had every module — there was nothing to restrict.
 * Backfilling such a hospital to STARTER would therefore **remove** capabilities it had
 * been using, and nobody asked for that. A migration must not take away what someone
 * already had.
 *
 * ENTERPRISE is also unlimited on both limits, so nothing is capped either.
 *
 * The failure mode runs the safe way: a hospital is given more than it may ultimately pay
 * for, which costs money and is plainly visible in the console — as opposed to a hospital
 * silently losing billing, which costs trust and is invisible.
 *
 * Override with `--plan=HOSPITAL` when the commercial answer is known.
 */
const DEFAULT_PLAN_FOR_BACKFILL: Plan = 'ENTERPRISE'

/** `--plan=HOSPITAL`, if the operator supplied one. */
const planFlag = process.argv
  .find((argument) => argument.startsWith('--plan='))
  ?.slice('--plan='.length)

import { connectToDatabase } from '../apps/api/src/infrastructure/db/connection.js'
import { ensureIndexes } from '../apps/api/src/infrastructure/db/indexes.js'
import { withPlatformScope } from '../apps/api/src/infrastructure/db/tenant-plugin.js'
import { HospitalModel } from '../apps/api/src/modules/identity/models.js'
import { SubscriptionModel } from '../apps/api/src/modules/subscriptions/subscription.models.js'

type Row = Record<string, unknown>

const APPLY = process.argv.includes('--apply')
const PERIOD_DAYS = 30

const MONGODB_URI = process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27017/'
const DB_NAME = process.env['MONGODB_DB_NAME'] ?? 'infinigrow_dev'

await connectToDatabase(MONGODB_URI, DB_NAME)
await ensureIndexes()

/**
 * A `find().sort().lean()` chain, typed.
 *
 * These models are registered conditionally and exported untyped, and the inline casts
 * this would otherwise need are long enough to be worth naming — one of them was simply
 * malformed on the first attempt, which is the whole argument.
 */
function findSorted<T extends Row>(model: unknown, filter: Row, sort: Row): Promise<T[]> {
  const chain = model as {
    find(f: unknown): { sort(s: unknown): { lean(): { exec(): Promise<T[]> } } }
  }
  return chain.find(filter).sort(sort).lean().exec()
}

function findAll<T extends Row>(model: unknown, filter: Row): Promise<T[]> {
  const chain = model as { find(f: unknown): { lean(): { exec(): Promise<T[]> } } }
  return chain.find(filter).lean().exec()
}

const hospitals = await withPlatformScope(() => findSorted(HospitalModel, { status: 'APPROVED' }, { createdAt: 1 }))
const existing = await withPlatformScope(() => findAll(SubscriptionModel, {}))

const subscribed = new Set(existing.map((row) => String(row['hospitalId'])))
const missing = hospitals.filter((hospital) => !subscribed.has(String(hospital['_id'])))

console.log(
  `Approved hospitals: ${hospitals.length}. With a subscription: ${hospitals.length - missing.length}. Missing: ${missing.length}.`,
)

if (missing.length === 0) {
  console.log('Nothing to do.')
  process.exit(0)
}

for (const hospital of missing) {
  // Reused rather than rebuilt with `new Types.ObjectId(...)`: a lean read already carries
  // a real ObjectId, and reconstructing it would mean importing mongoose from outside
  // `apps/api/src`, which the architecture lint rule correctly forbids.
  const hospitalId = hospital['_id']

  // `Hospital.plan` predates the subscription and is `undefined` on rows written before
  // Phase 4. `isPlan` rejects an arbitrary string rather than letting it through.
  const recorded = hospital['plan']
  const plan = isPlan(recorded) ? recorded : isPlan(planFlag) ? (planFlag as Plan) : DEFAULT_PLAN_FOR_BACKFILL

  if (!isPlan(recorded)) {
    console.log(
      `  ${String(hospital['name'])}: no plan recorded, backfilling as ${plan}. ` +
        `See the header comment for why this is not the strictest plan.`,
    )
  }

  const definition = planDefinition(plan)
  const trialEndsAt =
    definition.trialDays > 0 ? new Date(Date.now() + definition.trialDays * 86_400_000) : null

  console.log(
    `  would create: ${String(hospital['name']).padEnd(32)} plan=${plan.padEnd(11)} ` +
      `trial=${trialEndsAt ? `${definition.trialDays}d` : 'none'} ` +
      `entitlements=${definition.entitlements.join(',')}`,
  )

  if (!APPLY) continue

  await withPlatformScope(async () => {
    const subscriptions = SubscriptionModel as unknown as {
      updateOne(f: unknown, u: unknown, o: unknown): { exec(): Promise<unknown> }
    }

    await subscriptions
      .updateOne(
        { hospitalId: hospitalId },
        {
          $set: {
            hospitalId: hospitalId,
            plan,
            status: trialEndsAt ? 'TRIAL' : 'ACTIVE',
            currentPeriodStartsAt: new Date(),
            currentPeriodEndsAt: new Date(Date.now() + PERIOD_DAYS * 86_400_000),
            trialEndsAt,
            paymentState: 'NONE',
            history: [
              {
                plan,
                status: trialEndsAt ? 'TRIAL' : 'ACTIVE',
                reason: 'Backfilled on upgrade to Phase 9',
                actorKind: 'SYSTEM',
                at: new Date(),
              },
            ],
          },
        },
        // `upsert` rather than a check-then-insert: two operators running this at once
        // must not produce two subscriptions, and the UNIQUE index on `hospitalId` would
        // turn the loser into a crash rather than a silent duplicate. Either way the index
        // is the real guarantee; this just avoids the error.
        { upsert: true },
      )
      .exec()

    if (!isPlan(recorded)) {
      await (
        HospitalModel as unknown as {
          updateOne(f: unknown, u: unknown): { exec(): Promise<unknown> }
        }
      )
        .updateOne(
          { _id: hospitalId },
          { $set: { plan, planChangedAt: new Date() } },
        )
        .exec()
    }
  })
}

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply to write these ${missing.length} subscription(s).`)
} else {
  console.log(`\nWrote ${missing.length} subscription(s).`)
}

process.exit(0)
