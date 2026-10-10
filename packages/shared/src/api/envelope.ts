import type { ApiErrorCode } from './errors.js'

export interface ApiFieldError {
  /** Dotted path to the offending field, e.g. `email` or `items.0.quantity`. */
  path: string
  message: string
}

export interface ApiErrorBody {
  code: ApiErrorCode
  message: string
  /** Field-level validation details. Only present for VALIDATION_ERROR. */
  details?: ApiFieldError[]
  /** Correlates the response with server logs. Safe to display. */
  requestId: string
}

export interface ApiMeta {
  requestId: string
  page?: number
  pageSize?: number
  total?: number
  totalPages?: number
  nextCursor?: string | null
}

export interface ApiSuccess<TData> {
  success: true
  data: TData
  meta?: ApiMeta
}

export interface ApiFailure {
  success: false
  error: ApiErrorBody
}

export type ApiResponse<TData> = ApiSuccess<TData> | ApiFailure

/**
 * Build a success envelope.
 *
 * `meta` is supplied whole (including `requestId`, which comes from
 * `req.requestId`) rather than partially merged, so a response can never ship without
 * the correlation id needed to trace it in the logs.
 */
export function apiSuccess<TData>(data: TData, meta?: ApiMeta): ApiSuccess<TData> {
  return meta === undefined ? { success: true, data } : { success: true, data, meta }
}

export function apiFailure(error: ApiErrorBody): ApiFailure {
  return { success: false, error }
}

export function isApiSuccess<TData>(response: ApiResponse<TData>): response is ApiSuccess<TData> {
  return response.success
}

export function isApiFailure<TData>(response: ApiResponse<TData>): response is ApiFailure {
  return !response.success
}

/** Cursor payload encoded for opaque `?cursor=` query parameters. */
export interface CursorPayload {
  /** Sort value of the last item on the previous page, typically an ISO timestamp. */
  t: string
  /** Id of the last item on the previous page, used as the tie-breaker. */
  i: string
}

export interface PaginatedResult<TItem> {
  items: TItem[]
  nextCursor: string | null
  total?: number
}