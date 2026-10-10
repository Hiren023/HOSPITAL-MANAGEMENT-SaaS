import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  connectTestDatabase,
  installTestJwtKeys,
  modelOf,
  resetDatabase,
  seedFixtures,
  TEST_PASSWORD,
  type Fixture,
} from './auth-harness.js'
import { hashPassword } from '../modules/identity/password.util.js'
import { tryStartTestDatabase } from './mongo.js'

/**
 * Authentication and authorisation tests.
 *
 * Two fictional hospitals are seeded so that every authorisation claim is checked
 * against a real second tenant rather than assumed.
 */

const db = await tryStartTestDatabase()

let fixture: Fixture

async function signIn(
  email: string,
  password = TEST_PASSWORD,
): Promise<{ token: string; body: Record<string, unknown> }> {
  const response = await request(fixture.app)
    .post('/api/v1/auth/login')
    .send({ email, password })

  const data = (response.body.data ?? {}) as Record<string, unknown>
  return { token: String(data['accessToken'] ?? ''), body: data }
}

describe.skipIf(!db.uri)('authentication and authorisation', () => {
  beforeAll(async () => {
    installTestJwtKeys()
    await connectTestDatabase(db.uri as string)
  })

  beforeEach(async () => {
    await resetDatabase()
    fixture = await seedFixtures()
  })

  afterAll(async () => {
  })

  // ───────────────────────────── login ─────────────────────────────

  describe('POST /api/v1/auth/login', () => {
    it('signs in a hospital administrator', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: fixture.adminA.email, password: TEST_PASSWORD })

      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(response.body.data.accessToken).toBeTypeOf('string')

      const user = response.body.data.user
      expect(user.email).toBe(fixture.adminA.email)
      expect(user.role).toBe('HOSPITAL_ADMIN')
      expect(user.hospitalId).toBe(fixture.hospitalA.id)
      expect(user.hospitalName).toBe(fixture.hospitalA.name)
    })

    it('sets an HttpOnly, SameSite=Strict refresh cookie', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: fixture.adminA.email, password: TEST_PASSWORD })

      const cookies = response.headers['set-cookie'] as unknown as string[]
      expect(cookies).toBeDefined()

      const refresh = cookies.find((c) => c.startsWith('igc_refresh='))
      expect(refresh).toBeDefined()
      expect(refresh).toContain('HttpOnly')
      expect(refresh).toContain('SameSite=Strict')
      // Scoped to the auth routes only.
      expect(refresh).toContain('Path=/api/v1/auth')
    })

    it('never returns the password hash', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: fixture.adminA.email, password: TEST_PASSWORD })

      expect(JSON.stringify(response.body)).not.toContain('passwordHash')
      expect(JSON.stringify(response.body)).not.toContain('$argon2')
    })

    it('rejects a wrong password with a generic message', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: fixture.adminA.email, password: 'definitely-not-the-password' })

      expect(response.status).toBe(401)
      expect(response.body.error.code).toBe('UNAUTHENTICATED')
      expect(response.body.error.message).toBe('Invalid email or password')
    })

    it('returns an identical response for an unknown email (no enumeration)', async () => {
      const unknown = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.test', password: TEST_PASSWORD })

      const wrongPassword = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: fixture.adminA.email, password: 'definitely-not-the-password' })

      expect(unknown.status).toBe(wrongPassword.status)
      expect(unknown.body.error.message).toBe(wrongPassword.body.error.message)
      expect(unknown.body.error.code).toBe(wrongPassword.body.error.code)
    })

    it('refuses a user with no hospital membership', async () => {
      const orphan = await modelOf('User').create({
        email: 'orphan@example.test',
        firstName: 'No',
        lastName: 'Hospital',
        passwordHash: await hashPassword(TEST_PASSWORD),
        status: 'ACTIVE',
        emailVerified: true,
        failedLoginCount: 0,
      })

      const response = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: 'orphan@example.test', password: TEST_PASSWORD })

      expect(response.status).toBe(403)
      expect(String(orphan['_id'])).toBeTruthy()
    })

    it('signs in a platform administrator who has no hospital membership', async () => {
      // Regression guard: login resolves hospital users through a membership, but a
      // SUPER_ADMIN has none BY DESIGN. Before this was handled, platform sign-in
      // returned 403 and the whole approval flow was unreachable.
      await modelOf('User').updateOne(
        { _id: fixture.superAdmin.id },
        { $set: { platformRole: 'SUPER_ADMIN' } },
      )

      const response = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: fixture.superAdmin.email, password: TEST_PASSWORD })

      expect(response.status).toBe(200)
      expect(response.body.data.user.role).toBe('SUPER_ADMIN')
      // No hospital scope at all, which is what the platform guard expects.
      expect(response.body.data.user.hospitalId).toBeNull()
      expect(response.body.data.user.membershipId).toBeNull()
    })

    it('issues a platform token that satisfies requirePlatformPermission', async () => {
      await modelOf('User').updateOne(
        { _id: fixture.superAdmin.id },
        { $set: { platformRole: 'SUPER_ADMIN' } },
      )

      const { token } = await signIn(fixture.superAdmin.email)

      const response = await request(fixture.app)
        .get('/api/v1/platform/hospitals')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
    })

    it('locks an account after repeated failures', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(fixture.app)
          .post('/api/v1/auth/login')
          .send({ email: fixture.adminB.email, password: 'wrong-password' })
      }

      // Even the CORRECT password is now refused.
      const response = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: fixture.adminB.email, password: TEST_PASSWORD })

      expect(response.status).toBe(423)
      expect(response.body.error.code).toBe('ACCOUNT_LOCKED')
    })

    it('rejects a payload carrying a role or hospital override', async () => {
      // Mass-assignment attempt: a client must not be able to grant itself a role.
      const response = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({
          email: fixture.adminA.email,
          password: TEST_PASSWORD,
          role: 'SUPER_ADMIN',
        })

      expect(response.status).toBe(422)
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
    })

    it('validates the email format', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-email', password: TEST_PASSWORD })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body.error.details)).toContain('email')
    })

    it('validates a missing password', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: fixture.adminA.email })

      expect(response.status).toBe(422)
    })

    it('rejects a MongoDB operator payload', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: { $ne: null }, password: TEST_PASSWORD })

      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
    })
  })

  // ───────────────────────────── current user ─────────────────────────────

  describe('GET /api/v1/auth/me', () => {
    it('returns the identity resolved from the membership', async () => {
      const { token } = await signIn(fixture.adminA.email)

      const response = await request(fixture.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.data.hospitalId).toBe(fixture.hospitalA.id)
      expect(response.body.data.role).toBe('HOSPITAL_ADMIN')
      expect(response.body.data.permissions).toContain('patient:read')
    })

    it('requires a token', async () => {
      const response = await request(fixture.app).get('/api/v1/auth/me')
      expect(response.status).toBe(401)
    })

    it('rejects a forged token', async () => {
      const response = await request(fixture.app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer eyJhbGciOiJFUzI1NiJ9.forged.signature')

      expect(response.status).toBe(401)
      // The same message for every failure, so nothing is disclosed.
      expect(response.body.error.message).toBe('Invalid or expired access token')
    })

    it('rejects a malformed Authorization header', async () => {
      const response = await request(fixture.app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Basic dXNlcjpwYXNz')

      expect(response.status).toBe(401)
    })

    it('rejects an empty bearer token', async () => {
      const response = await request(fixture.app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer ')

      expect(response.status).toBe(401)
    })
  })

  // ───────────────────────────── expired credentials ─────────────────────────────

  describe('expired credentials', () => {
    it('rejects an expired access token', async () => {
      const { issueAccessToken } = await import('../modules/identity/access-token.util.js')
      const { keysFromEnv } = await import('../modules/identity/access-token.util.js')

      const expired = await issueAccessToken(
        {
          userId: fixture.adminA.id,
          role: 'HOSPITAL_ADMIN',
          hospitalId: fixture.hospitalA.id,
          membershipId: '507f1f77bcf86cd799439022',
          sessionId: 'expired-session',
        },
        keysFromEnv(process.env),
        -60,
      )

      const response = await request(fixture.app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expired}`)

      expect(response.status).toBe(401)
      expect(response.body.error.code).toBe('UNAUTHENTICATED')
    })

    it('refuses access once a membership is revoked, even with a valid token', async () => {
      const { token } = await signIn(fixture.adminA.email)

      await modelOf('Membership')
        .updateMany({ userId: fixture.adminA.id }, { $set: { status: 'REVOKED' } })
        .exec()

      const response = await request(fixture.app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
      expect(response.body.error.message).toMatch(/revoked/i)
    })

    it('refuses access once the user is suspended, even with a valid token', async () => {
      const { token } = await signIn(fixture.adminA.email)

      await modelOf('User')
        .updateOne({ _id: fixture.adminA.id }, { $set: { status: 'SUSPENDED' } })
        .exec()

      const response = await request(fixture.app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
    })
  })

  // ───────────────────────────── refresh rotation ─────────────────────────────

  describe('POST /api/v1/auth/refresh', () => {
    it('rotates the refresh token and revokes the family on replay', async () => {
      // Supertest does not keep a cookie jar, so the cookie is threaded explicitly —
      // exactly as a browser would send it back.
      const login = await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: fixture.adminA.email, password: TEST_PASSWORD })

      const originalCookie = (login.headers['set-cookie'] as unknown as string[])[0] ?? ''
      const originalToken = /igc_refresh=([^;]+)/.exec(originalCookie)?.[1]
      expect(originalToken).toBeTruthy()

      const rotated = await request(fixture.app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `igc_refresh=${originalToken}`)

      expect(rotated.status).toBe(200)
      expect(rotated.body.data.accessToken).toBeTypeOf('string')

      const rotatedCookie = (rotated.headers['set-cookie'] as unknown as string[])[0] ?? ''
      const newToken = /igc_refresh=([^;]+)/.exec(rotatedCookie)?.[1]
      expect(newToken).toBeTruthy()
      // A rotation must actually issue a different token.
      expect(newToken).not.toBe(originalToken)

      // Replaying the CONSUMED token is treated as theft: the whole family is revoked,
      // which also invalidates the token just issued.
      const replay = await request(fixture.app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `igc_refresh=${originalToken}`)
      expect(replay.status).toBe(401)

      const afterRevoke = await request(fixture.app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `igc_refresh=${newToken}`)
      expect(afterRevoke.status).toBe(401)
    })

    it('rejects a refresh with no cookie', async () => {
      const response = await request(fixture.app).post('/api/v1/auth/refresh')
      expect(response.status).toBe(401)
    })

    it('rejects a refresh with an unknown token', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', 'igc_refresh=not-a-real-token')

      expect(response.status).toBe(401)
    })
  })

  // ───────────────────────────── logout ─────────────────────────────

  describe('POST /api/v1/auth/logout', () => {
    it('is idempotent and always succeeds', async () => {
      const first = await request(fixture.app).post('/api/v1/auth/logout')
      const second = await request(fixture.app).post('/api/v1/auth/logout')

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
    })
  })

  // ───────────────────────────── password reset ─────────────────────────────

  describe('POST /api/v1/auth/forgot-password', () => {
    it('returns the same response for a known and unknown email', async () => {
      const known = await request(fixture.app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: fixture.adminA.email })

      const unknown = await request(fixture.app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'nobody@example.test' })

      expect(known.status).toBe(unknown.status)
      expect(known.body.data.message).toBe(unknown.body.data.message)
    })

    it('rejects a malformed email', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'nope' })

      expect(response.status).toBe(422)
    })
  })

  describe('POST /api/v1/auth/reset-password', () => {
    it('rejects a wrong code', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/reset-password')
        .send({
          email: fixture.adminA.email,
          code: '000000',
          newPassword: 'a-new-long-enough-password',
        })

      expect(response.status).toBe(422)
    })

    it('rejects a non-numeric code', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/reset-password')
        .send({
          email: fixture.adminA.email,
          code: 'abcdef',
          newPassword: 'a-new-long-enough-password',
        })

      expect(response.status).toBe(422)
    })

    it('rejects a short password', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/reset-password')
        .send({ email: fixture.adminA.email, code: '123456', newPassword: 'short' })

      expect(response.status).toBe(422)
    })

    it('rejects mismatched confirmation', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/auth/reset-password')
        .send({
          email: fixture.adminA.email,
          code: '123456',
          newPassword: 'a-new-long-enough-password',
          confirmPassword: 'a-different-password',
        })

      expect(response.status).toBe(422)
    })
  })

  // ───────────────────────────── role-based access ─────────────────────────────

  describe('role-based authorisation', () => {
    it('a RECEPTIONIST does not hold clinical permissions', async () => {
      const { token, body } = await signIn(fixture.receptionistA.email)

      const permissions = (body.user as { permissions: string[] }).permissions
      expect(permissions).toContain('patient:read')
      expect(permissions).not.toContain('consultation:read')
      expect(permissions).not.toContain('prescription:read')

      const response = await request(fixture.app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
      expect(response.status).toBe(200)
    })

    it('a DOCTOR does not hold financial permissions', async () => {
      const { body } = await signIn(fixture.doctorA.email)
      const permissions = (body.user as { permissions: string[] }).permissions

      expect(permissions).toContain('consultation:write')
      expect(permissions).not.toContain('billing:read')
      expect(permissions).not.toContain('payment:write')
    })

    it('a HOSPITAL_ADMIN holds no platform permissions', async () => {
      const { body } = await signIn(fixture.adminA.email)
      const permissions = (body.user as { permissions: string[] }).permissions

      expect(permissions.some((p) => p.startsWith('platform:'))).toBe(false)
    })
  })

  // ───────────────────────────── platform access ─────────────────────────────

  describe('platform operations (SUPER_ADMIN only)', () => {
    /**
     * Build a SUPER_ADMIN access token.
     *
     * There is no public endpoint that mints one: a SUPER_ADMIN is provisioned
     * operationally. This mirrors what that provisioning would issue.
     */
    async function platformToken(): Promise<string> {
      const { issueAccessToken, keysFromEnv } = await import(
        '../modules/identity/access-token.util.js'
      )
      return issueAccessToken(
        {
          userId: fixture.superAdmin.id,
          role: 'SUPER_ADMIN',
          hospitalId: null,
          membershipId: null,
          sessionId: 'platform-session',
        },
        keysFromEnv(process.env),
      )
    }

    it('lists hospitals for a SUPER_ADMIN', async () => {
      const token = await platformToken()

      const response = await request(fixture.app)
        .get('/api/v1/platform/hospitals')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body.data)).toBe(true)
      expect(response.body.data.length).toBeGreaterThanOrEqual(2)
    })

    it('refuses a hospital administrator the same operation', async () => {
      const { token } = await signIn(fixture.adminA.email)

      const response = await request(fixture.app)
        .get('/api/v1/platform/hospitals')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('FORBIDDEN')
    })

    it('refuses an unauthenticated caller', async () => {
      const response = await request(fixture.app).get('/api/v1/platform/hospitals')
      expect(response.status).toBe(401)
    })

    it('lets a SUPER_ADMIN approve a hospital', async () => {
      const token = await platformToken()

      const created = await modelOf('Hospital').create({
        name: 'Pending Care Centre',
        slug: 'pending-care-centre',
        status: 'PENDING',
      })
      const pendingId = String(created['_id'])

      const response = await request(fixture.app)
        .post(`/api/v1/platform/hospitals/${pendingId}/approve`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.data.status).toBe('APPROVED')
    })

    it('refuses a hospital administrator the suspend operation', async () => {
      const { token } = await signIn(fixture.adminA.email)

      const response = await request(fixture.app)
        .post(`/api/v1/platform/hospitals/${fixture.hospitalB.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
    })

    it('validates the hospital id route parameter', async () => {
      const token = await platformToken()

      const response = await request(fixture.app)
        .post('/api/v1/platform/hospitals/not-an-object-id/approve')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(422)
    })

    it('returns 404 for a well-formed but unknown hospital id', async () => {
      const token = await platformToken()

      const response = await request(fixture.app)
        .post('/api/v1/platform/hospitals/507f1f77bcf86cd799439099/approve')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(404)
    })
  })

  // ───────────────────────────── registration ─────────────────────────────

  describe('POST /api/v1/platform/hospitals', () => {
    const validBody = () => ({
      hospitalName: 'Kaveri Diagnostics Centre',
      registrationNumber: 'KA/2026/1234',
      contactEmail: 'contact@kaveri.example.test',
      admin: {
        firstName: 'Meera',
        lastName: 'Nair',
        email: 'meera.nair@example.test',
        password: TEST_PASSWORD,
      },
    })

    it('creates a PENDING hospital with a HOSPITAL_ADMIN membership', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/platform/hospitals')
        .send(validBody())

      expect(response.status).toBe(201)
      // A new tenant must not be usable before approval.
      expect(response.body.data.status).toBe('PENDING')

      const membership = await modelOf('Membership').findOne({ hospitalId: response.body.data.hospitalId }).lean().exec()

      // Role is assigned server-side, not taken from the request.
      expect(membership?.['role']).toBe('HOSPITAL_ADMIN')
    })

    it('rejects a payload attempting to grant SUPER_ADMIN', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/platform/hospitals')
        .send({ ...validBody(), role: 'SUPER_ADMIN' })

      expect(response.status).toBe(422)
    })

    it('rejects an admin block carrying a role', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/platform/hospitals')
        .send({
          ...validBody(),
          admin: { ...validBody().admin, role: 'SUPER_ADMIN' },
        })

      expect(response.status).toBe(422)
    })

    it('rejects a short password', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/platform/hospitals')
        .send({
          ...validBody(),
          admin: { ...validBody().admin, password: 'short' },
        })

      expect(response.status).toBe(422)
    })

    it('refuses a duplicate administrator email', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/platform/hospitals')
        .send({
          ...validBody(),
          admin: { ...validBody().admin, email: fixture.adminA.email },
        })

      expect(response.status).toBe(409)
    })

    it('never echoes the submitted password', async () => {
      const response = await request(fixture.app)
        .post('/api/v1/platform/hospitals')
        .send(validBody())

      expect(JSON.stringify(response.body)).not.toContain(TEST_PASSWORD)
    })
  })

  // ───────────────────────────── audit ─────────────────────────────

  describe('audit trail', () => {
    it('records a successful sign-in', async () => {
      await signIn(fixture.adminA.email)

      const entries = await modelOf('AuditLog').find({ action: 'auth.login.succeeded' }).lean().exec()

      expect(entries.length).toBeGreaterThanOrEqual(1)
      expect(entries[0]?.['hospitalId']).toBeTruthy()
    })

    it('records a failed sign-in without the password', async () => {
      await request(fixture.app)
        .post('/api/v1/auth/login')
        .send({ email: fixture.adminA.email, password: 'a-very-distinctive-wrong-password' })

      const entries = await modelOf('AuditLog').find({ action: 'auth.login.failed' }).lean().exec()

      expect(entries.length).toBeGreaterThanOrEqual(1)

      const serialised = JSON.stringify(entries)
      expect(serialised).not.toContain('a-very-distinctive-wrong-password')
      expect(serialised).not.toContain(TEST_PASSWORD)
    })

    it('records a denied platform access attempt', async () => {
      const { token } = await signIn(fixture.adminA.email)

      await request(fixture.app)
        .get('/api/v1/platform/hospitals')
        .set('Authorization', `Bearer ${token}`)

      const all = await modelOf('AuditLog').find({}).lean().exec()

      // The denial is visible in the trail.
      expect(all.length).toBeGreaterThanOrEqual(1)
    })

    it('refuses to modify or delete an audit entry', async () => {
      const Model = modelOf('AuditLog')

      await Model.create({ action: 'test.entry', outcome: 'SUCCESS' })

      await expect(Model.updateMany({}, { $set: { outcome: 'FAILURE' } }).exec()).rejects.toThrow(
        /append-only/,
      )
      await expect(Model.deleteMany({}).exec()).rejects.toThrow(/append-only/)
    })
  })
})
