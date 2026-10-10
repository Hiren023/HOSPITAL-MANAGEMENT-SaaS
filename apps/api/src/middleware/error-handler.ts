import type { ApiFieldError } from '@infinigrow/shared'
import type { ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'

import { ApiError, isApiError } from '../infrastructure/api-error.js'
import { logger } from '../infrastructure/logger.js'
import { mapMongooseError } from '../infrastructure/mongo-error-mapper.js'

/**
 * Centralised error handling.
 *
 * Responsibilities:
 *  - translate known error shapes into the API's error envelope;
 *  - return a generic `INTERNAL_ERROR` for anything unexpected;
 *  - never leak a stack trace, driver message, or PHI to the client;
 *  - log unexpected errors with the correlation id so they can be traced.
 *
 * Mongoose errors are translated by `infrastructure/mongo-error-mapper`, which keeps
 * this HTTP layer free of any database import.
 */

interface BodyParserError extends Error {
  type?: string
  status?: number
  statusCode?: number
  expose?: boolean
}

function isBodyParserError(value: unknown): value is BodyParserError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as BodyParserError).type === 'string'
  )
}

function mapZodError(error: ZodError): ApiFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }))
}

/** Convert any thrown value into an `ApiError`. */
export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error

  if (error instanceof ZodError) {
    return ApiError.validation(mapZodError(error))
  }

  const mongooseError = mapMongooseError(error)
  if (mongooseError) return mongooseError

  if (isBodyParserError(error)) {
    switch (error.type) {
      case 'entity.parse.failed':
        return ApiError.badRequest('Request body is not valid JSON')
      case 'entity.too.large':
        return new ApiError('PAYLOAD_TOO_LARGE', 'Request body is too large')
      case 'encoding.unsupported':
        return new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Unsupported content encoding')
      default:
        break
    }
  }

  return ApiError.internal(error)
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const apiError = toApiError(error)

  if (!apiError.isOperational || apiError.status >= 500) {
    // Unexpected: log everything we need to diagnose it, on the server only.
    logger.error(
      {
        err: error,
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
      },
      'Unhandled error while processing request',
    )
  } else {
    logger.warn(
      {
        code: apiError.code,
        status: apiError.status,
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
      },
      'Request rejected',
    )
  }

  if (res.headersSent) {
    res.end()
    return
  }

  res.status(apiError.status).json({
    success: false,
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details ? { details: apiError.details } : {}),
      requestId: req.requestId,
    },
  })
}
