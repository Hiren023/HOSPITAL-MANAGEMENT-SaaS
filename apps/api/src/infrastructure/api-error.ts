import {
  ERROR_CODE_HTTP_STATUS,
  NOT_FOUND_MESSAGE,
  type ApiErrorCode,
  type ApiFieldError,
} from '@infinigrow/shared'

/**
 * An error that is safe to surface to the client.
 *
 * Anything thrown that is NOT an `ApiError` is treated as a bug: it is logged with a
 * full stack trace internally and reported to the client as a generic
 * `INTERNAL_ERROR`. This is the mechanism that prevents stack traces, driver errors
 * and PHI from leaking in responses (docs/SECURITY.md R8).
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly details: ApiFieldError[] | undefined
  /** Operational errors are expected; non-operational ones are bugs. */
  readonly isOperational: boolean

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { details?: ApiFieldError[]; isOperational?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })

    this.name = 'ApiError'
    this.code = code
    this.status = ERROR_CODE_HTTP_STATUS[code]
    this.details = options.details
    this.isOperational = options.isOperational ?? true

    Error.captureStackTrace?.(this, ApiError)
  }

  /**
   * Used for both "does not exist" and "belongs to another hospital".
   * Returning the identical response in both cases prevents resource enumeration.
   */
  static notFound(): ApiError {
    return new ApiError('NOT_FOUND', NOT_FOUND_MESSAGE)
  }

  static badRequest(message: string, details?: ApiFieldError[]): ApiError {
    return new ApiError('VALIDATION_ERROR', message, { details })
  }

  static validation(details: ApiFieldError[]): ApiError {
    return new ApiError('VALIDATION_ERROR', 'Request validation failed', { details })
  }

  static unauthenticated(message = 'Authentication required'): ApiError {
    return new ApiError('UNAUTHENTICATED', message)
  }

  static forbidden(message = 'You do not have permission to perform this action'): ApiError {
    return new ApiError('FORBIDDEN', message)
  }

  static conflict(message: string): ApiError {
    return new ApiError('CONFLICT', message)
  }

  /** Raised when a tenant-scoped query executes with no tenant context bound. */
  static tenantScopeRequired(operation: string): ApiError {
    return new ApiError(
      'TENANT_SCOPE_REQUIRED',
      `A tenant context is required for this operation (${operation}). ` +
        'Tenant-scoped data must never be accessed without a verified hospital scope.',
      { isOperational: false },
    )
  }

  static internal(cause?: unknown): ApiError {
    return new ApiError('INTERNAL_ERROR', 'An unexpected error occurred', {
      isOperational: false,
      cause,
    })
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}
