import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose, { type Model } from 'mongoose'

import {
  assertTenantFilter,
  isPlatformScopeActive,
  tenantScopedSchema,
  withPlatformScope,
} from '../infrastructure/db/tenant-plugin.js'
import { runWithContext, type RequestContext } from '../infrastructure/db/tenant-context.js'
import { connectTestDatabase, resetDatabase } from './auth-harness.js'
import { tryStartTestDatabase } from './mongo.js'

/**
 * `assertTenantFilter` and platform-scope state.
 *
 * This assertion is a deliberate second line of defence: the auto-injection hook is the
 * first, and if that hook is ever removed, mis-registered, or bypassed by a raw driver
 * call, this turns a silent cross-tenant read into a loud failure.
 */

const db = await tryStartTestDatabase()

const HOSPITAL_A = new mongoose.Types.ObjectId()
const HOSPITAL_B = new mongoose.Types.ObjectId()

const ProbeModel: Model<Record<string, unknown>> =
  (mongoose.models['AssertProbe'] as Model<Record<string, unknown>> | undefined) ??
  mongoose.model<Record<string, unknown>>(
    'AssertProbe',
    tenantScopedSchema<Record<string, unknown>>('AssertProbe', {
      value: { type: String, required: true },
    }),
  )

function contextFor(hospitalId: mongoose.Types.ObjectId): RequestContext {
  return {
    requestId: 'assert-probe',
    userId: new mongoose.Types.ObjectId() as RequestContext['userId'],
    membershipId: new mongoose.Types.ObjectId() as RequestContext['membershipId'],
    role: 'HOSPITAL_ADMIN',
    hospitalId: hospitalId as unknown as RequestContext['hospitalId'],
    permissions: new Set(),
    ip: '127.0.0.1',
    userAgent: 'vitest',
  }
}

describe.skipIf(!db.uri)('assertTenantFilter', () => {
  beforeAll(async () => {
    await connectTestDatabase(db.uri as string)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
    // The shared mongod is intentionally left running for sibling suites.
  })

  it('passes when an explicit hospitalId filter is present', () => {
    runWithContext(contextFor(HOSPITAL_A), () => {
      expect(() =>
        assertTenantFilter('AssertProbe', { hospitalId: HOSPITAL_A.toString() }),
      ).not.toThrow()
    })
  })

  it('THROWS when the filter omits hospitalId', () => {
    // Relying on implicit injection is not acceptable in repository code.
    runWithContext(contextFor(HOSPITAL_A), () => {
      expect(() => assertTenantFilter('AssertProbe', { value: 'x' })).toThrow(
        /missing an explicit hospitalId filter/,
      )
    })
  })

  it('THROWS when there is no tenant context at all', () => {
    expect(() => assertTenantFilter('AssertProbe', { hospitalId: HOSPITAL_A.toString() })).toThrow(
      /Tenant context is required/,
    )
  })

  it('does not throw under an explicit platform scope', () => {
    withPlatformScope(() => {
      expect(() => assertTenantFilter('AssertProbe', {})).not.toThrow()
    })
  })

  it('names the model so the failure is diagnosable', () => {
    runWithContext(contextFor(HOSPITAL_A), () => {
      expect(() => assertTenantFilter('AssertProbe', {})).toThrow(/AssertProbe/)
    })
  })
})

describe('platform scope state', () => {
  it('is inactive by default', () => {
    expect(isPlatformScopeActive()).toBe(false)
  })

  it('is active inside the callback only', () => {
    withPlatformScope(() => {
      expect(isPlatformScopeActive()).toBe(true)
    })

    expect(isPlatformScopeActive()).toBe(false)
  })

  it('is inactive again after the callback throws', () => {
    expect(() =>
      withPlatformScope(() => {
        throw new Error('boom')
      }),
    ).toThrow('boom')

    expect(isPlatformScopeActive()).toBe(false)
  })

  it('does not leak to a sibling async execution', async () => {
    const inside = await withPlatformScope(async () => {
      await new Promise((resolve) => setImmediate(resolve))
      return isPlatformScopeActive()
    })

    expect(inside).toBe(true)
    expect(isPlatformScopeActive()).toBe(false)
  })

  it('does not leak to a concurrent request that is not in platform scope', async () => {
    const [inPlatform, inTenant] = await Promise.all([
      withPlatformScope(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return isPlatformScopeActive()
      }),
      runWithContext(contextFor(HOSPITAL_A), async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return isPlatformScopeActive()
      }),
    ])

    expect(inPlatform).toBe(true)
    expect(inTenant).toBe(false)
  })

  it('throws on nesting', () => {
    let thrown: Error | null = null
    try {
      withPlatformScope(() => withPlatformScope(() => undefined))
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown?.message).toMatch(/must not nest/)
  })
})

describe.skipIf(!db.uri)('ProbeModel sanity', () => {
  beforeAll(async () => {
    await connectTestDatabase(db.uri as string)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('auto-injects the tenant filter on a real query', async () => {
    await runWithContext(contextFor(HOSPITAL_A), () =>
      ProbeModel.create({ hospitalId: HOSPITAL_A, value: 'a' }),
    )
    await runWithContext(contextFor(HOSPITAL_B), () =>
      ProbeModel.create({ hospitalId: HOSPITAL_B, value: 'b' }),
    )

    const rows = await runWithContext(contextFor(HOSPITAL_A), () => ProbeModel.find({}).exec())
    expect(rows).toHaveLength(1)
  })
})
