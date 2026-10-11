import { describe, expect, it } from 'vitest'

import {
  getContext,
  getTenantContext,
  isPlatformContext,
  requireTenantContext,
  runWithContext,
  type PlatformContext,
  type RequestContext,
} from './tenant-context.js'

/**
 * Tenant context plumbing.
 *
 * Phase 1 attaches this to authentication and the Mongoose tenant plugin. These tests
 * verify the AsyncLocalStorage behaviour that isolation depends on — in particular
 * that a nested async chain still sees the right context, and that a missing context
 * fails loudly instead of silently reading across tenants.
 */

function tenantContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: 'req-1',
    userId: 'user-1' as RequestContext['userId'],
    membershipId: 'mem-1' as RequestContext['membershipId'],
    role: 'DOCTOR',
    hospitalId: 'hospital-a' as RequestContext['hospitalId'],
    permissions: ['patient:read'],
    ip: '127.0.0.1',
    userAgent: 'vitest',
    ...overrides,
  }
}

function platformContext(): PlatformContext {
  return {
    requestId: 'req-2',
    userId: 'super-1' as PlatformContext['userId'],
    role: 'SUPER_ADMIN',
    ip: '127.0.0.1',
    userAgent: 'vitest',
  }
}

describe('runWithContext', () => {
  it('exposes the bound tenant context inside the callback', () => {
    runWithContext(tenantContext(), () => {
      const context = getTenantContext()
      expect(context?.hospitalId).toBe('hospital-a')
      expect(context?.role).toBe('DOCTOR')
    })
  })

  it('preserves the context across nested async operations', async () => {
    const result = await runWithContext(tenantContext(), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      await Promise.resolve()
      return getTenantContext()?.hospitalId
    })

    expect(result).toBe('hospital-a')
  })

  it('keeps concurrent contexts isolated from one another', async () => {
    const [a, b] = await Promise.all([
      runWithContext(
        tenantContext({ hospitalId: 'hospital-a' as RequestContext['hospitalId'] }),
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return getTenantContext()?.hospitalId
        },
      ),
      runWithContext(
        tenantContext({ hospitalId: 'hospital-b' as RequestContext['hospitalId'] }),
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return getTenantContext()?.hospitalId
        },
      ),
    ])

    expect(a).toBe('hospital-a')
    expect(b).toBe('hospital-b')
  })

  it('returns null outside any bound context', () => {
    expect(getContext()).toBeUndefined()
    expect(getTenantContext()).toBeNull()
  })

  it('restores the previous context after the callback completes', () => {
    runWithContext(tenantContext(), () => {
      /* noop */
    })
    expect(getTenantContext()).toBeNull()
  })
})

describe('platform context', () => {
  it('is visible via getContext but not as a tenant context', () => {
    runWithContext(platformContext(), () => {
      expect(getContext()?.role).toBe('SUPER_ADMIN')
      // A platform operation has no hospital scope, so tenant-scoped access must fail.
      expect(getTenantContext()).toBeNull()
    })
  })

  it('identifies platform contexts distinctly', () => {
    runWithContext(platformContext(), () => {
      const context = getContext()
      expect(context).toBeDefined()
      expect(isPlatformContext(context!)).toBe(true)
    })

    runWithContext(tenantContext(), () => {
      const context = getContext()
      expect(isPlatformContext(context!)).toBe(false)
    })
  })
})

describe('requireTenantContext', () => {
  it('returns the context when one is bound', () => {
    runWithContext(tenantContext(), () => {
      expect(requireTenantContext('patients.find').hospitalId).toBe('hospital-a')
    })
  })

  it('throws when no context is bound, rather than allowing an unscoped read', () => {
    // This is the guard that makes a cross-tenant query impossible to perform by
    // accident. A missing scope must be a hard failure, never a silent full read.
    expect(() => requireTenantContext('patients.find')).toThrow(/Tenant context required/)
  })

  it('throws for a platform context, which carries no hospital scope', () => {
    runWithContext(platformContext(), () => {
      expect(() => requireTenantContext('patients.find')).toThrow(/Tenant context required/)
    })
  })
})
