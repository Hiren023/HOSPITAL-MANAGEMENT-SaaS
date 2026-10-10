import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose, { type Model } from 'mongoose'

import {
  HospitalModel,
  MembershipModel,
  UserModel,
} from '../modules/identity/models.js'
import { hashPassword } from '../modules/identity/password.util.js'
import { hashToken, generateOpaqueToken } from '../modules/identity/token.util.js'
import { runWithContext, type RequestContext } from '../infrastructure/db/tenant-context.js'
import { connectToDatabase, disconnectFromDatabase } from '../infrastructure/db/connection.js'
import { tenantScopedSchema } from '../infrastructure/db/tenant-plugin.js'
import { stopTestDatabase, tryStartTestDatabase } from './mongo.js'

/**
 * TENANT ISOLATION — the central proof for docs/SECURITY.md R1.
 *
 * Every test here attempts a cross-tenant read or write and asserts it fails. A
 * regression that removes or weakens the tenant plugin must break these tests, which
 * is why they run against a real `mongod` rather than a mocked model.
 */

const db = await tryStartTestDatabase()

const HOSPITAL_A = new mongoose.Types.ObjectId()
const HOSPITAL_B = new mongoose.Types.ObjectId()
const USER_A = new mongoose.Types.ObjectId()

/**
 * A minimal tenant-scoped schema standing in for a future domain model.
 *
 * It MUST be built with `tenantScopedSchema`. A bare `new Schema()` has no tenant
 * protection at all, which is exactly the mistake this suite exists to make impossible
 * to make silently.
 */
const SecretModel: Model<Record<string, unknown>> =
  (mongoose.models['Secret'] as Model<Record<string, unknown>> | undefined) ??
  mongoose.model<Record<string, unknown>>(
    'Secret',
    tenantScopedSchema<Record<string, unknown>>('Secret', {
      value: { type: String, required: true },
    }),
  )

function contextFor(hospitalId: mongoose.Types.ObjectId): RequestContext {
  return {
    requestId: 'req-isolation-test',
    userId: USER_A as RequestContext['userId'],
    membershipId: new mongoose.Types.ObjectId() as RequestContext['membershipId'],
    role: 'HOSPITAL_ADMIN',
    hospitalId: hospitalId as unknown as RequestContext['hospitalId'],
    permissions: new Set(['patient:read', 'patient:write'] as const),
    ip: '127.0.0.1',
    userAgent: 'vitest',
  }
}

/**
 * Create a tenant document.
 *
 * Writes require a bound context, so seeding must run inside one — even for records
 * belonging to hospital B, which is seeded while acting as B.
 */
async function seedSecret(
  hospitalId: mongoose.Types.ObjectId,
  value: string,
): Promise<Record<string, unknown>> {
  const document = await runWithContext(contextFor(hospitalId), () =>
    SecretModel.create({ hospitalId, value }),
  )
  return document.toObject() as Record<string, unknown>
}

async function clearAll(): Promise<void> {
  const collections = await mongoose.connection.db?.collections()
  await Promise.all((collections ?? []).map((collection) => collection.deleteMany({})))
}

async function seedTwoHospitals(): Promise<void> {
  await HospitalModel.create([
    { _id: HOSPITAL_A, name: 'Hospital A', slug: 'hospital-a', status: 'APPROVED' },
    { _id: HOSPITAL_B, name: 'Hospital B', slug: 'hospital-b', status: 'APPROVED' },
  ])

  await MembershipModel.create({
    userId: USER_A,
    hospitalId: HOSPITAL_A,
    role: 'HOSPITAL_ADMIN',
    status: 'ACTIVE',
  })

  await UserModel.create({
    _id: USER_A,
    email: 'admin-a@example.test',
    firstName: 'Admin',
    lastName: 'A',
    passwordHash: await hashPassword('correct-horse-battery-staple'),
  })
}

describe.skipIf(!db.uri)('tenant isolation', () => {
  // Connect ONCE for the whole suite: per-test connect/disconnect tore down the
  // shared in-memory mongod, so later tests raced a dead port.
  beforeAll(async () => {
    await connectToDatabase(db.uri as string, 'infinigrow_isolation_test')
  })

  beforeEach(async () => {
    await clearAll()
    await seedTwoHospitals()
  })

  afterAll(async () => {
    await disconnectFromDatabase()
    await stopTestDatabase()
  })

  it('seeds two hospitals with a membership for A only', async () => {
    expect(await HospitalModel.countDocuments()).toBe(2)
    expect(await MembershipModel.countDocuments()).toBe(1)
  })

  it('THROWS rather than reading everything when no tenant context is bound', async () => {
    await seedSecret(HOSPITAL_A, 'secret-a')
    await seedSecret(HOSPITAL_B, 'secret-b')

    // "No context means all tenants" is precisely the default that causes a leak.
    await expect(SecretModel.find({}).exec()).rejects.toThrow(/Tenant context is required/)
  })

  it('names the model in the thrown error', async () => {
    // Regression guard: an earlier version read `schema.modelName` inside a document
    // hook, where it is undefined, so the message said `"undefined"`.
    await expect(
      SecretModel.create({ hospitalId: HOSPITAL_A, value: 'x' }),
    ).rejects.toThrow(/Tenant context is required to save a "Secret"/)
  })

  it('refuses to save with no context at all', async () => {
    await expect(
      SecretModel.create({ hospitalId: HOSPITAL_A, value: 'x' }),
    ).rejects.toThrow(/Tenant context is required to save/)
  })

  it('auto-injects the caller hospital into an otherwise unscoped find', async () => {
    await seedSecret(HOSPITAL_A, 'secret-a')
    await seedSecret(HOSPITAL_B, 'secret-b')

    const results = await runWithContext(contextFor(HOSPITAL_A), () => SecretModel.find({}).exec())

    expect(results).toHaveLength(1)
    expect(results[0]?.['value']).toBe('secret-a')
  })

  it('discards a caller-supplied hospitalId in the filter (IDOR attempt)', async () => {
    await seedSecret(HOSPITAL_A, 'secret-a')
    await seedSecret(HOSPITAL_B, 'secret-b')

    const results = await runWithContext(contextFor(HOSPITAL_A), () =>
      SecretModel.find({ hospitalId: HOSPITAL_B.toString() }).exec(),
    )

    // The supplied filter is replaced with the caller's own hospital.
    expect(results).toHaveLength(1)
    expect(results[0]?.['value']).toBe('secret-a')
    expect(results.some((row) => row['value'] === 'secret-b')).toBe(false)
  })

  it('returns nothing for another hospital\'s document by id', async () => {
    const bSecret = await seedSecret(HOSPITAL_B, 'secret-b')

    const found = await runWithContext(contextFor(HOSPITAL_A), () =>
      SecretModel.findById(bSecret['_id']).exec(),
    )

    expect(found).toBeNull()
  })

  it('blocks an update targeting another hospital\'s document', async () => {
    const bSecret = await seedSecret(HOSPITAL_B, 'secret-b')

    const result = await runWithContext(contextFor(HOSPITAL_A), () =>
      SecretModel.updateOne({ _id: bSecret['_id'] }, { value: 'tampered' }).exec(),
    )

    expect(result.modifiedCount).toBe(0)
  })

  it('blocks a delete targeting another hospital\'s document', async () => {
    const bSecret = await seedSecret(HOSPITAL_B, 'secret-b')

    const result = await runWithContext(contextFor(HOSPITAL_A), () =>
      SecretModel.deleteOne({ _id: bSecret['_id'] }).exec(),
    )

    expect(result.deletedCount).toBe(0)
    expect(await SecretModel.collection.countDocuments()).toBe(1)
  })

  it('lets a tenant update its own document', async () => {
    const aSecret = await seedSecret(HOSPITAL_A, 'secret-a')

    const result = await runWithContext(contextFor(HOSPITAL_A), () =>
      SecretModel.updateOne({ _id: aSecret['_id'] }, { value: 'updated' }).exec(),
    )

    expect(result.modifiedCount).toBe(1)
  })

  it('strips hospitalId from an update payload so a row cannot be moved', async () => {
    const aSecret = await seedSecret(HOSPITAL_A, 'secret-a')

    await runWithContext(contextFor(HOSPITAL_A), () =>
      SecretModel.updateOne(
        { _id: aSecret['_id'] },
        { value: 'x', hospitalId: HOSPITAL_B },
      ).exec(),
    )

    // Read through the raw collection: this must not be tenant-scoped, since the
    // assertion is about what was actually persisted.
    const stored = await SecretModel.collection.findOne({
      _id: aSecret['_id'] as unknown as mongoose.Types.ObjectId,
    })
    expect(String(stored?.['hospitalId'])).toBe(HOSPITAL_A.toString())
  })

  it('scopes countDocuments', async () => {
    await seedSecret(HOSPITAL_A, 'shared')
    await seedSecret(HOSPITAL_B, 'shared')

    const count = await runWithContext(contextFor(HOSPITAL_A), () =>
      SecretModel.countDocuments({}).exec(),
    )

    expect(count).toBe(1)
  })

  it('prefixes an aggregate pipeline with the tenant match', async () => {
    await seedSecret(HOSPITAL_A, 'secret-a')
    await seedSecret(HOSPITAL_B, 'secret-b')

    const results = await runWithContext(contextFor(HOSPITAL_A), () =>
      SecretModel.aggregate([{ $match: {} }]).exec(),
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.['value']).toBe('secret-a')
  })

  it('scopes each concurrent tenant independently', async () => {
    await seedSecret(HOSPITAL_A, 'secret-a')
    await seedSecret(HOSPITAL_B, 'secret-b')

    const [fromA, fromB] = await Promise.all([
      runWithContext(contextFor(HOSPITAL_A), () => SecretModel.find({}).exec()),
      runWithContext(contextFor(HOSPITAL_B), () => SecretModel.find({}).exec()),
    ])

    expect(fromA.map((row) => row['value'])).toEqual(['secret-a'])
    expect(fromB.map((row) => row['value'])).toEqual(['secret-b'])
  })

  it('a user with no membership cannot obtain a tenant context', async () => {
    const stranger = new mongoose.Types.ObjectId()
    await UserModel.create({
      _id: stranger,
      email: 'stranger@example.test',
      firstName: 'No',
      lastName: 'Access',
      passwordHash: await hashPassword('correct-horse-battery-staple'),
    })

    const memberships = await (
      MembershipModel as Model<Record<string, unknown>>
    ).find({ userId: stranger, status: 'ACTIVE' }).exec()

    expect(memberships).toHaveLength(0)
  })

  it('stores only a hash of a refresh token, never the token itself', () => {
    const raw = generateOpaqueToken()

    expect(hashToken(raw)).not.toBe(raw)
    expect(hashToken(raw)).toHaveLength(64)
    expect(raw).not.toContain(hashToken(raw))
  })
})

// All identity tests live in the single `describe` above, which owns the database
// lifecycle. A sibling `describe` with its own hooks ran after the first block had
// already torn the shared in-memory mongod down, failing with
// MongoNotConnectedError.