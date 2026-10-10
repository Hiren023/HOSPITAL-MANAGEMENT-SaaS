import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose, { type Model } from 'mongoose'

import { runWithContext, type RequestContext } from '../infrastructure/db/tenant-context.js'
import { connectToDatabase, disconnectFromDatabase } from '../infrastructure/db/connection.js'
import { tenantScopedSchema, withPlatformScope } from '../infrastructure/db/tenant-plugin.js'
import { tryStartTestDatabase } from './mongo.js'

/**
 * Platform-scope escape hatch.
 *
 * `withPlatformScope` is the only sanctioned way to read across tenants. If it were a
 * module-level boolean instead of async-context storage, an unrelated concurrent
 * request would silently inherit bypass access. These tests pin that it does not.
 */

const db = await tryStartTestDatabase()

const HOSPITAL_A = new mongoose.Types.ObjectId()
const HOSPITAL_B = new mongoose.Types.ObjectId()

const ScopedModel: Model<Record<string, unknown>> =
  (mongoose.models['PlatformScoped'] as Model<Record<string, unknown>> | undefined) ??
  mongoose.model<Record<string, unknown>>(
    'PlatformScoped',
    tenantScopedSchema<Record<string, unknown>>('PlatformScoped', {
      value: { type: String, required: true },
    }),
  )

function contextFor(hospitalId: mongoose.Types.ObjectId): RequestContext {
  return {
    requestId: 'req-platform-probe',
    userId: new mongoose.Types.ObjectId() as RequestContext['userId'],
    membershipId: new mongoose.Types.ObjectId() as RequestContext['membershipId'],
    role: 'HOSPITAL_ADMIN',
    hospitalId: hospitalId as unknown as RequestContext['hospitalId'],
    permissions: new Set(),
    ip: '127.0.0.1',
    userAgent: 'vitest',
  }
}

async function seedBoth(): Promise<void> {
  for (const [hospitalId, value] of [
    [HOSPITAL_A, 'a'],
    [HOSPITAL_B, 'b'],
  ] as const) {
    await runWithContext(contextFor(hospitalId), () =>
      ScopedModel.create({ hospitalId, value }),
    )
  }
}

describe.skipIf(!db.uri)('platform scope', () => {
  beforeAll(async () => {
    await connectToDatabase(db.uri as string, 'infinigrow_platform_probe')
  })

  beforeEach(async () => {
    const collections = await mongoose.connection.db?.collections()
    await Promise.all((collections ?? []).map((collection) => collection.deleteMany({})))
  })

  afterAll(async () => {
    await disconnectFromDatabase()
  })

  it('refuses to nest (nesting signals a control-flow misunderstanding)', async () => {
    // withPlatformScope is SYNCHRONOUS and rethrows synchronously, so the guard must
    // be asserted with a plain try/catch — `expect(...).rejects` never sees it.
    let thrown: Error | null = null
    try {
      withPlatformScope(() => withPlatformScope(() => undefined))
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown?.message).toMatch(/must not nest/)
  })

  it('reads across tenants inside the callback', async () => {
    await seedBoth()

    const rows = await withPlatformScope(() => ScopedModel.find({}).exec())

    expect(rows).toHaveLength(2)
  })

  it('is released when the callback returns', async () => {
    await seedBoth()

    await withPlatformScope(() => ScopedModel.find({}).exec())

    // Back in a tenant context: still scoped to A alone.
    const scoped = await runWithContext(contextFor(HOSPITAL_A), () => ScopedModel.find({}).exec())
    expect(scoped).toHaveLength(1)
  })

  it('is released when the callback throws', async () => {
    await seedBoth()

    let thrown: Error | null = null
    try {
      await withPlatformScope(async () => {
        await Promise.resolve()
        throw new Error('boom')
      })
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown?.message).toBe('boom')

    const scoped = await runWithContext(contextFor(HOSPITAL_A), () => ScopedModel.find({}).exec())
    expect(scoped).toHaveLength(1)
  })

  it('does NOT leak bypass access to a concurrent tenant request', async () => {
    // THE regression guard: with a module-level flag, the concurrent query below would
    // inherit platform scope and return both hospitals' rows.
    await seedBoth()

    const [platformRows, tenantRows] = await Promise.all([
      withPlatformScope(() => ScopedModel.find({}).exec()),
      runWithContext(contextFor(HOSPITAL_A), () => ScopedModel.find({}).exec()),
    ])

    expect(platformRows).toHaveLength(2)
    expect(tenantRows).toHaveLength(1)
    expect(tenantRows[0]?.['value']).toBe('a')
  })

  it('still requires a tenant context outside any platform scope', async () => {
    await expect(ScopedModel.find({}).exec()).rejects.toThrow(/Tenant context is required/)
  })
})