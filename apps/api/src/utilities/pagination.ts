import type { CursorPayload } from '@infinigrow/shared'

/**
 * Opaque cursor pagination.
 *
 * Clinical and audit listings must not use `skip`/`offset`: at page 10,000 the
 * database still has to walk every skipped row, and rows inserted mid-scroll shift
 * the window and silently duplicate or drop results.
 *
 * A cursor encodes the sort key of the last row seen, so the next page starts exactly
 * where the previous one ended.
 *
 * Security: the cursor is base64url-encoded JSON, not encrypted. It is a client-held
 * token, so it must never carry anything sensitive (no patient identifiers, no PHI).
 * `encodeCursor` is typed to prevent that misuse.
 */

const CURSOR_VERSION = 1

interface VersionedCursor extends CursorPayload {
  /** Schema version, so a future change can decode old cursors rather than 500. */
  v: number
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

/** Encode a sort timestamp and id into an opaque cursor. */
export function encodeCursor(timestamp: Date | string, id: string): string {
  const t = timestamp instanceof Date ? timestamp.toISOString() : timestamp

  const payload: VersionedCursor = { v: CURSOR_VERSION, t, i: id }
  return base64UrlEncode(JSON.stringify(payload))
}

/**
 * Decode a cursor.
 *
 * Returns `null` for anything unparseable rather than throwing, so a stale or
 * hand-edited cursor degrades to "start from the beginning" instead of a 500.
 */
export function decodeCursor(cursor: string | undefined | null): CursorPayload | null {
  if (!cursor) return null

  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(cursor))

    if (typeof parsed !== 'object' || parsed === null) return null

    const { v, t, i } = parsed as Partial<VersionedCursor>

    // An unknown future version is rejected rather than guessed at.
    if (v !== CURSOR_VERSION) return null
    if (typeof t !== 'string' || typeof i !== 'string') return null
    if (Number.isNaN(Date.parse(t))) return null

    return { t, i }
  } catch {
    return null
  }
}

/** Page metadata for an offset-paginated response. */
export function buildPageMeta(input: {
  requestId: string
  page: number
  pageSize: number
  total: number
}): { requestId: string; page: number; pageSize: number; total: number; totalPages: number } {
  const totalPages = input.pageSize > 0 ? Math.ceil(input.total / input.pageSize) : 0

  return {
    requestId: input.requestId,
    page: input.page,
    pageSize: input.pageSize,
    total: input.total,
    totalPages,
  }
}

/**
 * Build a cursor query filter for "everything strictly after this cursor".
 *
 * The id is the tie-breaker so that rows sharing a timestamp are neither skipped
 * nor repeated.
 */
export function cursorFilter(cursor: CursorPayload | null, timestampField = 'createdAt'): {
  $or: Record<string, unknown>[]
} | Record<string, never> {
  if (!cursor) return {}

  return {
    $or: [
      { [timestampField]: { $lt: new Date(cursor.t) } },
      { [timestampField]: new Date(cursor.t), _id: { $lt: cursor.i } },
    ],
  }
}