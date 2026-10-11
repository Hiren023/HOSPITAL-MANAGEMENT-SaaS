import type { NextFunction, Request, Response } from 'express'
import type { Model } from 'mongoose'
import { resolvePermissions, type Permission, type Role } from '@infinigrow/shared'

import { ApiError } from '../infrastructure/api-error.js'
import { keysFromEnv, verifyAccessToken } from '../modules/identity/access-token.util.js'
import {
  runWithContext,
  type PlatformContext,
  type RequestContext,
} from '../infrastructure/db/tenant-context.js'
import { MembershipModel, UserModel } from '../modules/identity/models.js'

/**
 * Authentication and authorisation middleware.
 *
 * The single most important property of this file: the tenant context is derived from
 * the caller's MEMBERSHIP, never from anything in the request. There is no code path
 * that reads a hospital id from a body, query or path and treats it as proof of access
 * (docs/PROJECT_PROPOSAL.md §6.2).
 */

declare module 'express-serve-static-core' {
  interface Request {
    /** Bound for the lifetime of this request. */
    auth?: RequestContext | PlatformContext
    /** Narrowed typing helper for tenant-scoped handlers. */
    tenant?: RequestContext
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, value] = header.split(' ')
  if (!value || scheme?.toLowerCase() !== 'bearer') return null
  return value.trim() || null
}

/**
 * Verify the bearer token and bind a tenant or platform context.
 *
 * A `SUPER_ADMIN` receives a `PlatformContext` with no hospital scope at all, so any
 * attempt to reach tenant data fails closed rather than defaulting to "no hospital
 * means all hospitals".
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = bearerToken(req.headers.authorization)
    if (!token) throw ApiError.unauthenticated('Authentication required')

    const secrets = keysFromEnv(process.env)
    const claims = await verifyAccessToken(token, secrets)

    // Re-read the user on every request rather than trusting the token body alone, so
    // a suspension or deletion takes effect immediately rather than at token expiry
    // (docs/SECURITY.md R4).
    const user = await (UserModel as Model<Record<string, unknown>>)
      .findById(claims.userId)
      .select('status lockedUntil email firstName lastName')
      .lean()
      .exec()

    if (!user) throw ApiError.unauthenticated('Invalid or expired access token')

    const userStatus = user['status'] as string | undefined
    if (userStatus && userStatus !== 'ACTIVE') {
      throw ApiError.forbidden('This account is not active')
    }

    const lockedUntil = user['lockedUntil'] as Date | undefined
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      throw new ApiError('ACCOUNT_LOCKED', 'This account is temporarily locked')
    }

    const common = {
      requestId: req.requestId,
      userId: claims.userId as RequestContext['userId'],
      role: claims.role as Role,
      ip: req.ip ?? '',
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500),
    }

    if (claims.role === 'SUPER_ADMIN' && !claims.hospitalId) {
      runWithContext({ ...common } satisfies PlatformContext, () => {
        req.auth = { ...common } satisfies PlatformContext
        next()
      })
      return
    }

    if (!claims.hospitalId || !claims.membershipId) {
      throw ApiError.unauthenticated('Invalid or expired access token')
    }

    // The membership is re-validated on every request: it is the authority for both
    // "may this user act" and "in which hospital".
    const membership = await (MembershipModel as Model<Record<string, unknown>>)
      .findOne({
        _id: claims.membershipId,
        userId: claims.userId,
        hospitalId: claims.hospitalId,
        status: 'ACTIVE',
      })
      .lean()
      .exec()

    if (!membership) {
      throw ApiError.forbidden('Your access to this hospital has been revoked')
    }

    const role = (membership['role'] as Role) ?? claims.role

    // `resolvePermissions` returns a `Set`. Normalised to an array here, once, so every
    // consumer of `req.auth.permissions` can treat it as a list.
    //
    // Leaving it a `Set` is a trap that fails late and unhelpfully: `.includes` and
    // `.map` do not exist on it, so the error surfaces as "…is not a function" from
    // whichever service happens to touch it first, rather than at the point the value
    // was built. `requirePermission` got away with it because it only ever tests
    // membership of the set.
    const permissions = [
      ...resolvePermissions(role, (membership['grantedPermissions'] as string[]) ?? []),
    ]

    const context: RequestContext = {
      ...common,
      membershipId: claims.membershipId as RequestContext['membershipId'],
      role,
      hospitalId: claims.hospitalId as RequestContext['hospitalId'],
      permissions,
    }

    req.auth = context
    req.tenant = context

    runWithContext(context, () => next())
  } catch (error) {
    next(error)
  }
}

/**
 * Require a permission.
 *
 * Must run after `authenticate`. Resolves the permission from the MEMBERSHIP, not from
 * anything the client sent.
 */
export function requirePermission(...required: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const context = req.auth

    if (!context) return next(ApiError.unauthenticated('Authentication required'))

    if (!('permissions' in context)) {
      // A platform actor holds no tenant permission set. Reaching this point means a
      // tenant-only route was mounted without the platform guard.
      return next(ApiError.forbidden('This operation is not available to platform administrators'))
    }

    const missing = required.filter((permission) => !context.permissions.includes(permission))

    if (missing.length > 0) {
      return next(ApiError.forbidden('You do not have permission to perform this action'))
    }

    next()
  }
}

/**
 * Require a tenant scope.
 *
 * Rejects a `SUPER_ADMIN` on a hospital-specific route. This is what stops platform
 * access from silently widening into clinical data
 * (docs/SECURITY.md R3 least-privilege stance).
 */
export function requireTenantScope(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) return next(ApiError.unauthenticated('Authentication required'))
  if (!req.tenant) {
    return next(ApiError.forbidden('This operation requires a hospital context'))
  }
  next()
}

/**
 * Require a platform-level permission (`platform:*`).
 *
 * Guards SUPER_ADMIN management operations. Because the permission set of a platform
 * role contains only `platform:*`, a hospital role can never satisfy this — an
 * explicit check rather than an implicit one.
 */
export function requirePlatformPermission(...required: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const context = req.auth

    if (!context) return next(ApiError.unauthenticated('Authentication required'))

    // A tenant actor carries a permission set; a platform actor deliberately does not.
    // The platform guard therefore ACCEPTS the absence of permissions and rejects the
    // presence of them. Inverting this rejected every legitimate SUPER_ADMIN call.
    const isPlatformActor = !('permissions' in context)

    if (!isPlatformActor) {
      return next(ApiError.forbidden('This operation requires platform administrator access'))
    }

    if (context.role !== 'SUPER_ADMIN') {
      return next(ApiError.forbidden('This operation requires platform administrator access'))
    }

    // Defence in depth: a platform guard must never be given a tenant permission.
    for (const permission of required) {
      if (!permission.startsWith('platform:')) {
        return next(ApiError.forbidden('Only platform-level permissions are accepted here'))
      }
    }

    next()
  }
}
