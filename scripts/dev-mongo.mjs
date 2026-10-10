/**
 * Local development MongoDB.
 *
 * Docker is not available on the development machine, and MongoDB is not installed.
 * This starts a real `mongod` on a fixed port so `npm run dev:api` has a genuine
 * database to talk to — the same topology as Atlas, rather than a mock.
 *
 * The binary is downloaded once by `mongodb-memory-server` and reused afterwards.
 *
 * Usage:
 *   npm run dev:db
 *
 * Then copy the printed URI into `.env` as MONGODB_URI.
 *
 * This is a DEVELOPMENT convenience. It must never be used for staging or
 * production: there is no backup, no replica set and no authentication.
 */

import process from 'node:process'
import { MongoMemoryServer } from 'mongodb-memory-server'

const PORT = Number(process.env.DEV_MONGO_PORT ?? 27017)
const DB_NAME = process.env.DEV_MONGO_DB ?? 'infinigrow_dev'

async function main() {
  console.log(`[dev:db] starting mongod on port ${PORT}…`)

  const server = await MongoMemoryServer.create({
    instance: { port: PORT, dbName: DB_NAME },
  })

  const uri = server.getUri()

  console.log('')
  console.log('  Infinigrow Hospital Cloud — local database')
  console.log('  -----------------------------------------')
  console.log(`  URI : ${uri}`)
  console.log(`  DB  : ${DB_NAME}`)
  console.log('')
  console.log('  Add this to your .env (Ctrl+C to stop):')
  console.log(`      MONGODB_URI=${uri}`)
  console.log(`      MONGODB_DB_NAME=${DB_NAME}`)
  console.log('')
  console.log('  Data is in-memory and is LOST when this process stops.')
  console.log('')

  const shutdown = async (signal) => {
    console.log(`\n[dev:db] ${signal} received, stopping mongod…`)
    await server.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('[dev:db] failed to start:', error instanceof Error ? error.message : error)
  process.exit(1)
})
