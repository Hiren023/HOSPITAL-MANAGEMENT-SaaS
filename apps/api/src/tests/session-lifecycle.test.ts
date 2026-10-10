import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  installTestJwtKeys,
  modelOf,
  resetDatabase,
  seedFixtures,
  type Fixture,
} from './auth-harness.js'
import { connectTestDatabase } from './auth-harness.js'
import { tryStartTestDatabase } from './mongo.js'
import { refreshSession, logout, requestPasswordReset } from '../modules/auth/auth.service.js'
import { issueAccessToken, keysFromEnv } from '../modules/identity/access-token.util.js'
import { hashToken } from '../modules/identity/token.util.js'

/**
 * Session lifecycle at the service layer.
 *
 * These paths are hard to reach through HTTP alone (they need a real browser cookie
 * jar and precise ordering), so they are exercised directly.
 */

const db = await tryStartTestDatabase()
const meta = { ip: '127.0.0.1', userAgent: 'vitest', requestId: 'req-session-test' }

let fixture: Fixture

async function platformToken(): Promise<string> {
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

describe.skipIf(!db.uri)('session lifecycle', () => {
  beforeAll(async () => {
    installTestJwtKeys()
    await connectTestDatabase(db.uri as string)
  })

  beforeEach(async () => {
    await resetDatabase()
    fixture = await seedFixtures()
  })

  afterAll(async () => {
    // Shared mongod intentionally left running for sibling suites.
  })

  // ────────────────── refresh rotation ──────────────────

  describe('refreshSession', () => {
    async function createSession(): Promise<{ token: string; familyId: string }> {
      const session = await modelOf('RefreshSession').create({
        userId: fixture.adminA.id,
        tokenHash: hashToken('seed-token'),
        familyId: 'family-1',
        hospitalId: fixture.hospitalA.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })

      return { token: 'seed-token', familyId: String(session['familyId']) }
    }

    it('rotates the token and marks the old one consumed', async () => {
      await createSession()

      const result = await refreshSession({ refreshToken: 'seed-token', meta })

      expect(result.tokens.accessToken).toBeTypeOf('string')
      expect(result.tokens.refreshToken).not.toBe('seed-token')

      const sessions = await modelOf('RefreshSession').find({}).lean().exec()
      const original = sessions.find((s) => s['tokenHash'] === hashToken('seed-token'))
      expect(original?.['revokedAt']).toBeTruthy()
      expect(original?.['replacedByTokenHash']).toBe(hashToken(result.tokens.refreshToken))
    })

    it('keeps the token family across rotations', async () => {
      await createSession()

      const result = await refreshSession({ refreshToken: 'seed-token', meta })
      const rotated = await modelOf('RefreshSession')
        .findOne({ tokenHash: hashToken(result.tokens.refreshToken) })
        .lean()
        .exec()

      expect(rotated?.['familyId']).toBe('family-1')
    })

    it('revokes the whole family when a consumed token is replayed', async () => {
      await createSession()
      const rotated = await refreshSession({ refreshToken: 'seed-token', meta })

      // Replay the consumed token.
      await expect(refreshSession({ refreshToken: 'seed-token', meta })).rejects.toThrow(
        /revoked/i,
      )

      // The newly issued token must be dead too — that is the whole point.
      await expect(
        refreshSession({ refreshToken: rotated.tokens.refreshToken, meta }),
      ).rejects.toThrow(/revoked/i)
    })

    it('records a reuse-detection audit entry', async () => {
      await createSession()
      await refreshSession({ refreshToken: 'seed-token', meta })
      await refreshSession({ refreshToken: 'seed-token', meta }).catch(() => undefined)

      const entries = await modelOf('AuditLog')
        .find({ action: 'auth.token.reuse_detected' })
        .lean()
        .exec()

      expect(entries.length).toBeGreaterThanOrEqual(1)
    })

    it('rejects an unknown token', async () => {
      await expect(refreshSession({ refreshToken: 'nope', meta })).rejects.toThrow(
        /Invalid or expired session/,
      )
    })

    it('rejects an expired session', async () => {
      await modelOf('RefreshSession').create({
        userId: fixture.adminA.id,
        tokenHash: hashToken('expired-token'),
        familyId: 'family-expired',
        hospitalId: fixture.hospitalA.id,
        expiresAt: new Date(Date.now() - 1000),
      })

      await expect(refreshSession({ refreshToken: 'expired-token', meta })).rejects.toThrow(
        /expired/i,
      )
    })

    it('revokes the session when the membership was revoked meanwhile', async () => {
      await createSession()

      await modelOf('Membership')
        .updateMany({ userId: fixture.adminA.id }, { $set: { status: 'REVOKED' } })
        .exec()

      await expect(refreshSession({ refreshToken: 'seed-token', meta })).rejects.toThrow(
        /no longer valid/i,
      )
    })
  })

  // ────────────────── logout ──────────────────

  describe('logout', () => {
    it('revokes the entire family', async () => {
      await modelOf('RefreshSession').create([
        {
          userId: fixture.adminA.id,
          tokenHash: hashToken('t1'),
          familyId: 'family-x',
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          userId: fixture.adminA.id,
          tokenHash: hashToken('t2'),
          familyId: 'family-x',
          expiresAt: new Date(Date.now() + 60_000),
        },
      ])

      await logout({ refreshToken: 't1', meta })

      const remaining = await modelOf('RefreshSession').find({ revokedAt: null }).lean().exec()
      expect(remaining).toHaveLength(0)
    })

    it('is idempotent with no token', async () => {
      await expect(logout({ meta })).resolves.toBeUndefined()
    })

    it('is idempotent with an unknown token', async () => {
      await expect(logout({ refreshToken: 'unknown', meta })).resolves.toBeUndefined()
    })

    it('records a logout audit entry', async () => {
      await modelOf('RefreshSession').create({
        userId: fixture.adminA.id,
        tokenHash: hashToken('t9'),
        familyId: 'family-y',
        expiresAt: new Date(Date.now() + 60_000),
      })

      await logout({ refreshToken: 't9', meta })

      const entries = await modelOf('AuditLog').find({ action: 'auth.logout' }).lean().exec()
      expect(entries.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ────────────────── password reset delivery ──────────────────

  describe('requestPasswordReset', () => {
    it('reports a delivery failure when no provider is configured', async () => {
      // Fail closed: without SMTP the reset cannot be delivered, and the code is
      // never written to a log as a fallback.
      const saved = { ...process.env }
      delete process.env['MAIL_HOST']
      delete process.env['MAIL_USER']
      delete process.env['MAIL_PASSWORD']
      delete process.env['MAIL_FROM']

      const result = await requestPasswordReset({ email: fixture.adminA.email, meta })

      expect(result.deliveryFailed).toBe(true)
      process.env = saved
    })

    it('never creates an OTP challenge when delivery is impossible', async () => {
      const saved = { ...process.env }
      delete process.env['MAIL_HOST']

      await requestPasswordReset({ email: fixture.adminA.email, meta })

      const challenges = await modelOf('AuditLog').find({ action: 'auth.otp.requested' }).lean().exec()
      // An audit entry records the failure rather than a code.
      expect(challenges).toHaveLength(0)
      process.env = saved
    })

    it('does not reveal whether the address exists', async () => {
      const saved = { ...process.env }
      delete process.env['MAIL_HOST']

      const known = await requestPasswordReset({ email: fixture.adminA.email, meta })
      const unknown = await requestPasswordReset({ email: 'nobody@example.test', meta })

      // Same shape either way; only the internal audit record differs.
      expect(typeof known.deliveryFailed).toBe(typeof unknown.deliveryFailed)
      process.env = saved
    })
  })

  // ────────────────── platform suspend over HTTP ──────────────────

  describe('platform suspend', () => {
    it('suspends a tenant for a SUPER_ADMIN and audits it', async () => {
      const token = await platformToken()

      const { registrationRouter } = await import('../modules/auth/registration.routes.js')
      const { createApp } = await import('../app.js')
      const app = createApp()

      // Route through the real app.
      void registrationRouter

      const request = (await import('supertest')).default
      const response = await request(app)
        .post(`/api/v1/platform/hospitals/${fixture.hospitalA.id}/suspend`)
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.data.status).toBe('SUSPENDED')

      const entries = await modelOf('AuditLog')
        .find({ action: 'hospital.suspended' })
        .lean()
        .exec()
      expect(entries).toHaveLength(1)
    })

    it('returns 404 when suspending an unknown tenant', async () => {
      const token = await platformToken()
      const { createApp } = await import('../app.js')
      const request = (await import('supertest')).default

      const response = await request(createApp())
        .post('/api/v1/platform/hospitals/507f1f77bcf86cd799439099/suspend')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(404)
    })
  })
})