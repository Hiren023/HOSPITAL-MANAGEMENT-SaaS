import { AsyncLocalStorage } from 'node:async_hooks'
import type { HospitalId, MembershipId, Permission, Role, UserId } from '@infinigrow/shared'

/**
 * The authenticated request context.
 *
 * CRITICAL: `hospitalId` here is ALWAYS derived from the server-verified membership.
 * It is never populated from a request body, query string, or path parameter
 * (docs/ARCHITECTURE.md §6.2).
 *
 * Phase 0 establishes the plumbing; Phase 1 wires it into authentication and the
 * Mongoose tenant plugin that auto-injects `hospitalId` into every query.
 */
export interface RequestContext {
  requestId: string
  userId: UserId
  membershipId: MembershipId
  role: Role
  hospitalId: HospitalId
  permissions: ReadonlySet<Permission>
  ip: string
  userAgent: string
}

/**
 * Platform-level operations (tenant approval, plan management) run without a
 * hospital scope. This is an explicit, narrow opt-in — see docs/SECURITY.md R2.
 */
export interface PlatformContext {
  requestId: string
  userId: UserId
  role: Role
  ip: string
  userAgent: string
}

const storage = new AsyncLocalStorage<RequestContext | PlatformContext>()

/** Run `callback` with the given context bound to the current async execution. */
export function runWithContext<T>(context: RequestContext | PlatformContext, callback: () => T): T {
  return storage.run(context, callback)
}

/** The active tenant context, or null when none is bound. */
export function getContext(): RequestContext | PlatformContext | undefined {
  return storage.getStore()
}

/** The active *tenant* context. Null for platform operations or outside a request. */
export function getTenantContext(): RequestContext | null {
  const context = storage.getStore()
  if (!context) return null
  return 'hospitalId' in context ? context : null
}

/**
 * Returns the tenant context or throws.
 *
 * Called by the Mongoose tenant plugin before any tenant-scoped query executes, so a
 * missing scope is a hard failure rather than a silent full-collection read.
 */
export function requireTenantContext(operation: string): RequestContext {
  const context = getTenantContext()
  if (!context) {
    throw new Error(
      `Tenant context required for "${operation}" but none was bound to this execution`,
    )
  }
  return context
}

export function isPlatformContext(
  context: RequestContext | PlatformContext,
): context is PlatformContext {
  return !('hospitalId' in context)
}
