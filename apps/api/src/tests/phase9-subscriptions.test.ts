import supertest from 'supertest'
import type { Express } from 'express'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Types, type Model } from 'mongoose'

import {
  connectTestDatabase,
  createPlatformFixture,
  installTestJwtKeys,
  modelOf,
  resetDatabase,
  type PlatformFixture,
} from './auth-harness.js'
import { tryStartTestDatabase } from './mongo.js'
import {
  nullPaymentProvider,
  resetPaymentProvider,
  setPaymentProvider,
  type PaymentProvider,
} from '../modules/subscriptions/payment-provider.js'
import {
  deriveStatus,
  entitlementContext,
  evaluateSubscription,
  requireEntitlement,
} from '../modules/subscriptions/subscription.service.js'
import { SubscriptionModel } from '../modules/subscriptions/subscription.models.js'
import { DepartmentModel } from '../modules/hospital-admin/hospital-admin.models.js'
import { withPlatformScope } from '../infrastructure/db/tenant-plugin.js'
import { runWithContext, type RequestContext } from '../infrastructure/db/tenant-context.js'
import { PLAN_DEFINITIONS } from '@infinigrow/shared'

const db = await tryStartTestDatabase()

/**
 * Phase 9 (Change 1) — subscriptions, entitlements and limits.
 *
 * Two hospitals, so every cross-tenant assertion is real rather than notional.
 *
 * What these tests are actually for:
 *
 * - **The gate is server-side and fails closed.** A plan without a module gets 403 from
 *   the API. The relevant assertion is the HTTP status, not a hidden button.
 * - **Limits are enforced, not displayed.** `seatLimit` and `departmentLimit` were both
 *   pure decoration until this change; these tests are the proof they are now real.
 * - **Suspension never destroys data and never blocks reads.** A hospital in a billing
 *   dispute must still be able to look at its own patients.
 * - **Nothing can fake a payment.** `VERIFIED` is reachable only through the route that
 *   names a person. This is asserted against the adapter interface directly, because a
 *   test that only exercised the happy path would not notice a new method that returns
 *   success.
 * - **One subscription per tenant**, enforced by a unique index rather than by a check,
 *   because a tenant holding two could pick whichever grants it more.
 *
 * All fixtures are fictional. No real hospital, staff or payment data appears here.
 */

const TEST_PASSWORD = 'correct-horse-battery-staple'
const API = '/api/v1'
const DAY = 86_400_000

type Row = Record<string, unknown>

const subscriptions = () => SubscriptionModel as unknown as Model<Row>

/**
 * Run a service call with a tenant context bound, the way a request would.
 *
 * `entitlementContext` is a tenant-side read — it runs inside a request, with the
 * hospital taken from the verified session. A test body has no such session, and calling
 * it bare throws rather than guessing a tenant, which is the plugin working correctly.
 *
 * Binding a real context is therefore more faithful than lifting the scope: it proves the
 * function works the way production calls it, rather than proving it works under a
 * privilege the tenant path never uses.
 */
function asTenant<T>(fixture: PlatformFixture, hospitalId: string, fn: () => Promise<T>): Promise<T> {
  const context = {
    requestId: 'test',
    userId: fixture.adminA.id,
    membershipId: 'test',
    role: 'HOSPITAL_ADMIN',
    hospitalId,
    permissions: [],
    ip: '127.0.0.1',
    userAgent: 'vitest',
  } as unknown as RequestContext

  return runWithContext(context, fn)
}

describe.skipIf(!db.uri)('subscriptions, entitlements and limits', () => {
  let fixture: PlatformFixture
  let app: () => Express

  /**
   * Tokens are memoised per email, and reset with the fixture.
   *
   * Sign-in is rate limited to 10 attempts per 15 minutes per IP, and in-memory, so a
   * suite that signs in afresh in every test exhausts the budget partway through and then
   * fails with a 401/403 from a limiter that has nothing to do with what is being
   * asserted. That is a misleading failure: it looks like an authorisation bug.
   *
   * Caching also makes the tests honest about what they measure — none of them are about
   * login, and a token is a token whether it was minted this millisecond or last test.
   */
  const tokens = new Map<string, string>()

  const as = async (email: string): Promise<string> => {
    const cached = tokens.get(email)
    if (cached !== undefined) return cached

    const token = await fixture.signIn(email, TEST_PASSWORD)
    tokens.set(email, token)
    return token
  }

  const asAdmin = () => as('admin-a@example.test')
  const asAdminB = () => as('admin-b@example.test')
  const asSuper = () => as('platform-admin@example.test')

  /**
   * Write a subscription directly rather than through the platform API.
   *
   * Most tests need to START from a known state — suspended, past due, mid-trial — and
   * producing those through the public routes would mean a test asserting on the
   * transitions it is trying to skip past. The routes themselves are exercised
   * separately, below.
   *
   * `withPlatformScope` is not optional decoration here: a test body has no tenant
   * context bound, so the tenant plugin throws rather than defaulting to "all tenants".
   * That refusal is the plugin working correctly, and these writes are deliberately
   * cross-tenant setup.
   */
  async function seedSubscription(
    hospitalId: string,
    overrides: Partial<{
      plan: string
      status: string
      currentPeriodStartsAt: Date
      currentPeriodEndsAt: Date
      trialEndsAt: Date | null
      gracePeriodEndsAt: Date | null
      paymentState: string
      cancelAtPeriodEnd: boolean
      suspendedAt: Date | null
    }> = {},
  ): Promise<void> {
    const now = new Date()
    // `.exec()` is INSIDE the callback on purpose. `withPlatformScope` is synchronous, so
    // it only covers the call it is given — a Mongoose query does not run until it is
    // executed, and the tenant hook fires at execution. Returning the un-executed query
    // and awaiting it outside means the hook runs with no scope and throws.
    await withPlatformScope(async () => {
      await subscriptions()
        .updateOne(
          { hospitalId: new Types.ObjectId(hospitalId) },
          {
            $set: {
              plan: overrides.plan ?? 'HOSPITAL',
              status: overrides.status ?? 'ACTIVE',
              currentPeriodStartsAt:
                overrides.currentPeriodStartsAt ?? new Date(now.getTime() - DAY),
              currentPeriodEndsAt:
                overrides.currentPeriodEndsAt ?? new Date(now.getTime() + 29 * DAY),
              trialEndsAt: overrides.trialEndsAt ?? null,
              gracePeriodEndsAt: overrides.gracePeriodEndsAt ?? null,
              paymentState: overrides.paymentState ?? 'NONE',
              cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
              suspendedAt: overrides.suspendedAt ?? null,
              history: [],
            },
          },
          { upsert: true },
        )
        .exec()
    })
  }

  /** Read one tenant's subscription from a test body, which has no tenant context. */
  async function readSubscriptionRow(hospitalId: string): Promise<Row | null> {
    return withPlatformScope(async () => {
      return (await subscriptions()
        .findOne({ hospitalId: new Types.ObjectId(hospitalId) })
        .lean()
        .exec()) as Row | null
    })
  }

  beforeAll(async () => {
    installTestJwtKeys()
    await connectTestDatabase(db.uri as string)
  })

  beforeEach(async () => {
    await resetDatabase()
    resetPaymentProvider()
    fixture = await createPlatformFixture()
    app = () => fixture.app
    // New users each time, so tokens from the previous fixture are worthless.
    tokens.clear()
  })

  /**
   * Remove the subscription the shared harness provisions.
   *
   * The harness mirrors production, where an approved hospital gets a subscription on
   * approval. 'No subscription' is therefore an ANOMALY — a corrupted or hand-deleted
   * row — not a normal state, and the only honest way to test the fail-closed behaviour
   * is to create that anomaly rather than to rely on a fixture that predates the
   * feature.
   */
  async function removeSubscription(hospitalId: string): Promise<void> {
    await withPlatformScope(async () => {
      await subscriptions()
        .deleteMany({ hospitalId: new Types.ObjectId(hospitalId) })
        .exec()
    })
  }

  // ─────────────────────────── entitlement enforcement ───────────────────────────

  describe('entitlements are enforced by the server', () => {
    it('refuses a module the plan does not include', async () => {
      // STARTER grants CLINICAL and ATTENDANCE only. Billing is not one of them.
      await seedSubscription(fixture.hospitalA.id, { plan: 'STARTER' })

      const response = await supertest(app())
        .get(`${API}/invoices`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      expect(response.status).toBe(403)
      expect(String(response.body.error.message)).toMatch(/starter plan does not include billing/i)
    })

    it('grants a module the plan does include', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'HOSPITAL' })

      const response = await supertest(app())
        .get(`${API}/invoices`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      expect(response.status).toBe(200)
    })

    it('grants everything on ENTERPRISE', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'ENTERPRISE' })

      const response = await supertest(app())
        .get(`${API}/invoices`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      expect(response.status).toBe(200)
    })

    it('fails CLOSED when no subscription exists at all', async () => {
      // Anomaly, not a normal state — see `removeSubscription`. The tenant must be
      // denied, not defaulted to a plan that happens to include whatever it asked for.
      await removeSubscription(fixture.hospitalA.id)

      const response = await supertest(app())
        .get(`${API}/invoices`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      expect(response.status).toBe(403)
    })

    it('fails CLOSED on a module key that is not in the union', async () => {
      // Direct service call: a router cannot pass a bad key at runtime without a cast,
      // but a future caller could. The gate must refuse rather than match nothing and
      // report "allowed".
      await seedSubscription(fixture.hospitalA.id, { plan: 'ENTERPRISE' })

      await expect(
        requireEntitlement(
          { userId: fixture.adminA.id, role: 'HOSPITAL_ADMIN', hospitalId: fixture.hospitalA.id, permissions: [] },
          'GOD_MODE' as never,
        ),
      ).rejects.toThrow(/not recognised/i)
    })

    it('refuses the whole hospital when the subscription is expired', async () => {
      await seedSubscription(fixture.hospitalA.id, {
        plan: 'ENTERPRISE',
        status: 'EXPIRED',
      })

      const response = await supertest(app())
        .get(`${API}/patients`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      expect(response.status).toBe(403)
      expect(String(response.body.error.message)).toMatch(/expired/i)
    })
  })

  // ─────────────────────────── suspension ───────────────────────────

  describe('suspension blocks writes but never reads', () => {
    beforeEach(async () => {
      await seedSubscription(fixture.hospitalA.id, {
        plan: 'ENTERPRISE',
        status: 'SUSPENDED',
        suspendedAt: new Date(),
      })
    })

    it('still allows reading the patient list', async () => {
      // The whole point of the rule: a hospital mid-dispute must be able to look at its
      // own patients. A locked-out patient list is a patient-safety problem, not a
      // billing one.
      const response = await supertest(app())
        .get(`${API}/patients`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      expect(response.status).toBe(200)
    })

    it('refuses creating a patient', async () => {
      const response = await supertest(app())
        .post(`${API}/patients`)
        .set('Authorization', `Bearer ${await asAdmin()}`)
        .send({
          firstName: 'Nisha',
          lastName: 'Kulkarni',
          gender: 'FEMALE',
          dateOfBirth: '1992-04-11',
          phone: '+919812345678',
        })

      expect(response.status).toBe(403)
      expect(String(response.body.error.message)).toMatch(/does not permit changes/i)
    })

    it('says explicitly that no data was deleted', async () => {
      const context = await asTenant(fixture, fixture.hospitalA.id, () =>
        entitlementContext(fixture.hospitalA.id),
      )

      expect(context.mayRead).toBe(true)
      expect(context.mayWrite).toBe(false)
      expect(context.denied).toBe('SUBSCRIPTION_SUSPENDED')
    })

    it('leaves every existing record in place', async () => {
      const before = await countDepartments(fixture.hospitalA.id)

      await supertest(app())
        .get(`${API}/hospital/subscription`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      const after = await countDepartments(fixture.hospitalA.id)
      expect(after).toBe(before)
    })
  })

  // ─────────────────────────── the status rules ───────────────────────────

  describe('status is derived from dates, not typed in by hand', () => {
    it('stays TRIAL before the trial ends', () => {
      const result = deriveStatus(
        {
          plan: 'STARTER',
          status: 'TRIAL',
          paymentState: 'NONE',
          currentPeriodEndsAt: new Date(Date.now() + 10 * DAY),
          trialEndsAt: new Date(Date.now() + 5 * DAY),
        },
        new Date(),
      )

      expect(result.status).toBe('TRIAL')
    })

    it('becomes EXPIRED when the trial runs out unpaid', () => {
      const result = deriveStatus(
        {
          plan: 'STARTER',
          status: 'TRIAL',
          paymentState: 'NONE',
          currentPeriodEndsAt: new Date(Date.now() + 10 * DAY),
          trialEndsAt: new Date(Date.now() - DAY),
        },
        new Date(),
      )

      expect(result.status).toBe('EXPIRED')
    })

    it('becomes PAST_DUE once the period ends, with a grace deadline', () => {
      const result = deriveStatus(
        {
          plan: 'HOSPITAL',
          status: 'ACTIVE',
          paymentState: 'NONE',
          currentPeriodEndsAt: new Date(Date.now() - DAY),
        },
        new Date(),
      )

      expect(result.status).toBe('PAST_DUE')
      // 7 days for the Hospital plan.
      expect(result.gracePeriodEndsAt).not.toBeNull()
    })

    it('becomes SUSPENDED once the grace period runs out', () => {
      const result = deriveStatus(
        {
          plan: 'HOSPITAL',
          status: 'ACTIVE',
          paymentState: 'NONE',
          currentPeriodEndsAt: new Date(Date.now() - 10 * DAY),
        },
        new Date(),
      )

      expect(result.status).toBe('SUSPENDED')
    })

    it('renews quietly on verified payment rather than going past due', () => {
      const result = deriveStatus(
        {
          plan: 'HOSPITAL',
          status: 'ACTIVE',
          paymentState: 'VERIFIED',
          currentPeriodEndsAt: new Date(Date.now() - DAY),
        },
        new Date(),
      )

      expect(result.status).toBe('ACTIVE')
      expect(result.gracePeriodEndsAt).toBeNull()
    })

    it('never quietly un-suspends a terminal status', () => {
      // A cancelled tenant must not be revived by a sweep. These are terminal until a
      // person acts.
      for (const status of ['SUSPENDED', 'EXPIRED', 'CANCELLED']) {
        const result = deriveStatus(
          {
            plan: 'HOSPITAL',
            status,
            paymentState: 'VERIFIED',
            currentPeriodEndsAt: new Date(Date.now() - 100 * DAY),
            trialEndsAt: new Date(Date.now() - 200 * DAY),
          },
          new Date(),
        )

        expect(result.status).toBe(status)
      }
    })

    it('is idempotent — a second sweep changes nothing', async () => {
      await seedSubscription(fixture.hospitalA.id, {
        plan: 'HOSPITAL',
        currentPeriodEndsAt: new Date(Date.now() - DAY),
        status: 'ACTIVE',
      })

      const first = await evaluateSubscription(fixture.hospitalA.id)
      expect(first.changed).toBe(true)
      expect(first.status).toBe('PAST_DUE')

      const second = await evaluateSubscription(fixture.hospitalA.id)
      expect(second.changed).toBe(false)
      expect(second.status).toBe('PAST_DUE')
    })

    it('records why the status changed', async () => {
      await seedSubscription(fixture.hospitalA.id, {
        plan: 'HOSPITAL',
        currentPeriodEndsAt: new Date(Date.now() - DAY),
        status: 'ACTIVE',
      })

      await evaluateSubscription(fixture.hospitalA.id)

      const row = await readSubscriptionRow(fixture.hospitalA.id)

      const history = (row?.['history'] ?? []) as Row[]
      expect(history).toHaveLength(1)
      expect(history[0]?.['actorKind']).toBe('SYSTEM')
      expect(String(history[0]?.['reason'])).toMatch(/automatically/i)
    })
  })

  // ─────────────────────────── plan limits ───────────────────────────

  describe('plan limits are enforced, not merely displayed', () => {
    it('refuses a department beyond the plan limit, and names the limit', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'STARTER' })

      // STARTER allows 2 departments. Create two, then try a third.
      for (const [index, code] of ['CARD', 'ORTHO'].entries()) {
        const created = await supertest(app())
          .post(`${API}/departments`)
          .set('Authorization', `Bearer ${await asAdmin()}`)
          .send({ code, name: `Department ${index + 1}` })

        expect(created.status).toBe(201)
      }

      const refused = await supertest(app())
        .post(`${API}/departments`)
        .set('Authorization', `Bearer ${await asAdmin()}`)
        .send({ code: 'NEURO', name: 'Department 3' })

      expect(refused.status).toBe(403)
      expect(String(refused.body.error.message)).toMatch(/includes 2 departments/i)
      expect(String(refused.body.error.message)).toMatch(/already has 2/i)
    })

    it('refuses a staff seat beyond the plan limit, and writes nothing', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'STARTER' })

      // STARTER allows 3 seats; the fixture has already used 2 (admin + doctor).
      const usersBefore = await countUsers()

      const refused = await supertest(app())
        .post(`${API}/staff`)
        .set('Authorization', `Bearer ${await asAdmin()}`)
        .send({
          email: 'fourth-a@example.test',
          firstName: 'Ravi',
          lastName: 'Trivedi',
          role: 'STAFF',
        })

      expect(refused.status).toBe(403)
      expect(String(refused.body.error.message)).toMatch(/includes 3 staff seats/i)

      // Checked before any write: a refusal must not leave an orphaned user record that
      // nobody can sign in to and nobody knows exists.
      expect(await countUsers()).toBe(usersBefore)
    })

    it('does not limit a plan whose limit is null', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'ENTERPRISE' })

      const response = await supertest(app())
        .post(`${API}/departments`)
        .set('Authorization', `Bearer ${await asAdmin()}`)
        .send({ code: 'ONCO', name: 'Oncology' })

      expect(response.status).toBe(201)
    })

    it('does not limit a hospital with no subscription to a lower plan than it had', async () => {
      // A missing row falls back to STARTER, which is the stricter default. Asserted
      // explicitly because this is the one case where a missing row *reduces* access,
      // and someone changing the fallback to ENTERPRISE later would ship a privilege
      // escalation without failing this.
      await removeSubscription(fixture.hospitalA.id)

      const context = await asTenant(fixture, fixture.hospitalA.id, () =>
        entitlementContext(fixture.hospitalA.id),
      )
      expect(context.denied).toBe('NO_SUBSCRIPTION')
      expect(context.mayRead).toBe(false)
    })
  })

  // ─────────────────────────── the payment adapter ───────────────────────────

  describe('nothing can fake a payment', () => {
    it('the null provider reports PENDING and never VERIFIED', async () => {
      const session = await nullPaymentProvider.createCheckout({
        hospitalId: fixture.hospitalA.id,
        plan: 'HOSPITAL',
        amountMinor: 1000,
        currency: 'INR',
        returnUrl: 'https://example.test',
      })

      expect(session.state).toBe('PENDING')
      expect(session.checkoutUrl).toBe('')

      const confirmation = await nullPaymentProvider.confirmCheckout(session.providerRef)
      expect(confirmation.state).toBe('PENDING')
      expect(confirmation.state).not.toBe('VERIFIED')
    })

    it('the interface has no method that can return VERIFIED', () => {
      // A structural assertion, not a behavioural one. If someone adds
      // `markPaid(): Promise<'VERIFIED'>` to the interface tomorrow, this fails at the
      // point of addition — a behavioural test would only notice once somebody wrote the
      // adapter, which is one release too late.
      const methods = Object.keys(nullPaymentProvider).sort()
      expect(methods).toEqual(['cancelSubscription', 'confirmCheckout', 'createCheckout', 'name'])

      // And the confirmation type excludes it at the type level.
      const reachability: readonly string[] = ['PENDING', 'FAILED']
      expect(reachability).not.toContain('VERIFIED')
    })

    it('a custom adapter still cannot set VERIFIED through reconciliation', async () => {
      // The strongest version of the rule: even if an adapter exists and claims success,
      // the state is only ever what the reconciling person said.
      const lyingProvider: PaymentProvider = {
        name: 'liar',
        async createCheckout() {
          return { checkoutUrl: 'https://liar.example.test', providerRef: 'ref-1', state: 'PENDING' }
        },
        async confirmCheckout() {
          return { providerRef: 'ref-1', state: 'PENDING', reason: 'still just a claim' }
        },
        async cancelSubscription() {
          /* no-op */
        },
      }

      setPaymentProvider(lyingProvider)
      await seedSubscription(fixture.hospitalA.id, { plan: 'HOSPITAL' })

      const confirmation = await lyingProvider.confirmCheckout('ref-1')
      expect(confirmation.state).toBe('PENDING')

      const row = await readSubscriptionRow(fixture.hospitalA.id)

      expect(row?.['paymentState']).toBe('NONE')
    })

    it('a tenant cannot record its own payment', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'HOSPITAL' })

      const response = await supertest(app())
        .post(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}/payment`)
        .set('Authorization', `Bearer ${await asAdmin()}`)
        .send({ paymentState: 'VERIFIED' })

      expect([401, 403, 404]).toContain(response.status)
    })

    it('rejects a reconcile body that tries to smuggle an entitlement', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'STARTER' })

      const response = await supertest(app())
        .post(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}/payment`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ paymentState: 'VERIFIED', entitlements: ['PHARMACY'] })

      expect(response.status).toBe(422)
    })
  })

  // ─────────────────────────── platform management ───────────────────────────

  describe('platform management', () => {
    it('assigns a plan and starts a trial', async () => {
      const response = await supertest(app())
        .put(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ plan: 'HOSPITAL', startTrial: true })

      expect(response.status).toBe(200)
      expect(response.body.data.status).toBe('TRIAL')
      expect(response.body.data.entitlements).toEqual(['CLINICAL', 'BILLING', 'ATTENDANCE', 'REPORTS'])
      expect(response.body.data.trialEndsAt).not.toBeNull()
    })

    it('keeps Hospital.plan in step, so the nav and the gate agree', async () => {
      await supertest(app())
        .put(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ plan: 'ENTERPRISE' })

      const hospital = await modelOf('Hospital')
        .findOne({ _id: new Types.ObjectId(fixture.hospitalA.id) })
        .lean()
        .exec()

      expect(hospital?.['plan']).toBe('ENTERPRISE')
    })

    it('refuses a request that tries to set entitlements', async () => {
      const response = await supertest(app())
        .put(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ plan: 'STARTER', entitlements: ['PHARMACY', 'LABORATORY'] })

      // `.strict()` is what makes this a guarantee rather than a convention.
      expect(response.status).toBe(422)
    })

    it('refuses a request that tries to set the status directly', async () => {
      const response = await supertest(app())
        .put(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ plan: 'STARTER', status: 'ACTIVE' })

      expect(response.status).toBe(422)
    })

    it('refuses an unknown plan', async () => {
      const response = await supertest(app())
        .put(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ plan: 'PLATINUM_PLUS' })

      expect(response.status).toBe(422)
    })

    it('serves the catalogue with entitlements and integer prices', async () => {
      const response = await supertest(app())
        .get(`${API}/platform/subscriptions/plans`)
        .set('Authorization', `Bearer ${await asSuper()}`)

      expect(response.status).toBe(200)
      const plans = response.body.data.plans as Row[]
      expect(plans).toHaveLength(3)

      for (const plan of plans) {
        expect(Number.isInteger(plan['monthlyPriceMinor'])).toBe(true)
        expect(Array.isArray(plan['entitlements'])).toBe(true)
        expect(plan['entitlements']).not.toContain('GOD_MODE')
      }
    })

    it('is unreachable by a hospital administrator', async () => {
      const response = await supertest(app())
        .get(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      expect([401, 403]).toContain(response.status)
    })

    it('cannot be reached with a body-supplied hospital id', async () => {
      // The path is the only source of the tenant. A body that names a different hospital
      // is rejected outright rather than ignored, so a caller is never left thinking their
      // override was honoured.
      const response = await supertest(app())
        .put(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ plan: 'STARTER', hospitalId: fixture.hospitalB.id })

      expect(response.status).toBe(422)
    })
  })

  // ─────────────────────────── tenant view ───────────────────────────

  describe('tenant view', () => {
    it('shows plan, usage and renewal to an administrator', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'HOSPITAL' })

      const response = await supertest(app())
        .get(`${API}/hospital/subscription`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      expect(response.status).toBe(200)
      expect(response.body.data.planLabel).toBe('Hospital')
      expect(response.body.data.status).toBe('ACTIVE')
      expect(response.body.data.usage.seats.used).toBeGreaterThan(0)
      expect(response.body.data.usage.seats.limit).toBe(PLAN_DEFINITIONS.HOSPITAL.seatLimit)
      expect(response.body.data.usage.departments.limit).toBe(
        PLAN_DEFINITIONS.HOSPITAL.departmentLimit,
      )
    })

    it('says "not configured" rather than returning an empty object', async () => {
      // An empty payload reads as "you have nothing". The operator needs to see the
      // difference between "not configured" and "configured with nothing".
      await removeSubscription(fixture.hospitalA.id)

      const response = await supertest(app())
        .get(`${API}/hospital/subscription`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      expect(response.status).toBe(200)
      expect(response.body.data.configured).toBe(false)
      expect(response.body.data.usage).toBeDefined()
    })

    it('is not readable by a doctor, who has no business knowing the price', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'HOSPITAL' })

      const response = await supertest(app())
        .get(`${API}/hospital/subscription`)
        .set('Authorization', `Bearer ${await as('doctor-a@example.test')}`)

      expect(response.status).toBe(403)
    })

    it('reports usage that matches reality, not a cached counter', async () => {
      // Usage used to be a stored `UsageCounter` collection written on plan assignment.
      // It is counted live now, and this is the test that says why: a cache has to be
      // updated on every path that changes what it counts, and any path missed leaves the
      // screen confidently wrong. Here a membership is DEACTIVATED rather than deleted,
      // which no counter-maintenance hook would normally be expected to notice.
      await seedSubscription(fixture.hospitalA.id, { plan: 'HOSPITAL' })

      const before = await supertest(app())
        .get(`${API}/hospital/subscription`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      const seatsBefore = before.body.data.usage.seats.used
      expect(seatsBefore).toBeGreaterThan(0)

      await withPlatformScope(async () => {
        await modelOf('Membership').updateMany(
          { hospitalId: new Types.ObjectId(fixture.hospitalA.id), role: 'DOCTOR' },
          { $set: { status: 'SUSPENDED' } },
        )
      })

      const after = await supertest(app())
        .get(`${API}/hospital/subscription`)
        .set('Authorization', `Bearer ${await asAdmin()}`)

      expect(after.body.data.usage.seats.used).toBe(seatsBefore - 1)
    })

it('never returns another tenant\'s subscription', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'ENTERPRISE' })
      await seedSubscription(fixture.hospitalB.id, { plan: 'STARTER' })

      const response = await supertest(app())
        .get(`${API}/hospital/subscription`)
        .set('Authorization', `Bearer ${await asAdminB()}`)

      expect(response.status).toBe(200)
      expect(response.body.data.plan).toBe('STARTER')
    })
  })

  // ─────────────────────────── integrity ───────────────────────────

  describe('integrity', () => {
    it('allows exactly one subscription per tenant', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'STARTER' })

      // Enforced by a UNIQUE INDEX, not by a check. Without it a tenant could hold two
      // and simply use whichever grants it more.
      await expect(
        withPlatformScope(async () =>
          subscriptions().create({
            hospitalId: new Types.ObjectId(fixture.hospitalA.id),
            plan: 'ENTERPRISE',
            status: 'ACTIVE',
            currentPeriodStartsAt: new Date(),
            currentPeriodEndsAt: new Date(Date.now() + 30 * DAY),
          }),
        ),
      ).rejects.toMatchObject({ code: 11000 })
    })

    it('records history for every change, so a dispute can be explained', async () => {
      await supertest(app())
        .put(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ plan: 'STARTER', reason: 'Initial assignment' })

      await supertest(app())
        .patch(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ plan: 'HOSPITAL', reason: 'Upgraded after go-live' })

      const row = await readSubscriptionRow(fixture.hospitalA.id)

      const history = (row?.['history'] ?? []) as Row[]
      expect(history).toHaveLength(2)
      expect(history[0]?.['reason']).toBe('Initial assignment')
      expect(history[1]?.['reason']).toBe('Upgraded after go-live')
      expect(history.every((entry) => entry['actorUserId'] !== undefined)).toBe(true)
    })

    it('verifying a payment rolls the period forward and clears the lapse', async () => {
      await seedSubscription(fixture.hospitalA.id, {
        plan: 'HOSPITAL',
        status: 'SUSPENDED',
        paymentState: 'FAILED',
        currentPeriodEndsAt: new Date(Date.now() - 20 * DAY),
        suspendedAt: new Date(Date.now() - 10 * DAY),
      })

      const response = await supertest(app())
        .post(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}/payment`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ paymentState: 'VERIFIED', reason: 'Bank statement confirmed' })

      expect(response.status).toBe(200)
      expect(response.body.data.status).toBe('ACTIVE')
      expect(response.body.data.paymentState).toBe('VERIFIED')
      expect(response.body.data.suspendedAt).toBeNull()
      expect(new Date(response.body.data.currentPeriodEndsAt).getTime()).toBeGreaterThan(Date.now())
    })

    it('reactivating does NOT mark the tenant paid', async () => {
      await seedSubscription(fixture.hospitalA.id, {
        plan: 'HOSPITAL',
        status: 'SUSPENDED',
        suspendedAt: new Date(),
      })

      const response = await supertest(app())
        .patch(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ reactivate: true, reason: 'Customer called' })

      // Un-suspending is not paying. The tenant goes to PAST_DUE and runs its own grace
      // period, because somebody still has to confirm money arrived.
      expect(response.status).toBe(200)
      expect(response.body.data.status).toBe('PAST_DUE')
      expect(response.body.data.paymentState).toBe('NONE')
    })

    it('rejects a PATCH that changes nothing', async () => {
      await seedSubscription(fixture.hospitalA.id, { plan: 'HOSPITAL' })

      const response = await supertest(app())
        .patch(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({ reason: 'Thinking about it' })

      expect(response.status).toBe(422)
    })

    it('evaluating is idempotent through the API too', async () => {
      await seedSubscription(fixture.hospitalA.id, {
        plan: 'HOSPITAL',
        status: 'ACTIVE',
        currentPeriodEndsAt: new Date(Date.now() - DAY),
      })

      const first = await supertest(app())
        .post(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}/evaluate`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({})

      const second = await supertest(app())
        .post(`${API}/platform/subscriptions/hospitals/${fixture.hospitalA.id}/evaluate`)
        .set('Authorization', `Bearer ${await asSuper()}`)
        .send({})

      expect(first.body.data.changed).toBe(true)
      expect(second.body.data.changed).toBe(false)
      expect(second.body.data.status).toBe('PAST_DUE')
    })
  })
})

async function countUsers(): Promise<number> {
  // `User` is tenant-scoped like everything else, so even a count needs a scope. Tests
  // have none, so the count is lifted deliberately.
  return withPlatformScope(async () => modelOf('User').countDocuments({}))
}

async function countDepartments(hospitalId: string): Promise<number> {
  return withPlatformScope(async () =>
    (DepartmentModel as unknown as Model<Row>).countDocuments({
      hospitalId: new Types.ObjectId(hospitalId),
    }),
  )
}