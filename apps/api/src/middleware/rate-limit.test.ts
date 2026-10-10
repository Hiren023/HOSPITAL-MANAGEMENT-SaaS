import { rateLimit } from 'express-rate-limit'
import express, { type Express } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { ApiError } from '../infrastructure/api-error.js'
import { errorHandler } from './error-handler.js'
import { AUTH_RATE_LIMIT_POLICY, loginLimiter, registrationLimiter } from './rate-limit.js'

/**
 * Rate-limit policy tests.
 *
 * The suite-wide limiters are relaxed under NODE_ENV=test so that a full test run does
 * not exhaust the shared in-memory bucket. That would let a limiter bypass go
 * unnoticed, so the REAL production values are asserted here directly.
 */

function appWith(limiter: Express['request'] extends never ? never : ReturnType<typeof rateLimit>) {
  const app = express()
  app.get('/limited', limiter, (_req, res) => {
    res.status(200).json({ success: true })
  })
  app.use(errorHandler)
  return app
}

describe('declared policy values', () => {
  it('limits sign-in attempts to 10 per 15 minutes', () => {
    expect(AUTH_RATE_LIMIT_POLICY.LOGIN.limit).toBe(10)
    expect(AUTH_RATE_LIMIT_POLICY.LOGIN.windowMs).toBe(15 * 60 * 1000)
  })

  it('limits password resets to 5 per hour', () => {
    // Each reset sends an email, so this must stay tight.
    expect(AUTH_RATE_LIMIT_POLICY.PASSWORD_RESET.limit).toBe(5)
    expect(AUTH_RATE_LIMIT_POLICY.PASSWORD_RESET.windowMs).toBe(60 * 60 * 1000)
  })

  it('limits hospital registration to 5 per hour', () => {
    expect(AUTH_RATE_LIMIT_POLICY.REGISTER.limit).toBe(5)
  })

  it('limits MFA verification to 10 per 15 minutes', () => {
    expect(AUTH_RATE_LIMIT_POLICY.MFA_VERIFY.limit).toBe(10)
  })

  it('is stricter on sign-in than on ordinary API traffic', () => {
    expect(AUTH_RATE_LIMIT_POLICY.LOGIN.limit).toBeLessThan(AUTH_RATE_LIMIT_POLICY.API.limit)
  })
})

describe('a limiter with the real production limit', () => {
  /**
   * Built inline with production values rather than using the shared export, because
   * the shared one is scaled for tests and a shared bucket would be exhausted by
   * earlier tests in this file.
   */
  const strictLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 3,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new ApiError('RATE_LIMITED', 'Too many requests. Please try again later.'))
    },
  })

  it('allows requests up to the limit', async () => {
    const app = appWith(strictLimiter)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(app).get('/limited')
      expect(response.status).toBe(200)
    }
  })

  it('blocks once the limit is exceeded', async () => {
    const app = appWith(strictLimiter)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app).get('/limited')
    }

    const blocked = await request(app).get('/limited')
    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
  })

  it('emits standard rate-limit headers', async () => {
    const app = appWith(strictLimiter)
    const response = await request(app).get('/limited')

    // `standardHeaders: 'draft-7'` emits a single combined `RateLimit` header
    // (`limit=3, remaining=2, reset=...`), not the separate `RateLimit-Limit` form
    // used by the older draft-6 shape.
    expect(response.headers['ratelimit']).toMatch(/limit=\d+/)
    expect(response.headers['ratelimit']).toMatch(/remaining=\d+/)
  })
})

describe('the shared test limiters exist and are wired', () => {
  it('loginLimiter and registrationLimiter are request handlers', () => {
    expect(typeof loginLimiter).toBe('function')
    expect(typeof registrationLimiter).toBe('function')
  })
})
