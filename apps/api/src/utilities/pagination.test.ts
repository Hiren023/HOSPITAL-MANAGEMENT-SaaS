import { describe, expect, it } from 'vitest'

import { buildPageMeta, cursorFilter, decodeCursor, encodeCursor } from './pagination.js'

/**
 * Cursor pagination tests.
 *
 * The critical property is round-trip fidelity plus graceful degradation: a corrupt
 * cursor must never produce a 500.
 */

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a timestamp and id', () => {
    const timestamp = new Date('2026-10-09T12:00:00.000Z')
    const decoded = decodeCursor(encodeCursor(timestamp, '507f1f77bcf86cd799439011'))

    expect(decoded).toEqual({ t: '2026-10-09T12:00:00.000Z', i: '507f1f77bcf86cd799439011' })
  })

  it('accepts an ISO string as well as a Date', () => {
    const decoded = decodeCursor(encodeCursor('2026-10-09T12:00:00.000Z', 'abc'))
    expect(decoded?.t).toBe('2026-10-09T12:00:00.000Z')
  })

  it('produces a URL-safe string with no + / = characters', () => {
    const cursor = encodeCursor(new Date(), 'id/with+odd=chars')

    expect(cursor).not.toMatch(/[+/=]/)
    expect(encodeURIComponent(cursor)).toBe(cursor)
    expect(decodeCursor(cursor)?.i).toBe('id/with+odd=chars')
  })

  it('returns null for absent input', () => {
    expect(decodeCursor(undefined)).toBeNull()
    expect(decodeCursor(null)).toBeNull()
    expect(decodeCursor('')).toBeNull()
  })

  it('degrades to null for malformed input rather than throwing', () => {
    // A hand-edited or truncated cursor must not become a 500.
    expect(decodeCursor('not-valid-base64!!')).toBeNull()
    expect(decodeCursor('e30')).toBeNull() // valid base64, but `{}`
    expect(decodeCursor(Buffer.from('"a string"').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('null').toString('base64url'))).toBeNull()
  })

  it('rejects a payload missing the id', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, t: '2026-10-09T12:00:00.000Z' })).toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('rejects a payload with an unparseable timestamp', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, t: 'not-a-date', i: 'abc' })).toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  it('rejects an unknown cursor version instead of guessing', () => {
    // A future schema change must not misread today's cursors.
    const future = Buffer.from(
      JSON.stringify({ v: 99, t: '2026-10-09T12:00:00.000Z', i: 'abc' }),
    ).toString('base64url')

    expect(decodeCursor(future)).toBeNull()
  })

  it('does not leak a timestamp in clear text', () => {
    const cursor = encodeCursor(new Date('2026-10-09T12:00:00.000Z'), 'abc')
    expect(cursor).not.toContain('2026-10-09')
  })
})

describe('cursorFilter', () => {
  it('returns an empty filter when there is no cursor', () => {
    expect(cursorFilter(null)).toEqual({})
  })

  it('builds a strictly-less-than filter with an id tie-breaker', () => {
    const timestamp = '2026-10-09T12:00:00.000Z'
    const filter = cursorFilter({ t: timestamp, i: 'abc' })

    expect(filter).toHaveProperty('$or')
    const branches = (filter as { $or: Record<string, unknown>[] }).$or
    expect(branches).toHaveLength(2)

    // Timestamps are compared as Date instances, not strings. A string comparison
    // would be lexicographic and therefore wrong across differing offsets.
    const first = branches[0] as { createdAt: { $lt: Date } }
    expect(first.createdAt.$lt).toBeInstanceOf(Date)
    expect(first.createdAt.$lt.toISOString()).toBe(timestamp)

    const second = branches[1] as { createdAt: Date; _id: { $lt: string } }
    expect(second.createdAt.toISOString()).toBe(timestamp)
    expect(second._id.$lt).toBe('abc')
  })

  it('honours a custom timestamp field', () => {
    const filter = cursorFilter({ t: '2026-10-09T12:00:00.000Z', i: 'abc' }, 'startAt')
    const branches = (filter as { $or: Record<string, unknown>[] }).$or
    expect(branches[0]).toHaveProperty('startAt')
  })
})

describe('buildPageMeta', () => {
  it('computes total pages with a ceiling', () => {
    const meta = buildPageMeta({ requestId: 'r1', page: 1, pageSize: 20, total: 137 })
    expect(meta.totalPages).toBe(7)
    expect(meta).toMatchObject({ requestId: 'r1', page: 1, pageSize: 20, total: 137 })
  })

  it('returns zero pages when there are no records', () => {
    expect(buildPageMeta({ requestId: 'r1', page: 1, pageSize: 20, total: 0 }).totalPages).toBe(0)
  })

  it('does not divide by zero', () => {
    expect(buildPageMeta({ requestId: 'r1', page: 1, pageSize: 0, total: 10 }).totalPages).toBe(0)
  })

  it('handles an exact multiple without an extra empty page', () => {
    expect(buildPageMeta({ requestId: 'r1', page: 1, pageSize: 20, total: 100 }).totalPages).toBe(5)
  })
})