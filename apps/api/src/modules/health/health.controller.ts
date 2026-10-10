import type { Request, Response } from 'express'

import { SERVICE_NAME, SERVICE_VERSION } from '../../config/constants.js'

/**
 * Liveness probe.
 *
 * Reports only that the process is running. It deliberately does NOT touch the
 * database: a database outage should not cause the orchestrator to kill an otherwise
 * healthy process. Database reachability is the readiness probe's job.
 */
export function health(_req: Request, res: Response): void {
  res.status(200).json({
    success: true,
    data: {
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  })
}
