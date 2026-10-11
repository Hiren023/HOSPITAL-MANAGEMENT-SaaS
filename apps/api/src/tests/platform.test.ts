import supertest from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  connectTestDatabase,
  createPlatformFixture,
  installTestJwtKeys,
  modelOf,
  resetDatabase,
  seedPlatformData,
  type PlatformFixture,
} from './auth-harness.js'
import { tryStartTestDatabase } from './mongo.js'

/**
 * Platform console — SUPER_ADMIN boundary.
 *
 * Three questions, asked repeatedly:
 *
 *  1. **Can a hospital user reach any of it?** Every platform route, every one of them,
 *     with a valid hospital-scoped token. A platform capability that leaked to a
 *     hospital role would be the worst defect in this product.
 *  2. **Does each action actually persist, and get audited?**
 *  3. **What happens when it fails?** Bad input, missing permission, unknown id, and
 *     the states a second click can produce.
 *
 * Every test drives the real Express app over HTTP with a real signed token. Nothing is
 * stubbed, so a guard that is wired up but not applied would fail here.
 */

const db = await tryStartTestDatabase()

const UNKNOWN_ID = '507f1f77bcf86cd799439099'

describe.skipIf(!db.uri)('platform console', () => {
  let fixture: PlatformFixture
  const app = () => fixture.app

  beforeAll(async () => {
    installTestJwtKeys()
    await connectTestDatabase(db.uri as string)
  })

  // Fresh data per test: suspending hospital B in one case must not change what the
  // next case observes.
  beforeEach(async () => {
    await resetDatabase()
    fixture = await createPlatformFixture()
  })

  afterAll(async () => {})

  const asPlatform = async () => ({ token: await fixture.platformToken() })
  const asHospitalAdmin = async () => fixture.signIn(fixture.adminA.email)

  // ────────────────────────────── the boundary ──────────────────────────────

  describe('SUPER_ADMIN is required', () => {
    /**
     * Every authenticated platform route, with the permission it needs.
     *
     * This table is the contract. If a route is added and not listed here, the test
     * stops being a proof — so the list is kept next to the routes deliberately.
     */
    const PLATFORM_ROUTES: ReadonlyArray<readonly [string, string]> = [
      ['GET', '/api/v1/platform/overview'],
      ['GET', '/api/v1/platform/hospitals'],
      ['GET', '/api/v1/platform/hospitals/507f1f77bcf86cd799439011'],
      ['GET', '/api/v1/platform/hospitals/507f1f77bcf86cd799439011/users'],
      ['POST', '/api/v1/platform/hospitals/507f1f77bcf86cd799439011/approve'],
      ['POST', '/api/v1/platform/hospitals/507f1f77bcf86cd799439011/suspend'],
      ['POST', '/api/v1/platform/hospitals/507f1f77bcf86cd799439011/reactivate'],
      ['PUT', '/api/v1/platform/hospitals/507f1f77bcf86cd799439011/plan'],
      ['PATCH', '/api/v1/platform/users/507f1f77bcf86cd799439011/status'],
      ['GET', '/api/v1/platform/audit'],
      ['GET', '/api/v1/platform/reports/operational'],
    ]

    /**
     * Dispatches by method name.
     *
     * Written out rather than indexing the supertest agent by a computed key: an index
     * access on a new line is parsed as a separate statement, and silently resolves to
     * `agent[undefined](path)` rather than the method the table names.
     */
    function request(method: string, path: string) {
      const agent = supertest(app())
      switch (method) {
        case 'GET':
          return agent.get(path)
        case 'POST':
          return agent.post(path)
        case 'PUT':
          return agent.put(path)
        case 'PATCH':
          return agent.patch(path)
        default:
          throw new Error(`Unhandled method in the platform route table: ${method}`)
      }
    }

    it('refuses every platform route to a hospital administrator', async () => {
      const token = await asHospitalAdmin()

      for (const [method, path] of PLATFORM_ROUTES) {
        const response = await request(method, path).set('Authorization', `Bearer ${token}`).send({
          reason: 'A reason long enough to pass validation',
          plan: 'HOSPITAL',
          status: 'SUSPENDED',
        })

        // 403, never 404 and never 200: a 404 would mean the route is missing rather
        // than guarded, and a 200 would mean the boundary failed.
        expect(response.status, `${method} ${path} as HOSPITAL_ADMIN`).toBe(403)
        expect(response.body.error.code).toBe('FORBIDDEN')
      }
    })

    it('refuses every platform route to an anonymous caller', async () => {
      for (const [method, path] of PLATFORM_ROUTES) {
        const response = await request(method, path)

        expect(response.status, `${method} ${path} anonymous`).toBe(401)
      }
    })

    it('refuses a platform route to a doctor, who has no platform role at all', async () => {
      const token = await fixture.signIn(fixture.doctorA.email)

      const response = await supertest(app())
        .get('/api/v1/platform/hospitals')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
    })

    it('keeps public registration reachable, because it must be', async () => {
      // The one intentional exception: a brand-new hospital has nobody who could
      // already belong to it.
      const response = await supertest(app()).post('/api/v1/platform/hospitals').send({})

      // Rejected for validation, NOT for authentication — that is the proof.
      expect(response.status).toBe(422)
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('does not let a hospital token borrow platform scope by sending hospitalId', async () => {
      const token = await asHospitalAdmin()

      // Even naming the caller's own hospital in the path or query cannot help.
      const response = await supertest(app())
        .get(`/api/v1/platform/hospitals/${fixture.hospitalA.id}`)
        .query({ hospitalId: fixture.hospitalA.id })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
    })
  })

  // ────────────────────────────── overview ──────────────────────────────

  describe('overview metrics', () => {
    it('counts tenants by status without exposing any clinical figure', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/overview')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)

      const data = response.body.data
      expect(data.tenants.total).toBeGreaterThanOrEqual(2)
      expect(typeof data.tenants.approved).toBe('number')
      expect(data.identity.totalUsers).toBeGreaterThan(0)

      // The operator is told the hospital's staff footprint, never its patients.
      expect(data.identity).toHaveProperty('activeMemberships')
      expect(data.identity).not.toHaveProperty('patients')
    })

    it('never returns a field whose name could carry patient data', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/overview')
        .set('Authorization', `Bearer ${token}`)

      const serialised = JSON.stringify(response.body).toLowerCase()

      for (const forbidden of ['patient', 'diagnosis', 'prescription', 'aadhaar', 'abha']) {
        expect(serialised, `overview leaked "${forbidden}"`).not.toContain(forbidden)
      }
    })

    it('reports the same thing for the operational report', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/reports/operational')
        .query({ days: 30 })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.data.windowDays).toBe(30)
      expect(response.body.data.tenants).toHaveProperty('byStatus')

      const serialised = JSON.stringify(response.body).toLowerCase()
      for (const forbidden of ['patient', 'diagnosis', 'prescription']) {
        expect(serialised).not.toContain(forbidden)
      }
    })

    it('rejects an out-of-range reporting window instead of scanning everything', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/reports/operational')
        .query({ days: 100000 })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(422)
    })
  })

  // ────────────────────────────── tenant list ──────────────────────────────

  describe('tenant list', () => {
    it('paginates server-side and reports the true total', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/hospitals')
        .query({ page: 1, pageSize: 1 })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.data.items).toHaveLength(1)
      expect(response.body.data.page).toMatchObject({
        page: 1,
        pageSize: 1,
        totalPages: expect.any(Number),
      })

      // The critical property: the total counts every matching tenant, not the page.
      const total = response.body.data.page.total as number
      expect(total).toBeGreaterThanOrEqual(2)

      const all = await supertest(app())
        .get('/api/v1/platform/hospitals')
        .query({ pageSize: 100 })
        .set('Authorization', `Bearer ${token}`)
      expect(all.body.data.items).toHaveLength(total)
    })

    it('filters by status server-side', async () => {
      await seedPlatformData()

      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/hospitals')
        .query({ status: 'APPROVED' })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      for (const item of response.body.data.items) {
        expect(item.status).toBe('APPROVED')
      }
      expect(response.body.data.items.length).toBeGreaterThan(0)
    })

    it('searches by name server-side', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/hospitals')
        .query({ q: 'Aarav' })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.data.items.length).toBeGreaterThan(0)
      expect(response.body.data.items[0].name).toMatch(/aarav/i)
    })

    it('treats a regex metacharacter in search as literal text', async () => {
      const { token } = await asPlatform()

      // `.*` would match every tenant if it were interpolated into a RegExp unescaped.
      const response = await supertest(app())
        .get('/api/v1/platform/hospitals')
        .query({ q: '.*' })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.data.items).toHaveLength(0)
    })

    it('rejects an unknown status filter rather than ignoring it', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/hospitals')
        .query({ status: 'NOT_A_STATUS' })
        .set('Authorization', `Bearer ${token}`)

      // A silently-accepted filter that does nothing is worse than an error: it tells
      // the operator their view is filtered when it is not.
      expect(response.status).toBe(422)
    })

    it('rejects a page size beyond the maximum', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/hospitals')
        .query({ pageSize: 100000 })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(422)
    })

    it('rejects an unexpected query parameter', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/hospitals')
        .query({ sortByAnything: 'id' })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(422)
    })
  })

  // ────────────────────────────── tenant detail ──────────────────────────────

  describe('tenant detail', () => {
    it('returns one tenant with its plan and staff composition', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get(`/api/v1/platform/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.data.id).toBe(fixture.hospitalA.id)
      expect(response.body.data).toHaveProperty('plan')
      expect(response.body.data).toHaveProperty('usersByRole')
      expect(response.body.data.totalUsers).toBeGreaterThan(0)
    })

    it('records the read in the audit trail', async () => {
      const { token } = await asPlatform()

      await supertest(app())
        .get(`/api/v1/platform/hospitals/${fixture.hospitalA.id}`)
        .set('Authorization', `Bearer ${token}`)

      // Reading a tenant is itself sensitive: an operator browsing at scale is exactly
      // the access pattern a hospital wants to be able to review afterwards.
      const entries = await modelOf('AuditLog')
        .find({ action: 'hospital.viewed', hospitalId: fixture.hospitalA.id })
        .lean()
        .exec()

      expect(entries.length).toBeGreaterThan(0)
    })

    it('404s for an unknown tenant', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get(`/api/v1/platform/hospitals/${UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(404)
    })

    it('422s for a malformed id rather than querying with it', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/hospitals/not-an-object-id')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(422)
    })
  })

  // ────────────────────────────── lifecycle ──────────────────────────────

  describe('suspend and reactivate', () => {
    it('suspends, then reactivates, recording both transitions', async () => {
      const { token } = await asPlatform()

      const suspended = await supertest(app())
        .post(`/api/v1/platform/hospitals/${fixture.hospitalB.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Registration documents could not be verified' })

      expect(suspended.status).toBe(200)
      expect(suspended.body.data.status).toBe('SUSPENDED')

      const reactivated = await supertest(app())
        .post(`/api/v1/platform/hospitals/${fixture.hospitalB.id}/reactivate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ note: 'Documents verified on resubmission' })

      expect(reactivated.status).toBe(200)
      expect(reactivated.body.data.status).toBe('APPROVED')

      const actions = await modelOf('AuditLog')
        .find({ hospitalId: fixture.hospitalB.id })
        .select({ action: 1 })
        .lean()
        .exec()

      const codes = actions.map((entry) => entry['action'])
      expect(codes).toContain('hospital.suspended')
      expect(codes).toContain('hospital.reactivated')
    })

    it('clears the suspension reason on reactivation', async () => {
      const { token } = await asPlatform()

      await supertest(app())
        .post(`/api/v1/platform/hospitals/${fixture.hospitalB.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Temporary suspension for testing' })

      await supertest(app())
        .post(`/api/v1/platform/hospitals/${fixture.hospitalB.id}/reactivate`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      const detail = await supertest(app())
        .get(`/api/v1/platform/hospitals/${fixture.hospitalB.id}`)
        .set('Authorization', `Bearer ${token}`)

      expect(detail.body.data.status).toBe('APPROVED')
      expect(detail.body.data.suspensionReason).toBeNull()
    })

    it('refuses a double suspend instead of silently repeating it', async () => {
      const { token } = await asPlatform()

      await supertest(app())
        .post(`/api/v1/platform/hospitals/${fixture.hospitalB.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'First suspension for the double-click test' })

      const second = await supertest(app())
        .post(`/api/v1/platform/hospitals/${fixture.hospitalB.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Second suspension for the double-click test' })

      expect(second.status).toBe(409)
      expect(second.body.error.code).toBe('CONFLICT')
    })

    it('refuses to reactivate a tenant that is not suspended', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .post(`/api/v1/platform/hospitals/${fixture.hospitalA.id}/reactivate`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      expect(response.status).toBe(409)
    })

    it('rejects a suspension reason that is too short to be meaningful', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .post(`/api/v1/platform/hospitals/${fixture.hospitalA.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'no' })

      expect(response.status).toBe(422)
    })

    it('stops a suspended hospital from signing in', async () => {
      const { token } = await asPlatform()

      await supertest(app())
        .post(`/api/v1/platform/hospitals/${fixture.hospitalB.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Suspended to verify sign-in is refused' })

      const response = await supertest(app())
        .post('/api/v1/auth/login')
        .send({ email: fixture.adminB.email, password: fixture.password })

      expect(response.status).toBe(403)
    })
  })

  // ────────────────────────────── plan assignment ──────────────────────────────

  describe('subscription plan assignment', () => {
    it('assigns a plan and records who changed it', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .put(`/api/v1/platform/hospitals/${fixture.hospitalA.id}/plan`)
        .set('Authorization', `Bearer ${token}`)
        .send({ plan: 'HOSPITAL', reason: 'Contract upgraded after the pilot' })

      expect(response.status).toBe(200)
      expect(response.body.data.plan).toBe('HOSPITAL')
      expect(response.body.data.seatLimit).toBe(50)

      const entry = await modelOf('AuditLog')
        .find({ action: 'hospital.plan_changed' })
        .sort({ createdAt: -1 })
        .lean()
        .exec()

      expect(entry[0]?.['metadata']).toMatchObject({ newPlan: 'HOSPITAL' })
    })

    it('rejects an unknown plan', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .put(`/api/v1/platform/hospitals/${fixture.hospitalA.id}/plan`)
        .set('Authorization', `Bearer ${token}`)
        .send({ plan: 'ENTERPRISE_PLUS' })

      expect(response.status).toBe(422)
    })

    it('refuses a no-op reassignment so the audit trail stays meaningful', async () => {
      const { token } = await asPlatform()

      const first = await supertest(app())
        .put(`/api/v1/platform/hospitals/${fixture.hospitalA.id}/plan`)
        .set('Authorization', `Bearer ${token}`)
        .send({ plan: 'ENTERPRISE' })
      expect(first.status).toBe(200)

      const second = await supertest(app())
        .put(`/api/v1/platform/hospitals/${fixture.hospitalA.id}/plan`)
        .set('Authorization', `Bearer ${token}`)
        .send({ plan: 'ENTERPRISE' })

      expect(second.status).toBe(409)
    })

    it('accepts no billing or payment fields at all', async () => {
      const { token } = await asPlatform()

      // There is no payment gateway in this product. A request that looks like a
      // payment must be rejected by validation, not quietly accepted and ignored.
      const response = await supertest(app())
        .put(`/api/v1/platform/hospitals/${fixture.hospitalA.id}/plan`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          plan: 'HOSPITAL',
          cardNumber: '4111111111111111',
          autoRenew: true,
        })

      expect(response.status).toBe(422)
    })
  })

  // ────────────────────────────── user management ──────────────────────────────

  describe('tenant user management', () => {
    it('lists a tenant’s staff with role and status', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get(`/api/v1/platform/hospitals/${fixture.hospitalA.id}/users`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.data.items.length).toBeGreaterThan(0)
      expect(response.body.data.page.total).toBeGreaterThan(0)

      const [first] = response.body.data.items
      expect(first).toHaveProperty('email')
      expect(first).toHaveProperty('role')
      // Identity only. Never a credential, never clinical data.
      expect(first).not.toHaveProperty('passwordHash')
      expect(first).not.toHaveProperty('password')
    })

    it('suspends a user account and records the reason', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .patch(`/api/v1/platform/users/${fixture.doctorA.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'SUSPENDED', reason: 'Shared credentials found during a review' })

      expect(response.status).toBe(200)
      expect(response.body.data.status).toBe('SUSPENDED')

      const entry = await modelOf('AuditLog')
        .find({ action: 'user.status_changed' })
        .sort({ createdAt: -1 })
        .lean()
        .exec()

      expect(entry[0]?.['metadata']).toMatchObject({
        newStatus: 'SUSPENDED',
        reason: 'Shared credentials found during a review',
      })
    })

    it('stops a suspended user signing in', async () => {
      const { token } = await asPlatform()

      await supertest(app())
        .patch(`/api/v1/platform/users/${fixture.doctorA.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'SUSPENDED', reason: 'Temporary suspension during investigation' })

      const response = await supertest(app())
        .post('/api/v1/auth/login')
        .send({ email: fixture.doctorA.email, password: fixture.password })

      expect(response.status).toBe(403)
    })

    it('reactivates a suspended user and clears any lockout timer', async () => {
      const { token } = await asPlatform()

      await supertest(app())
        .patch(`/api/v1/platform/users/${fixture.doctorA.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'SUSPENDED', reason: 'Suspended for a status-change test case' })

      const response = await supertest(app())
        .patch(`/api/v1/platform/users/${fixture.doctorA.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'ACTIVE', reason: 'Investigation closed, restoring access' })

      expect(response.status).toBe(200)

      // The account must actually be usable again, not merely labelled ACTIVE.
      const login = await supertest(app())
        .post('/api/v1/auth/login')
        .send({ email: fixture.doctorA.email, password: fixture.password })

      expect(login.status).toBe(200)
    })

    it('refuses to change the operator’s own status', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .patch(`/api/v1/platform/users/${fixture.superAdmin.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'SUSPENDED', reason: 'Attempting to lock myself out of the console' })

      // A platform administrator who suspends themselves is locked out of the only
      // interface that can undo it.
      //
      // 422, not 400: this API's error map has no 400. `badRequest` is `VALIDATION_ERROR`,
      // the same code a malformed body produces, which is accurate here — the request
      // asked for something that cannot be a valid request.
      expect(response.status).toBe(422)
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
      expect(response.body.error.message).toMatch(/your own account/i)
    })

    it('rejects a status change without a reason', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .patch(`/api/v1/platform/users/${fixture.doctorA.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'SUSPENDED' })

      expect(response.status).toBe(422)
    })

    it('rejects an unknown target status', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .patch(`/api/v1/platform/users/${fixture.doctorA.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'DELETED', reason: 'Testing an unsupported status value' })

      expect(response.status).toBe(422)
    })

    it('404s for an unknown user', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .patch(`/api/v1/platform/users/${UNKNOWN_ID}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'SUSPENDED', reason: 'Testing an unknown user reference' })

      expect(response.status).toBe(404)
    })
  })

  // ────────────────────────────── audit viewer ──────────────────────────────

  describe('audit log viewer', () => {
    it('returns a page of events with a cursor', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/audit')
        .query({ limit: 5 })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body.data.items)).toBe(true)
      expect(response.body.data.items.length).toBeLessThanOrEqual(5)
      expect(response.body.data).toHaveProperty('nextCursor')
    })

    it('walks the trail with the cursor without duplicating or skipping', async () => {
      const { token } = await asPlatform()

      const seen: string[] = []
      let cursor: string | null = null

      for (let page = 0; page < 4; page += 1) {
        // Annotated: `cursor` is assigned from this response, so leaving the type to
        // inference makes the two circular.
        const response: supertest.Response = await supertest(app())
          .get('/api/v1/platform/audit')
          .query(cursor ? { limit: 3, cursor } : { limit: 3 })
          .set('Authorization', `Bearer ${token}`)

        expect(response.status).toBe(200)
        for (const item of response.body.data.items) seen.push(item.id)

        cursor = response.body.data.nextCursor ?? null
        if (!cursor) break
      }

      // An audit trail with duplicates or gaps reads as tampering, even when it is
      // only a pagination artefact. This is exactly why the trail is cursor-paginated.
      expect(new Set(seen).size).toBe(seen.length)
    })

    it('filters by action without accepting a query operator', async () => {
      const { token } = await asPlatform()

      const injection = await supertest(app())
        .get('/api/v1/platform/audit')
        .query({ action: { $ne: null } })
        .set('Authorization', `Bearer ${token}`)

      // Express parses this into an object; the strict schema must refuse it rather
      // than pass an operator into Mongo.
      expect(injection.status).toBe(422)

      const valid = await supertest(app())
        .get('/api/v1/platform/audit')
        .query({ action: 'hospital.suspended' })
        .set('Authorization', `Bearer ${token}`)

      expect(valid.status).toBe(200)
      for (const item of valid.body.data.items) {
        expect(item.action).toBe('hospital.suspended')
      }
    })

    it('treats free-text search metacharacters as literal', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/audit')
        .query({ q: '.*' })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.data.items).toHaveLength(0)
    })

    it('redacts sensitive keys even if one reached storage', async () => {
      // Simulate a value that bypassed the write-side redaction.
      await modelOf('AuditLog').create({
        action: 'hospital.viewed',
        resourceType: 'Hospital',
        resourceId: '507f1f77bcf86cd799439011',
        outcome: 'SUCCESS',
        metadata: {
          note: 'a benign field',
          password: 'should-never-be-stored',
          accessToken: 'should-never-be-stored',
        },
      })

      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/audit')
        .query({ limit: 50 })
        .set('Authorization', `Bearer ${token}`)

      const serialised = JSON.stringify(response.body)
      expect(serialised).not.toContain('should-never-be-stored')

      const injected = response.body.data.items.find(
        (item: { metadata?: Record<string, unknown> }) =>
          item.metadata?.['note'] === 'a benign field',
      )
      expect(injected?.metadata?.['password']).toBe('[redacted]')
    })

    it('rejects an out-of-range page size', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/audit')
        .query({ limit: 5000 })
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(422)
    })

    it('starts from the beginning when handed a corrupt cursor', async () => {
      const { token } = await asPlatform()

      const response = await supertest(app())
        .get('/api/v1/platform/audit')
        .query({ cursor: 'not-a-real-cursor' })
        .set('Authorization', `Bearer ${token}`)

      // Degrades to the first page rather than 500-ing a console an operator is using
      // to investigate something.
      expect(response.status).toBe(200)
      expect(response.body.data.items.length).toBeGreaterThan(0)
    })
  })

  // ────────────────────────────── audit trail ──────────────────────────────

  describe('every platform action is audited', () => {
    it('leaves a trail for each mutation', async () => {
      const { token } = await asPlatform()

      await supertest(app())
        .post(`/api/v1/platform/hospitals/${fixture.hospitalA.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Auditing check for the suspension trail' })

      await supertest(app())
        .post(`/api/v1/platform/hospitals/${fixture.hospitalA.id}/reactivate`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      const codes = (
        await modelOf('AuditLog')
          .find({ hospitalId: fixture.hospitalA.id })
          .select({ action: 1 })
          .lean()
          .exec()
      ).map((entry) => entry['action'])

      expect(codes).toContain('hospital.suspended')
      expect(codes).toContain('hospital.reactivated')
    })
  })
})
