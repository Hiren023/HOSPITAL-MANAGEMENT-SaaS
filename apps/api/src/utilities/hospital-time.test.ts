import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TIMEZONE,
  addDays,
  formatMinuteOfDay,
  localDateKey,
  localDayBounds,
  offsetMinutes,
  parseInstant,
  toLocalParts,
} from './hospital-time.js'

/**
 * Hospital time.
 *
 * These are the assertions the whole scheduling feature rests on. If UTC→local is wrong,
 * an appointment booked at a legitimate hour is rejected as "outside working hours" and no
 * amount of UI testing will reveal why.
 */

const KOLKATA = 'Asia/Kolkata'
const NEW_YORK = 'America/New_York'

describe('toLocalParts', () => {
  it('breaks an instant into hospital-local parts', () => {
    // 09:00 IST is 03:30 UTC.
    const parts = toLocalParts(new Date('2026-10-11T03:30:00.000Z'), KOLKATA)

    expect(parts.hour).toBe(9)
    expect(parts.minute).toBe(0)
    expect(parts.minuteOfDay).toBe(540)
    expect(parts.day).toBe(11)
    expect(parts.month).toBe(10)
    expect(parts.year).toBe(2026)
  })

  it('resolves the weekday as Sunday = 0, matching a schedule block', () => {
    // 2026-10-11 is a Sunday.
    expect(toLocalParts(new Date('2026-10-11T06:00:00.000Z'), KOLKATA).weekday).toBe(0)
    // 2026-10-12 is a Monday.
    expect(toLocalParts(new Date('2026-10-12T06:00:00.000Z'), KOLKATA).weekday).toBe(1)
  })

  it('treats midnight as hour 0, not hour 24', () => {
    // 00:00 IST on the 12th.
    const parts = toLocalParts(new Date('2026-10-11T18:30:00.000Z'), KOLKATA)

    expect(parts.hour).toBe(0)
    // If this were 24:00 the minute-of-day would be 1440 and every midnight appointment
    // would fail the working-hours check.
    expect(parts.minuteOfDay).toBe(0)
    expect(parts.day).toBe(12)
  })

  it('applies the zone, not the server zone', () => {
    const instant = new Date('2026-10-11T13:00:00.000Z')

    expect(toLocalParts(instant, KOLKATA).hour).toBe(18)
    expect(toLocalParts(instant, NEW_YORK).hour).toBe(9)
    expect(toLocalParts(instant, 'UTC').hour).toBe(13)
  })

  it('falls back to UTC for an unknown zone instead of throwing', () => {
    expect(toLocalParts(new Date('2026-10-11T13:00:00.000Z'), 'Not/AZone').hour).toBe(13)
  })
})

describe('offsetMinutes', () => {
  it('handles a half-hour zone', () => {
    // Asia/Kolkata is UTC+05:30 — a whole-hour assumption would be off by 30 minutes.
    expect(offsetMinutes(new Date('2026-10-11T00:00:00.000Z'), KOLKATA)).toBe(330)
    expect(offsetMinutes(new Date('2026-10-11T00:00:00.000Z'), 'UTC')).toBe(0)
  })

  it('tracks daylight saving rather than assuming a fixed offset', () => {
    // New York is UTC-4 in July and UTC-5 in January.
    expect(offsetMinutes(new Date('2026-07-01T12:00:00.000Z'), NEW_YORK)).toBe(-240)
    expect(offsetMinutes(new Date('2026-01-01T12:00:00.000Z'), NEW_YORK)).toBe(-300)
  })
})

describe('localDayBounds', () => {
  it('returns UTC bounds covering exactly the hospital-local day', () => {
    const { start, end } = localDayBounds(new Date('2026-10-11T10:00:00.000Z'), KOLKATA)

    // The local day is the 11th, which begins at 2026-10-10T18:30Z.
    expect(start.toISOString()).toBe('2026-10-10T18:30:00.000Z')
    expect(end.toISOString()).toBe('2026-10-11T18:30:00.000Z')
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it('brackets an instant that sits near the UTC date boundary', () => {
    // 23:00 UTC is already the NEXT local day in Kolkata.
    const instant = new Date('2026-10-11T23:00:00.000Z')
    const { start } = localDayBounds(instant, KOLKATA)

    expect(start.toISOString()).toBe('2026-10-11T18:30:00.000Z')
    expect(localDateKey(instant, KOLKATA)).toBe('2026-10-12')
  })
})

describe('localDateKey', () => {
  it('is stable and sortable', () => {
    expect(localDateKey(new Date('2026-01-05T00:00:00.000Z'), 'UTC')).toBe('2026-01-05')
    expect(localDateKey(new Date('2026-12-31T23:59:59.000Z'), 'UTC')).toBe('2026-12-31')
  })
})

/**
 * `ApiError` carries a generic `message` ("Request validation failed") and the useful
 * text in `details` — the same shape every validation failure in this API uses. Asserting
 * against `.message` would pass for the wrong reason, so the details are read directly.
 */
function detailText(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    const details = (error as { details?: { message: string }[] }).details
    return (details ?? []).map((detail) => detail.message).join(' ')
  }
  throw new Error('expected the call to throw, but it returned')
}

describe('parseInstant', () => {
  it('accepts an instant with an explicit offset', () => {
    const parsed = parseInstant('2026-10-11T09:00:00+05:30')

    expect(parsed.toISOString()).toBe('2026-10-11T03:30:00.000Z')
  })

  it('accepts Z', () => {
    expect(parseInstant('2026-10-11T03:30:00Z').toISOString()).toBe('2026-10-11T03:30:00.000Z')
  })

  /**
   * The rule that makes the whole policy work. A bare local time does not identify a
   * moment, and around a DST transition it cannot be resolved to one at all — so it is
   * refused with an example rather than guessed at.
   */
  it('refuses a bare local time and says what to send instead', () => {
    expect(detailText(() => parseInstant('2026-10-11T09:00:00'))).toMatch(
      /2026-10-11T09:00:00\+05:30/,
    )
    expect(detailText(() => parseInstant('2026-10-11'))).toMatch(/offset/i)
  })

  it('refuses text that is not a date at all', () => {
    expect(detailText(() => parseInstant('2026-13-45T99:99:00Z'))).toMatch(/not a valid date/i)
  })
})

describe('formatMinuteOfDay', () => {
  it('renders minutes from midnight as a clock time', () => {
    expect(formatMinuteOfDay(0)).toBe('00:00')
    expect(formatMinuteOfDay(570)).toBe('09:30')
    expect(formatMinuteOfDay(1439)).toBe('23:59')
  })

  it('clamps rather than emitting an invalid clock time', () => {
    expect(formatMinuteOfDay(-30)).toBe('00:00')
    expect(formatMinuteOfDay(99_999)).toBe('24:00')
  })
})

describe('addDays', () => {
  it('adds whole days without drifting', () => {
    expect(addDays(new Date('2026-10-11T03:30:00.000Z'), 1).toISOString()).toBe(
      '2026-10-12T03:30:00.000Z',
    )
    expect(addDays(new Date('2026-10-11T03:30:00.000Z'), 0).toISOString()).toBe(
      '2026-10-11T03:30:00.000Z',
    )
  })
})

describe('the default zone is a real zone', () => {
  it('resolves, so a hospital with no configured timezone still works', () => {
    expect(toLocalParts(new Date('2026-10-11T03:30:00.000Z'), DEFAULT_TIMEZONE).hour).toBe(9)
  })
})