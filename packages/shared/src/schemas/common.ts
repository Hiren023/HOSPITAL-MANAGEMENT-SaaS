import { z } from 'zod'

/**
 * Reusable validation primitives shared by the API (runtime enforcement) and the web
 * app (form validation), so the two can never disagree about what is valid input.
 */

/**
 * A 24-character MongoDB ObjectId in string form.
 *
 * Deliberately stricter than `z.string()` — see docs/SECURITY.md R3 for why operator
 * objects must be rejected before they reach a database query.
 */
export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hexadecimal identifier')

/**
 * Guard against NoSQL operator injection.
 *
 * Any key containing `$` or starting with `.` could otherwise be passed through to a
 * MongoDB query as an operator (`$ne`, `$gt`, `$where`, …), turning a value match into
 * a query-control primitive. Zod's `.strict()` objects already reject unknown keys;
 * this additionally protects free-form `Record<string, unknown>` inputs such as
 * metadata blobs and filter maps.
 */
export function assertNoMongoOperators(input: unknown, path = 'body'): void {
  if (Array.isArray(input)) {
    input.forEach((item, index) => assertNoMongoOperators(item, `${path}[${index}]`))
    return
  }

  if (input === null || typeof input !== 'object') return

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    // `$`-prefixed keys are operators ($ne, $gt, $where, …). A `.`-prefixed key is a
    // MongoDB field-path reference, which is how an attacker reaches a nested field
    // the schema never declared.
    //
    // Both are rejected ANYWHERE in the payload, including inside a `z.record()`
    // whose values are `unknown`. Verified against zod 4.6.5: a record schema happily
    // accepts `{'a.b': 'x'}`, so the schema alone is NOT sufficient protection.
    if (key.includes('$') || key.startsWith('.')) {
      throw new Error(`Illegal key "${key}" at ${path}: MongoDB operators are not permitted`)
    }
    assertNoMongoOperators(value, `${path}.${key}`)
  }
}

export const MAX_PAGE_SIZE = 100
export const DEFAULT_PAGE_SIZE = 20

/** Offset pagination — for admin tables where a total count is genuinely needed. */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
})

export type PageQuery = z.infer<typeof pageQuerySchema>

/** Cursor pagination — default for clinical and audit listings. */
export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
})

export type CursorQuery = z.infer<typeof cursorQuerySchema>

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  // Intentionally permissive: the goal is to reject obvious junk, not to outsmart
  // the RFC. Deliverability is verified separately at registration time.
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Must be a valid email address')

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9\s-]{7,17}$/, 'Must be a valid phone number')

/**
 * Password policy.
 *
 * Length is the dominant factor in password strength (NIST SP 800-63B), so the
 * minimum is 12 characters. Composition rules are intentionally light to avoid
 * pushing users toward predictable substitutions.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password must be at most 200 characters')
  .refine((value) => value.trim().length > 0, 'Password must not be only whitespace')

/** Search term for list views. Length-bounded to keep queries cheap. */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
})

/** ISO 8601 instant, always stored and transported in UTC. */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .describe('ISO 8601 timestamp')

/**
 * Bounded free-text field.
 *
 * Clinical notes are structured documents, not HTML. Limiting length here is both a
 * storage-cost control and an injection-surface reduction (docs/SECURITY.md R14).
 */
export const clinicalTextSchema = z.string().trim().min(1).max(10_000)

export const shortTextSchema = z.string().trim().min(1).max(200)