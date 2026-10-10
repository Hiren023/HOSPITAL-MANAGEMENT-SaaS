import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'

/**
 * Ephemeral MongoDB for integration tests.
 *
 * A real `mongod` is used rather than a mock, so index, unique-constraint and operator
 * behaviour is exercised faithfully.
 *
 * SINGLETON, held on `globalThis`: Vitest runs test files sequentially in a reused
 * worker, and module state is not reliably isolated between them. An earlier version
 * kept the server in a module-level variable, so file A's teardown stopped the database
 * file B was still using — surfacing as ECONNREFUSED in whichever file ran next.
 *
 * The server is therefore started at most once per process and deliberately NOT stopped
 * between files; the OS reclaims it when the run ends.
 */

interface GlobalMongoState {
  server: MongoMemoryServer | null
  starting: Promise<MongoMemoryServer> | null
  failed: string | null
}

const globalRef = globalThis as typeof globalThis & { __igcMongo?: GlobalMongoState }

function state(): GlobalMongoState {
  globalRef.__igcMongo ??= { server: null, starting: null, failed: null }
  return globalRef.__igcMongo
}

export async function startTestDatabase(): Promise<string> {
  const store = state()

  if (store.server) return store.server.getUri()

  store.starting ??= MongoMemoryServer.create()
    .then((server) => {
      store.server = server
      return server
    })
    .catch((error: unknown) => {
      store.failed = error instanceof Error ? error.message : String(error)
      store.starting = null
      throw error
    })

  const server = await store.starting
  return server.getUri()
}

/**
 * Release the shared server.
 *
 * Only call from a suite that owns the whole process. The auth suites deliberately do
 * NOT call this, because another file may still be using the same database.
 */
export async function stopTestDatabase(): Promise<void> {
  const store = state()
  if (!store.server) return
  await store.server.stop()
  store.server = null
  store.starting = null
}

/** Remove every document while keeping the connection and indexes intact. */
export async function clearDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return

  const collections = await mongoose.connection.db?.collections()
  if (!collections) return

  await Promise.all(collections.map((collection) => collection.deleteMany({})))
}

/**
 * Attempt to start the in-memory database.
 *
 * `mongodb-memory-server` downloads a `mongod` binary on first run. On a machine without
 * access to the download host that fails; tests depending on it are then SKIPPED and
 * reported as skipped rather than silently passing.
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