import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  dbPath: string | null
}

const globalRef = globalThis as typeof globalThis & { __igcMongo?: GlobalMongoState }

function state(): GlobalMongoState {
  globalRef.__igcMongo ??= { server: null, starting: null, failed: null, dbPath: null }
  return globalRef.__igcMongo
}

/**
 * A STABLE, self-healing data directory.
 *
 * Without this, `MongoMemoryServer.create()` allocates a fresh `mongo-mem-XXXX` temp
 * directory per run and never removes it. Those accumulate at roughly 150 MB each; a
 * long enough session fills the disk, at which point `mongod` aborts at startup with an
 * opaque `fassert() failure` and every database-backed test silently SKIPS. That is a
 * genuinely misleading failure — the suite reports "skipped" rather than "broken".
 *
 * The directory is named after THIS process id, which makes two concurrent test runs
 * independent rather than fighting over one path. Crucially, the exit handler alone is
 * not enough: an exit handler does not run when the process is killed outright (a
 * truncated CI pipe, a cancelled run, an OOM kill), and every such run leaks a
 * directory. So on startup we also sweep directories left by processes that no longer
 * exist. Cleanup therefore does not depend on the run finishing tidily.
 */
function stableDataPath(): string {
  const store = state()
  if (store.dbPath) return store.dbPath

  sweepAbandonedDataPaths()

  store.dbPath = join(tmpdir(), `igc-test-db-${process.pid}`)
  rmSync(store.dbPath, { recursive: true, force: true })
  mkdirSync(store.dbPath, { recursive: true })

  process.once('exit', () => {
    try {
      if (store.dbPath) rmSync(store.dbPath, { recursive: true, force: true })
    } catch {
      // Best effort: a locked file on Windows must not turn a passing run into a
      // non-zero exit code.
    }
  })

  return store.dbPath
}

/** Remove `igc-test-db-*` directories whose owning process is gone. */
function sweepAbandonedDataPaths(): void {
  const prefix = 'igc-test-db-'
  let entries: string[]

  try {
    entries = readdirSync(tmpdir())
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue

    const pid = Number(entry.slice(prefix.length))
    if (!Number.isInteger(pid) || pid <= 0) continue

    // Our own directory belongs to this process; leave it alone.
    if (pid === process.pid) continue

    try {
      // Signal 0 performs the permission/existence check without delivering anything.
      // A dead process reports ESRCH, so this is a safe liveness test that works
      // identically on Windows and POSIX.
      process.kill(pid, 0)
      continue
    } catch (error) {
      // EPERM means the process exists but belongs to another user — also alive.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') continue
    }

    try {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true })
    } catch {
      // Still locked by a dying process; the next run will sweep it.
    }
  }
}

export async function startTestDatabase(): Promise<string> {
  const store = state()

  if (store.server) return store.server.getUri()

  store.starting ??= MongoMemoryServer.create({
    instance: { dbPath: stableDataPath(), storageEngine: 'wiredTiger' },
  })
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

  // Remove the data directory here as well as on exit, so a run that owns the whole
  // process leaves nothing behind.
  if (store.dbPath) {
    try {
      rmSync(store.dbPath, { recursive: true, force: true })
    } catch {
      // Locked on Windows if mongod has not fully exited; the exit handler retries.
    }
    store.dbPath = null
  }
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
export async function tryStartTestDatabase(): Promise<{
  uri: string | null
  error: string | null
}> {
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
