import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

/**
 * Assigns a correlation id to every request.
 *
 * The id is echoed back in the `X-Request-Id` response header and in every log line
 * for the request, so a support ticket quoting one id can be traced end to end.
 *
 * A client-supplied id is honoured so a distributed caller can correlate across
 * services, but it is strictly sanitised first: an unvalidated value would allow log
 * forging (injecting fake newlines) and header injection.
 */

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlation id for this request. Always present after `requestId` runs. */
    requestId: string
  }
}

const REQUEST_ID_HEADER = 'x-request-id'

/** Unambiguous alphabet: no `0`/`O`/`1`/`I`, which are indistinguishable in logs. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.headers[REQUEST_ID_HEADER]

  const id =
    typeof supplied === 'string' && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID()

  req.requestId = id
  res.setHeader('X-Request-Id', id)
  next()
}