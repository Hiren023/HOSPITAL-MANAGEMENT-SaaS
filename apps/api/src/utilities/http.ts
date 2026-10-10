import type { NextFunction, Request, Response } from 'express'

import { ApiError } from '../infrastructure/api-error.js'

/**
 * Wrap an async route handler so a rejected promise becomes a normal `next(err)`.
 *
 * Express 5 forwards rejections from async handlers automatically, but wrapping keeps
 * the behaviour explicit and stable if a handler is ever mounted somewhere that does
 * not (a raw `router.handle` call, a test harness, or a future Express downgrade).
 */
/**
 * Route-handler signature. Declared as a type alias so `asyncHandler` can infer the
 * request and response types from the handler instead of taking meaningless generics.
 */
export type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown | Promise<unknown>

export function asyncHandler(handler: AsyncRouteHandler): AsyncRouteHandler {
  return (req, res, next) => {
    try {
      const result = handler(req, res, next)
      if (result instanceof Promise) {
        result.catch(next)
      }
    } catch (error) {
      next(error)
    }
  }
}

/** Standard JSON body for a successful response. */
export function sendSuccess<TData>(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  data: TData,
  meta?: Record<string, unknown>,
  statusCode = 200,
): unknown {
  return res.status(statusCode).json(meta ? { success: true, data, meta } : { success: true, data })
}

/**
 * Throw a 404 that is indistinguishable from a cross-tenant miss.
 *
 * Both "does not exist" and "belongs to another hospital" produce the identical
 * response so identifiers cannot be enumerated (docs/SECURITY.md R11).
 */
export function throwNotFound(): never {
  throw ApiError.notFound()
}
