import type { ApiFieldError } from '@infinigrow/shared'
import type { RequestHandler } from 'express'
import type { ZodType } from 'zod'

import { ApiError } from '../infrastructure/api-error.js'
import { assertNoMongoOperators } from '@infinigrow/shared'

/**
 * Request validation middleware.
 *
 * Every route that accepts input must run its payload through this. The parsed,
 * coerced, **trimmed** result replaces the raw input, so handlers never see a
 * value the schema did not approve.
 *
 * Design notes:
 *  - Schemas must be `.strict()`. An unexpected key is rejected rather than
 *    silently dropped, which is what prevents mass assignment (docs/SECURITY.md R10).
 *  - `assertNoMongoOperators` runs before parsing, so `{"password": {"$ne": null}}`
 *    is rejected even if a future schema were written loosely (docs/SECURITY.md R3).
 *  - Failures produce `VALIDATION_ERROR` with per-field paths the web app maps
 *    straight back onto form inputs.
 */

export interface ValidationSchemas {
  body?: ZodType
  query?: ZodType
  params?: ZodType
}

/**
 * Structural view of a Zod issue.
 *
 * Zod 4 types `path` as `PropertyKey[]`, and the exported `ZodIssue` type is not
 * assignable to that union directly, so the shape is declared structurally here and
 * paths are stringified defensively.
 */
interface FieldIssue {
  path: readonly PropertyKey[]
  message: string
}

function toFieldErrors(issues: readonly FieldIssue[]): ApiFieldError[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }))
}

/**
 * Reject MongoDB operators before any parser runs.
 *
 * `assertNoMongoOperators` throws; here we convert that into the standard envelope so
 * clients see a 422 instead of a 500.
 */
function guardAgainstOperators(value: unknown, location: string): void {
  if (value === undefined || value === null) return

  try {
    assertNoMongoOperators(value, location)
  } catch {
    throw ApiError.badRequest('Request contains an unsupported operator', [
      { path: location, message: 'Unsupported operator in request' },
    ])
  }
}

/**
 * Builds a validation middleware for the given schemas.
 *
 * @example
 * router.post('/patients', validate({ body: createPatientSchema }), controller)
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    try {
      guardAgainstOperators(req.body, 'body')
      guardAgainstOperators(req.query, 'query')
      guardAgainstOperators(req.params, 'params')

      if (schemas.body) {
        const result = schemas.body.safeParse(req.body)
        if (!result.success) {
          throw ApiError.validation(toFieldErrors(result.error.issues))
        }
        req.body = result.data
      }

      if (schemas.query) {
        const result = schemas.query.safeParse(req.query)
        if (!result.success) {
          throw ApiError.validation(toFieldErrors(result.error.issues))
        }
        // Express 5 exposes `req.query` as a getter-only property, so the parsed
        // value cannot be assigned back. Store it alongside instead.
        Object.defineProperty(req, 'validatedQuery', {
          value: result.data,
          writable: true,
          enumerable: true,
          configurable: true,
        })
      }

      if (schemas.params) {
        const result = schemas.params.safeParse(req.params)
        if (!result.success) {
          throw ApiError.validation(toFieldErrors(result.error.issues))
        }
        Object.defineProperty(req, 'validatedParams', {
          value: result.data,
          writable: true,
          enumerable: true,
          configurable: true,
        })
      }

      next()
    } catch (error) {
      next(error)
    }
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Parsed, coerced query — set by `validate({ query })`. */
    validatedQuery?: unknown
    /** Parsed, coerced params — set by `validate({ params })`. */
    validatedParams?: unknown
  }
}