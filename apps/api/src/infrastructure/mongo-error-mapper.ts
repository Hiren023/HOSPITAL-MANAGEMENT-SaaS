import mongoose from 'mongoose'
import type { ApiFieldError } from '@infinigrow/shared'

import { ApiError } from './api-error.js'

/**
 * Translation of Mongoose driver errors into API errors.
 *
 * This lives in `infrastructure` so that the HTTP layer — middleware, controllers,
 * services — never imports Mongoose directly. The `no-restricted-imports` lint rule
 * enforces that boundary.
 */

/** Mongoose schema validation failure → 422 with per-field detail. */
export function mapMongooseValidationError(error: mongoose.Error.ValidationError): ApiError {
  const details: ApiFieldError[] = Object.entries(error.errors).map(([path, issue]) => ({
    path,
    message: issue.message,
  }))

  return ApiError.validation(details)
}

/**
 * Mongoose cast failure (e.g. a malformed ObjectId) → 422, not 500.
 *
 * A bad identifier is a client mistake; reporting it as a server fault would leak
 * internals and mislead monitoring.
 */
export function mapMongooseCastError(error: mongoose.Error.CastError): ApiError {
  return ApiError.validation([
    { path: error.path, message: `Invalid value for ${error.path}` },
  ])
}

/** MongoDB duplicate-key failure → 409, naming the offending fields. */
export function mapDuplicateKeyError(error: { keyPattern?: Record<string, unknown> }): ApiError {
  const fields = error.keyPattern ? Object.keys(error.keyPattern) : []

  return new ApiError(
    'CONFLICT',
    fields.length > 0
      ? `A record with this ${fields.join(', ')} already exists`
      : 'Record already exists',
  )
}

/**
 * Map any recognised Mongoose/driver error to an `ApiError`, or return null when the
 * error is not one this module handles.
 */
export function mapMongooseError(error: unknown): ApiError | null {
  if (error instanceof mongoose.Error.ValidationError) {
    return mapMongooseValidationError(error)
  }

  if (error instanceof mongoose.Error.CastError) {
    return mapMongooseCastError(error)
  }

  // MongoDB duplicate key error code.
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  ) {
    return mapDuplicateKeyError(error as { keyPattern?: Record<string, unknown> })
  }

  return null
}