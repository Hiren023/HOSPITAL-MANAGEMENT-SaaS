import type { NextFunction, Request, Response } from 'express'

import { ApiError } from '../infrastructure/api-error.js'

/** Terminal 404 for unmatched routes. Runs after every registered router. */
export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound())
}