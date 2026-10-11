import compression from 'compression'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express, type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import helmet from 'helmet'
import { RATE_LIMITS } from '@infinigrow/shared'
import { pinoHttp } from 'pino-http'

import {
  API_BASE_PATH,
  PRODUCT_TAGLINE,
  PRODUCT_VENDOR,
  SERVICE_VERSION,
} from './config/constants.js'
import { env } from './config/env.js'
import { ApiError } from './infrastructure/api-error.js'
import { logger } from './infrastructure/logger.js'
import { errorHandler } from './middleware/error-handler.js'
import { notFoundHandler } from './middleware/not-found.js'
import { requestId } from './middleware/request-id.js'
import { apiRouter } from './modules/api/api.routes.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { registrationRouter } from './modules/auth/registration.routes.js'
import { platformRouter } from './modules/platform/platform.routes.js'
import { hospitalAdminRouter } from './modules/hospital-admin/hospital-admin.routes.js'
import { patientsRouter } from './modules/patients/patients.routes.js'
import { appointmentsRouter } from './modules/appointments/appointments.routes.js'
import { healthRouter } from './modules/health/health.routes.js'

/**
 * Builds the Express application.
 *
 * Kept separate from `index.ts` (which listens on a port) so integration tests can
 * drive the app in-process with Supertest and never open a socket.
 */

export function createApp(): Express {
  const app = express()

  // Do not advertise the framework (docs/SECURITY.md R18).
  app.disable('x-powered-by')

  /**
   * Trust proxy headers ONLY when a known reverse proxy sits in front of us.
   * Without this, `req.ip` comes from a spoofable header and IP rate limiting and
   * audit logging become worthless.
   */
  if (env.TRUST_PROXY) {
    app.set('trust proxy', env.TRUST_PROXY_HOPS)
  }

  // Correlation id must exist before anything logs.
  app.use(requestId)

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).requestId,
      // Serialisers intentionally expose request metadata only. Headers and bodies
      // are never serialised, so a bearer token or a clinical payload cannot be
      // logged through a request object (docs/SECURITY.md R8).
      serializers: {
        req: (req: unknown) => {
          const request = req as { method?: string; url?: string }
          return { method: request.method, url: request.url }
        },
        res: (res: unknown) => {
          const response = res as { statusCode?: number }
          return { statusCode: response.statusCode }
        },
      },
    }),
  )

  app.use(
    helmet({
      // The API only returns JSON; the web application owns its own CSP.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      // getUpgradeInsecureRequests is meaningless server-side and noisy in logs.
      hsts: env.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
    }),
  )

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser callers (health checks, server-to-server)
        // send no Origin header.
        if (!origin) return callback(null, true)
        if (env.corsOrigins.includes(origin)) return callback(null, true)
        return callback(new ApiError('FORBIDDEN', 'Origin is not allowed to access this API'))
      },
      credentials: false, // auth travels as a Bearer token, not a cookie
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  )

  app.use(compression())

  // Reads the HttpOnly refresh-token cookie on the auth routes.
  app.use(cookieParser())
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }))
  app.use(express.urlencoded({ extended: false, limit: env.REQUEST_BODY_LIMIT }))

  app.use(
    rateLimit({
      windowMs: RATE_LIMITS.API.windowMs,
      limit: RATE_LIMITS.API.limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, _res, next) => {
        next(new ApiError('RATE_LIMITED', 'Too many requests. Please slow down and try again.'))
      },
    }),
  )

  // Infrastructure probes.
  app.use('/health', healthRouter)

  // Product landing metadata.
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      data: {
        product: 'Infinigrow Hospital Cloud',
        vendor: PRODUCT_VENDOR,
        tagline: PRODUCT_TAGLINE,
        apiVersion: SERVICE_VERSION,
        apiBasePath: API_BASE_PATH,
        documentation: env.ENABLE_API_DOCS ? `${API_BASE_PATH}/docs` : null,
      },
    })
  })

  app.use(API_BASE_PATH, apiRouter)

  // Authentication and platform administration.
  app.use(`${API_BASE_PATH}/auth`, authRouter)
  // Hospital administration lives at the API root, not under `/platform`: these routes
  // are tenant-scoped and a `SUPER_ADMIN` cannot reach them.
  app.use(`${API_BASE_PATH}`, hospitalAdminRouter)
  // Patients and appointments are tenant-scoped in the same way, and use the same
  // registrar-built router so their routes cannot be added without the boundary either.
  // They stay separate routers rather than more paths on the hospital-admin one so that
  // widening scheduling access cannot quietly widen patient access, or the reverse.
  app.use(`${API_BASE_PATH}`, patientsRouter)
  app.use(`${API_BASE_PATH}`, appointmentsRouter)
  // Public registration stays on its own router; everything else platform-scoped lives
  // on `platformRouter`, where every route is authenticated and platform-permissioned by
  // construction rather than by each handler remembering to add the middleware.
  app.use(`${API_BASE_PATH}/platform`, registrationRouter)
  app.use(`${API_BASE_PATH}/platform`, platformRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  if (!env.isProduction && !env.isTest) {
    logger.info(
      { corsOrigins: env.corsOrigins, apiBasePath: API_BASE_PATH },
      'Infinigrow Hospital Cloud API configured',
    )
  }

  return app
}
