import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose, { type Model } from 'mongoose'

import { runWithContext, type RequestContext } from '../infrastructure/db/tenant-context.js'
import { connectToDatabase, disconnectFromDatabase } from '../infrastructure/db/connection.js'
import { tenantScopedSchema } from '../infrastructure/db/tenant-plugin.js'
import { tryStartTestDatabase } from './mongo.js'

/**
 * META-TEST: proves the isolation suite is capable of failing.
 *
 * The tenant plugin's original injection used `query.set(...)`, which does not affect
 * `getFilter()` in mongoose 9.11.1 — the call silently no-opped, so EVERY
 * "tenant-scoped" read returned EVERY tenant's rows, which is the exact leak the
 * plugin exists to prevent. The isolation tests passed while it was broken because
 * they seeded through a path that did not exercise the filter.
 *
 * A safety mechanism that cannot fail is not a safety mechanism. This file builds a
 * deliberately un-scoped model and asserts that a cross-tenant read DOES return the
 * other hospital's row. If that assertion ever fails, the suite is broken and can no
 * longer detect a real leak.
 */

const db = await tryStartTestDatabase()

const HOSPITAL_A = new mongoose.Types.ObjectId()
const HOSPITAL_B = new mongoose.Types.ObjectId()

/** A plain schema with NO tenant plugin — stands in for "no protection". */
const UnprotectedModel: Model<Record<string, unknown>> =
  (mongoose.models['Unprotected'] as Model<Record<string, unknown>> | undefined) ??
  mongoose.model<Record<string, unknown>>(
    'Unprotected',
    new mongoose.Schema<Record<string, unknown>>({
      hospitalId: { type: mongoose.Schema.Types.ObjectId, required: true },
      value: { type: String, required: true },
    }),
  )

/** The real protected model. */
const ProtectedModel: Model<Record<string, unknown>> =
  (mongoose.models['Protected'] as Model<Record<string, unknown>> | undefined) ??
  mongoose.model<Record<string, unknown>>(
    'Protected',
    tenantScopedSchema<Record<string, unknown>>('Protected', {
      value: { type: String, required: true },
    }),
  )

function contextFor(hospitalId: mongoose.Types.ObjectId): RequestContext {
  return {
    requestId: 'req-meta',
    userId: new mongoose.Types.ObjectId() as RequestContext['userId'],
    membershipId: new mongoose.Types.ObjectId() as RequestContext['membershipId'],
    role: 'HOSPITAL_ADMIN',
    hospitalId: hospitalId as unknown as RequestContext['hospitalId'],
    permissions: [],
    ip: '127.0.0.1',
    userAgent: 'vitest',
  }
}

describe.skipIf(!db.uri)('isolation meta-test (the suite can fail)', () => {
  beforeAll(async () => {
    await connectToDatabase(db.uri as string, 'infinigrow_meta_test')
  })

  beforeEach(async () => {
    const collections = await mongoose.connection.db?.collections()
    await Promise.all((collections ?? []).map((collection) => collection.deleteMany({})))

    await UnprotectedModel.collection.insertMany([
      { hospitalId: HOSPITAL_A, value: 'a' },
      { hospitalId: HOSPITAL_B, value: 'b' },
    ])
  })

  afterAll(async () => {
    await disconnectFromDatabase()
  })

  it('an UNPROTECTED model leaks both hospitals', async () => {
    // If this fails, the database is not actually returning other tenants' rows and
    // every "the plugin blocks this" assertion elsewhere would be vacuous.
    const rows = await runWithContext(contextFor(HOSPITAL_A), () =>
      UnprotectedModel.find({}).exec(),
    )

    expect(rows).toHaveLength(2)
  })

  it('the PROTECTED model returns only its own tenant', async () => {
    await runWithContext(contextFor(HOSPITAL_A), () =>
      ProtectedModel.create({ hospitalId: HOSPITAL_A, value: 'a' }),
    )
    await runWithContext(contextFor(HOSPITAL_B), () =>
      ProtectedModel.create({ hospitalId: HOSPITAL_B, value: 'b' }),
    )

    const rows = await runWithContext(contextFor(HOSPITAL_A), () => ProtectedModel.find({}).exec())

    expect(rows).toHaveLength(1)
  })

  it('both models read the same underlying data, so the difference is the plugin', async () => {
    await runWithContext(contextFor(HOSPITAL_A), () =>
      ProtectedModel.create({ hospitalId: HOSPITAL_A, value: 'a' }),
    )

    const [unprotected, protectedRows] = await Promise.all([
      UnprotectedModel.find({}).exec(),
      runWithContext(contextFor(HOSPITAL_A), () => ProtectedModel.find({}).exec()),
    ])

    // Same rows exist; only the tenant-scoped model hides B's.
    expect(unprotected.length).toBeGreaterThanOrEqual(2)
    expect(protectedRows).toHaveLength(1)
  })
})
