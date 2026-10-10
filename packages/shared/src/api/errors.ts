/**
 * Stable, machine-readable error codes.
 *
 * The web app switches on these codes; messages may be reworded or localised freely.
 * Never parse an error `message` — always branch on `code`.
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'TENANT_SCOPE_REQUIRED',
  'RATE_LIMITED',
  'ACCOUNT_LOCKED',
  'MFA_REQUIRED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/** Default HTTP status for each error code. */
export const ERROR_CODE_HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = Object.freeze({
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TENANT_SCOPE_REQUIRED: 403,
  RATE_LIMITED: 429,
  ACCOUNT_LOCKED: 423,
  MFA_REQUIRED: 401,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
})

/**
 * `NOT_FOUND` is used deliberately when a caller requests a resource that belongs to
 * another tenant, so the API never confirms that the id exists somewhere else.
 * See docs/SECURITY.md R11 (existence disclosure).
 */
export const NOT_FOUND_MESSAGE = 'Resource not found'

/** Generic, non-enumerable authentication failure message. */
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password'