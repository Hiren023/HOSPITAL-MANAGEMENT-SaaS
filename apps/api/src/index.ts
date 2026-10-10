import type { Server } from 'node:http'
import process from 'node:process'

import { createApp } from './app.js'
import { SERVICE_NAME, SERVICE_VERSION } from './config/constants.js'
import { env } from './config/env.js'
import { connectToDatabase, disconnectFromDatabase } from './infrastructure/db/connection.js'
import { logger } from './infrastructure/logger.js'

/**
 * Process bootstrap.
 *
 * Everything listenable lives here rather than in `app.ts`, so the application can be
 * imported by tests without opening a socket.
 */

/** Time allowed for in-flight requests to finish before the process exits. */
const SHUTDOWN_GRACE_MS = 15_000

async function bootstrap(): Promise<void> {
  try {
    await connectToDatabase()
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to connect to MongoDB — refusing to start')
    process.exit(1)
  }

  const app = createApp()

  const server: Server = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      { port: env.PORT, host: env.HOST, env: env.NODE_ENV },
      `${SERVICE_NAME} v${SERVICE_VERSION} listening`,
    )
  })

  let shuttingDown = false

  const shutdown = async (signal: string): Promise<void> => {
    // A second Ctrl-C must not start a second shutdown.
    if (shuttingDown) return
    shuttingDown = true

    logger.info({ signal }, 'Shutdown requested')

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit')
      process.exit(1)
    }, SHUTDOWN_GRACE_MS)
    forceExit.unref()

    server.close(async (serverError) => {
      if (serverError) {
        logger.error({ err: serverError }, 'Error while closing HTTP server')
      }

      try {
        await disconnectFromDatabase()
      } catch (databaseError) {
        logger.error({ err: databaseError }, 'Error while disconnecting from MongoDB')
      }

      clearTimeout(forceExit)
      process.exit(serverError ? 1 : 0)
    })
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection')
    void shutdown('unhandledRejection')
  })

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception — process state is undefined')
    void shutdown('uncaughtException')
  })
}

void bootstrap()