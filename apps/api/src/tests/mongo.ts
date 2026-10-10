import { MongoMemoryServer } from 'mongodb-memory-server'

import { disconnectFromDatabase, isDatabaseReady } from '../infrastructure/db/connection.js'

/**
 * Ephemeral MongoDB for integration tests.
 *
 * Uses a real `mongod` binary rather than a mock, so query semantics (indexes, unique
 * constraints, operator behaviour) are exercised faithfully.
 */

let mongod: MongoMemoryServer | null = null

export async function startTestDatabase(): Promise<string> {
  if (!mongod) {
    mongod = await MongoMemoryServer.create()
  }
  return mongod.getUri()
}

export async function stopTestDatabase(): Promise<void> {
  await disconnectFromDatabase()
  if (mongod) {
    await mongod.stop()
    mongod = null
  }
}

/** Remove every document while keeping the connection and indexes intact. */
export async function clearDatabase(): Promise<void> {
  if (!isDatabaseReady()) return

  // Imported lazily so this helper can be used before a connection exists.
  const mongoose = (await import('mongoose')).default
  const collections = await mongoose.connection.db?.collections()
  if (!collections) return

  await Promise.all(collections.map((collection) => collection.deleteMany({})))
}

/**
 * Attempt to start the in-memory database.
 *
 * `mongodb-memory-server` downloads a `mongod` binary on first run. On a machine
 * without access to the download host that fails; tests depending on it are then
 * skipped and reported as skipped rather than silently passing.
 */
export async function tryStartTestDatabase(): Promise<{ uri: string | null; error: string | null }> {
  try {
    return { uri: await startTestDatabase(), error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `\n[mongodb-memory-server] Unavailable — database-dependent tests will be SKIPPED.\n` +
        `Reason: ${message}\n` +
        `Fix: allow access to the MongoDB binary download host, or point MONGODB_URI at a\n` +
        `     local disposable MongoDB instance before running the tests.\n`,
    )
    return { uri: null, error: message }
  }
}