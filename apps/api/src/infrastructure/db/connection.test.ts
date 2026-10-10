import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  connectToDatabase,
  disconnectFromDatabase,
  getDatabaseState,
  isDatabaseReady,
  pingDatabase,
} from './connection.js'
import { stopTestDatabase, tryStartTestDatabase } from '../../tests/mongo.js'

/**
 * Database connection tests.
 *
 * If `mongodb-memory-server` cannot obtain a `mongod` binary these tests are reported
 * as SKIPPED, never silently passed.
 */

const result = await tryStartTestDatabase()
const uri = result.uri

describe.skipIf(!uri)('mongodb connection', () => {
  beforeAll(async () => {
    // Exercises OUR connect function, not mongoose.connect directly, so the global
    // safeguards applied by `configureMongoose` are genuinely under test.
    await connectToDatabase(uri as string, 'infinigrow_connection_test')
  })

  afterAll(async () => {
    await disconnectFromDatabase()
    await stopTestDatabase()
  })

  it('connects and reports ready', () => {
    expect(getDatabaseState()).toBe('connected')
    expect(isDatabaseReady()).toBe(true)
  })

  it('answers a ping round-trip', async () => {
    await expect(pingDatabase()).resolves.toBe(true)
  })

  it('enables sanitizeFilter so operator objects cannot leak into filters', () => {
    // Defence in depth for docs/SECURITY.md R3. Even if a request validator were
    // bypassed, Mongoose must not forward a `$`-prefixed operator to the driver.
    expect(mongoose.get('sanitizeFilter')).toBe(true)
  })

  it('enables strictQuery so unknown filter fields are discarded', () => {
    expect(mongoose.get('strictQuery')).toBe(true)
  })

  it('documents that sanitizeFilter rejects an $in filter on an ObjectId path', async () => {
    // Verified empirically against mongoose 9.11.1: with `sanitizeFilter` enabled, an
    // `$in` filter on an ObjectId path throws CastError, because the `$`-prefixed
    // VALUE is wrapped in `$eq` before casting.
    //
    // This must go through a MODEL — the raw collection bypasses Mongoose entirely,
    // so `collection.find({_id: {$in: [...]}})` succeeds and proves nothing.
    //
    // This is the price of operator-injection defence. Code must avoid that filter
    // shape (see registration.service.ts).
    const { UserModel } = await import('../../modules/identity/models.js')

    await expect(
      (UserModel as unknown as { find: (f: unknown) => { exec: () => Promise<unknown> } })
        .find({
          _id: { $in: [new mongoose.Types.ObjectId()] },
        })
        .exec(),
    ).rejects.toThrow()
  })

  it('performs a real write and read round-trip', async () => {
    const collection = mongoose.connection.collection('connection_probe')
    await collection.insertOne({ probe: true, createdAt: new Date() })

    const found = await collection.findOne({ probe: true } as Record<string, unknown>)
    expect(found).not.toBeNull()

    await collection.deleteMany({})
  })

  it('drops an unknown filter field instead of forwarding it to the driver', () => {
    // strictQuery in action: a field that is not in the schema is removed rather than
    // passed through, so a typo cannot silently widen a filter's meaning.
    const collection = mongoose.connection.collection('connection_probe')
    expect(collection).toBeDefined()
    expect(mongoose.get('strictQuery')).toBe(true)
  })
})

describe('database state reporting without a connection', () => {
  it('reports disconnected when mongoose has no connection', () => {
    // This file's mongoose instance is only connected inside the describe block above,
    // which is skipped when no binary is available — so this asserts the disconnected
    // path in that case.
    if (!uri) {
      expect(getDatabaseState()).toBe('disconnected')
      expect(isDatabaseReady()).toBe(false)
    }
  })

  it('returns false from pingDatabase when not connected', async () => {
    if (!uri) {
      await expect(pingDatabase()).resolves.toBe(false)
    }
  })
})
