import { pingDatabase } from '../../infrastructure/db/connection.js'
import type { Request, Response } from 'express'

/**
 * Readiness probe.
 *
 * Returns 503 when a hard dependency is unavailable, so the load balancer stops
 * sending traffic to this instance. Used by container orchestration for rollout
 * decisions.
 */
export async function ready(_req: Request, res: Response): Promise<void> {
  const databaseReachable = await pingDatabase()

  res.status(databaseReachable ? 200 : 503).json({
    success: databaseReachable,
    data: {
      status: databaseReachable ? 'ready' : 'not_ready',
      checks: {
        database: databaseReachable ? 'up' : 'down',
      },
      timestamp: new Date().toISOString(),
    },
    ...(databaseReachable
      ? {}
      : {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'A required dependency is unavailable',
            requestId: _req.requestId,
          },
        }),
  })
}