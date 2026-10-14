import { Types } from 'mongoose'

/**
 * Coerce a value to an ObjectId.
 *
 * ── Why this lives here ────────────────────────────────────────────────────────
 *
 * `docs/ARCHITECTURE.md` puts Mongoose behind the infrastructure layer, and the lint rule
 * `no-restricted-imports` enforces it: application code may not import `mongoose`. A
 * seeding script is application code, so it goes through this instead of reaching past the
 * boundary — which is the whole point of having the boundary.
 *
 * ── Why a pass-through is checked at all ───────────────────────────────────────
 *
 * Lean reads already hand back real ObjectIds, so the common case needs no construction
 * at all. This returns the value untouched when it is already an ObjectId, and only
 * converts a string when it genuinely is one.
 */
export function toObjectId(value: unknown): Types.ObjectId {
  if (value instanceof Types.ObjectId) return value
  if (typeof value === 'string' && Types.ObjectId.isValid(value)) return new Types.ObjectId(value)

  // A malformed id must fail loudly. Returning `new Types.ObjectId()` would produce a
  // valid-looking zero id that matches nothing — a query that returns empty and looks
  // like "no data" rather than "you passed the wrong thing".
  throw new Error(`Not a valid ObjectId: ${String(value)}`)
}

/** True when the value can be used as an ObjectId. */
export function isObjectId(value: unknown): boolean {
  return value instanceof Types.ObjectId || (typeof value === 'string' && Types.ObjectId.isValid(value))
}