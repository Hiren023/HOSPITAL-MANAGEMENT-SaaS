import { Router, type NextFunction, type Request, type Response } from 'express'
import { stringifySetCookie } from 'cookie'

import { SESSION } from '@infinigrow/shared'

import { ApiError } from '../../infrastructure/api-error.js'
import { authenticate } from '../../middleware/auth.js'
import {
  loginLimiter,
  otpVerifyLimiter,
  passwordResetLimiter,
  refreshLimiter,
} from '../../middleware/rate-limit.js'
import { validate } from '../../validation/validate.js'
import {
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  resetPasswordSchema,
} from './auth.schemas.js'
import {
  getCurrentUser,
  login,
  logout,
  refreshSession,
  requestPasswordReset,
  resetPassword,
  type RequestMeta,
} from './auth.service.js'

/**
 * Authentication routes.
 *
 * Platform-administration routes live in `registration.routes.ts` under
 * `/api/v1/platform/*`, so there is exactly one place a `SUPER_ADMIN` operation can be
 * reached from. Splitting them across two prefixes would be easy to mis-route.
 *
 * Refresh-token cookie policy:
 *   - `HttpOnly`      — unreachable from JavaScript, so an XSS bug cannot read it
 *   - `Secure`        — never sent over plain HTTP (production only)
 *   - `SameSite=Strict` — never attached cross-site, removing the CSRF vector
 *   - `Path=/api/v1/auth` — only ever sent to routes that need it
 */

const REFRESH_COOKIE = 'igc_refresh'
const REFRESH_PATH = '/api/v1/auth'

function meta(req: Request): RequestMeta {
  return {
    ip: req.ip ?? '',
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500),
    requestId: req.requestId,
  }
}

const isSecureCookie = (): boolean => process.env['NODE_ENV'] === 'production'

function setRefreshCookie(res: Response, token: string): void {
  res.append(
    'Set-Cookie',
    stringifySetCookie({
      name: REFRESH_COOKIE,
      value: token,
      httpOnly: true,
      secure: isSecureCookie(),
      sameSite: 'strict',
      path: REFRESH_PATH,
      maxAge: SESSION.REFRESH_TOKEN_TTL_SECONDS,
    }),
  )
}

function clearRefreshCookie(res: Response): void {
  res.append(
    'Set-Cookie',
    stringifySetCookie({
      name: REFRESH_COOKIE,
      value: '',
      httpOnly: true,
      secure: isSecureCookie(),
      sameSite: 'strict',
      path: REFRESH_PATH,
      maxAge: 0,
    }),
  )
}

/** Supertest and browsers both expose the cookie jar as a `Cookie` header. */
function readRefreshCookie(req: Request): string | undefined {
  return (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE]
}

export const authRouter: Router = Router()

/** POST /api/v1/auth/login */
authRouter.post(
  '/login',
  loginLimiter,
  validate({ body: loginSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { email: string; password: string; hospitalId?: string }
      const { tokens, user } = await login({ ...body, meta: meta(req) })

      setRefreshCookie(res, tokens.refreshToken)

      res.status(200).json({
        success: true,
        data: {
          accessToken: tokens.accessToken,
          expiresInSeconds: tokens.expiresInSeconds,
          user,
        },
        meta: { requestId: req.requestId },
      })
    } catch (error) {
      next(error)
    }
  },
)

/** POST /api/v1/auth/refresh — rotates the token pair. */
authRouter.post(
  '/refresh',
  refreshLimiter,
  validate({ body: refreshSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const supplied = readRefreshCookie(req)

      if (!supplied) {
        throw ApiError.unauthenticated('No active session')
      }

      const { tokens, user } = await refreshSession({ refreshToken: supplied, meta: meta(req) })

      setRefreshCookie(res, tokens.refreshToken)

      res.status(200).json({
        success: true,
        data: { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds, user },
        meta: { requestId: req.requestId },
      })
    } catch (error) {
      // Always clear: a failed refresh leaves the client with a stale, unusable cookie.
      clearRefreshCookie(res)
      next(error)
    }
  },
)

/** POST /api/v1/auth/logout — idempotent. */
authRouter.post(
  '/logout',
  refreshLimiter,
  validate({ body: refreshSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await logout({ refreshToken: readRefreshCookie(req), meta: meta(req) })
      clearRefreshCookie(res)

      res.status(200).json({ success: true, data: { signedOut: true } })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /api/v1/auth/me
 *
 * Identity and permissions, resolved from the caller's MEMBERSHIP. No client-supplied
 * hospital id is involved at any point.
 */
authRouter.get(
  '/me',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = req.auth
      if (!context) throw ApiError.unauthenticated('Authentication required')

      // A platform actor has no tenant scope, so the response is deliberately minimal.
      if (!('permissions' in context)) {
        res.status(200).json({
          success: true,
          data: {
            userId: context.userId,
            role: context.role,
            hospitalId: null,
            hospitalName: null,
            membershipId: null,
            permissions: [],
            scope: 'platform',
          },
          meta: { requestId: req.requestId },
        })
        return
      }

      const user = await getCurrentUser(context)
      res.status(200).json({ success: true, data: user, meta: { requestId: req.requestId } })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /api/v1/auth/forgot-password
 *
 * Always the same status and body whether or not the address exists, so the endpoint
 * cannot be used to enumerate registered users (docs/SECURITY.md R11).
 */
authRouter.post(
  '/forgot-password',
  passwordResetLimiter,
  validate({ body: forgotPasswordSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await requestPasswordReset({ email: (req.body as { email: string }).email, meta: meta(req) })

      res.status(200).json({
        success: true,
        data: {
          message: 'If an account exists for that address, a reset code has been sent.',
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/** POST /api/v1/auth/reset-password */
authRouter.post(
  '/reset-password',
  otpVerifyLimiter,
  validate({ body: resetPasswordSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { email: string; code: string; newPassword: string }
      await resetPassword({ ...body, meta: meta(req) })

      res.status(200).json({ success: true, data: { reset: true } })
    } catch (error) {
      next(error)
    }
  },
)