import { RATE_LIMITS } from '@infinigrow/shared'
import type { RequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'

import { ApiError } from '../infrastructure/api-error.js'

/**
 * Rate limiters.
 *
 * Authentication endpoints get their own, much stricter policies than the global API
 * limit. Credential stuffing is the realistic threat here: an attacker trying many
 * passwords from many IPs, or one IP trying many accounts
 * (docs/SECURITY.md R5, R12).
 *
 * DEVELOPMENT NOTE: the default in-memory store is per-process. A multi-instance
 * deployment MUST swap in a shared store (Redis or Mongo), or the effective limit
 * becomes `limit × instanceCount`. This is a release gate in docs/RUNBOOK.md.
 */

/**
 * Limits are relaxed under NODE_ENV=test.
 *
 * The limiters share one in-memory bucket per process, so a suite that signs in a few
 * dozen times would exhaust the login budget and every later test would receive 429
 * instead of exercising the code it was written for. The policies themselves are
 * asserted directly in `rate-limit.test.ts`, which constructs limiters with the REAL
 * production values.
 */
const isTest = process.env['NODE_ENV'] === 'test'
const scale = (value: number): number => (isTest ? value * 1000 : value)

function limited(windowMs: number, limit: number, message: string): RequestHandler {
  return rateLimit({
    windowMs: isTest ? 60_000 : windowMs,
    limit: scale(limit),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Never include the target in the message: it would confirm account existence.
    handler: (_req, _res, next) => {
      next(new ApiError('RATE_LIMITED', message))
    },
  })
}

/** Sign-in: 10 attempts per 15 minutes per IP. */
export const loginLimiter = limited(
  RATE_LIMITS.LOGIN.windowMs,
  RATE_LIMITS.LOGIN.limit,
  'Too many sign-in attempts. Please try again later.',
)

/** Token refresh: slightly looser than login, since it is not a credential probe. */
export const refreshLimiter = limited(
  15 * 60 * 1000,
  30,
  'Too many requests. Please try again later.',
)

/**
 * Password reset and OTP: 5 per hour.
 *
 * Low, because each request sends an email and can be used to flood a victim's inbox.
 */
export const passwordResetLimiter = limited(
  RATE_LIMITS.PASSWORD_RESET.windowMs,
  RATE_LIMITS.PASSWORD_RESET.limit,
  'Too many password reset requests. Please try again later.',
)

/** OTP verification: 10 per 15 minutes, matching the per-code attempt cap. */
export const otpVerifyLimiter = limited(
  RATE_LIMITS.MFA_VERIFY.windowMs,
  RATE_LIMITS.MFA_VERIFY.limit,
  'Too many verification attempts. Please try again later.',
)

/** Hospital registration: 5 per hour — each one provisions a real tenant. */
export const registrationLimiter = limited(
  RATE_LIMITS.REGISTER.windowMs,
  RATE_LIMITS.REGISTER.limit,
  'Too many registration attempts. Please try again later.',
)

/** Exported policy values, asserted directly by the rate-limit tests. */
export const AUTH_RATE_LIMIT_POLICY = RATE_LIMITS