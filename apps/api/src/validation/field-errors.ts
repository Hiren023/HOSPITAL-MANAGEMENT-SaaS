import type { ApiFieldError } from '@infinigrow/shared'

/**
 * Shared helpers for request validation.
 *
 * These exist so every route builds the same field-error shape, and so the web app
 * can rely on one predictable contract.
 */

export function fieldError(path: string, message: string): ApiFieldError {
  return { path, message }
}

/** Normalise a thrown value into a list of field errors. */
export function toFieldErrors(
  issues: readonly { path: (string | number)[]; message: string }[],
): ApiFieldError[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }))
}

/**
 * Remove `undefined` entries so a partial PATCH body never sends explicit
 * `undefined` keys to the database layer.
 */
export function pruneUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value
  }

  return result as Partial<T>
}
