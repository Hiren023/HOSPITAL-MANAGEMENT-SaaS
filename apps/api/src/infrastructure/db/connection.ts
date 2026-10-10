import mongoose from 'mongoose'

import { env } from '../../config/env.js'
import { logger } from '../logger.js'

/**
 * MongoDB connection management.
 *
 * Two global Mongoose safeguards are enabled here, because they must be on before
 * any model is compiled:
 *
 *  - `sanitizeFilter`: strips objects containing `$` keys from query filters, which
 *    blocks the most common NoSQL operator-injection vector (docs/SECURITY.md R3).
 *  - `strictQuery`: unknown query fields are discarded rather than silently passed to
 *    the driver, so a typo cannot widen a filter's meaning.
 */

let configured = false

function configureMongoose(): void {
  if (configured) return
  mongoose.set('sanitizeFilter', true)
  mongoose.set('strictQuery', true)
  mongoose.set('strict', true)
  configured = true
}

export async function connectToDatabase(
  uri: string = env.MONGODB_URI,
  dbName: string = env.MONGODB_DB_NAME,
): Promise<typeof mongoose> {
  configureMongoose()

  logger.info({ dbName }, 'Connecting to MongoDB')

  const connection = await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    // Index creation is managed by the migration runner (`ensure-indexes`), not by the
    // driver, so that index builds are explicit, backgrounded and verifiable.
    autoIndex: env.MONGODB_AUTO_INDEX,
    retryWrites: true,
  })

  logger.info({ dbName, readyState: connection.connection.readyState }, 'MongoDB connected')

  return connection
}

export async function disconnectFromDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 0) return
  logger.info('Disconnecting from MongoDB')
  await mongoose.disconnect()
  logger.info('MongoDB disconnected')
}

export type DatabaseState =
  'disconnected' | 'connected' | 'connecting' | 'disconnecting' | 'unknown'

export function getDatabaseState(): DatabaseState {
  const readyState = mongoose.connection.readyState
  switch (readyState) {
    case 0:
      return 'disconnected'
    case 1:
      return 'connected'
    case 2:
      return 'connecting'
    case 3:
      return 'disconnecting'
    default:
      return 'unknown'
  }
}

export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === 1
}

/** Round-trips a `ping` to confirm the server is actually reachable. */
export async function pingDatabase(): Promise<boolean> {
  if (!isDatabaseReady()) return false
  try {
    const db = mongoose.connection.db
    if (!db) return false
    await db.command({ ping: 1 })
    return true
  } catch {
    return false
  }
}
