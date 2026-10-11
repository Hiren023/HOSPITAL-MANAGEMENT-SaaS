/**
 * Hospital time — the ONE place this codebase interprets a time.
 *
 * ── The policy ──────────────────────────────────────────────────────────────────
 *
 * 1. **Instants are stored, and are always UTC.** A MongoDB `Date` is an instant. Two
 *    appointment slots an hour apart are two instants, and "the 09:00 on the 11th" is
 *    whatever instant that was. Storing an instant means range queries, conflict checks
 *    and "is this in the past" are all plain comparisons — no calendar maths in a query
 *    filter, where it would be slow and easy to get subtly wrong.
 *
 * 2. **Meaning is hospital-local.** A hospital's working day is local. "Today" for
 *    reception is the calendar day in the hospital's configured IANA zone, which is not
 *    the server's zone and often not the reader's. Every question about whether a time is
 *    "inside working hours" or "on Monday" is answered by converting the instant into the
 *    hospital's zone first.
 *
 * 3. **The client sends an instant WITH an explicit offset.** A bare `"09:00"` is
 *    ambiguous — it is not a moment, it is a wall-clock reading that needs a calendar and
 *    a zone to become one. Worse, around a DST transition some local times do not exist
 *    and others happen twice, so a server-side local→UTC conversion has no single correct
 *    answer. Rather than embed a timezone database and guess, the API requires
 *    `2026-10-11T09:00:00+05:30` and rejects a bare local time with a message that says
 *    what to send. The browser can compute the correct offset from the hospital's zone
 *    with `Intl`, which it already has.
 *
 * 4. **UTC → local is unambiguous**, which is why direction 3 is safe: once an instant
 *    exists, converting it into any zone is a well-defined lookup. That direction is all
 *    this module performs.
 *
 * The reverse — local wall clock → instant — is deliberately absent. See rule 3.
 *
 * ── Why no dependency ────────────────────────────────────────────────────────────
 *
 * `Intl.DateTimeFormat` with a `timeZone` option is implemented from the ICU data bundled
 * with Node, so this module needs no `luxon`/`date-fns-tz`. The formatter is cached: it
 * is constructed with a locale and options and is comparatively expensive to build on a
 * hot path like listing a day's appointments.
 */

import { ApiError } from '../infrastructure/api-error.js'

/** Minutes in one day. */
export const MINUTES_PER_DAY = 24 * 60

export const DEFAULT_TIMEZONE = 'Asia/Kolkata'

export interface LocalParts {
  year: number
  /** 1–12. */
  month: number
  /** 1–31. */
  day: number
  /** 0–6, Sunday = 0. Matches `Date#getDay`, and the weekday stored on a schedule block. */
  weekday: number
  hour: number
  minute: number
  /** Minutes from local midnight. The same unit a doctor's weekly schedule stores. */
  minuteOfDay: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached) return cached

  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    // An unknown zone throws RangeError. Falling back to UTC keeps the request working
    // and the failure visible in logs, rather than 500-ing on a configuration typo.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  formatterCache.set(timeZone, formatter)
  return formatter
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/**
 * Break an instant into hospital-local calendar parts.
 *
 * This is the only conversion performed anywhere in the application. Everything that
 * needs to know "what day is it for this hospital" or "is this inside working hours"
 * goes through here, so there is exactly one implementation to get right.
 */
export function toLocalParts(instant: Date, timeZone: string = DEFAULT_TIMEZONE): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant)

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '0'

  // `hour12: false` can still yield "24" for midnight in some ICU versions. It is
  // midnight, so it must read as hour 0 — otherwise every midnight appointment lands on
  // the wrong minute-of-day and fails the working-hours check.
  const rawHour = Number(read('hour'))
  const hour = rawHour === 24 ? 0 : rawHour
  const minute = Number(read('minute'))

  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    weekday: WEEKDAY_INDEX[read('weekday')] ?? 0,
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
  }
}

/** `YYYY-MM-DD` for the hospital's local calendar day. Safe to use as a map key. */
export function localDateKey(instant: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const { year, month, day } = toLocalParts(instant, timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Parse a client-supplied instant.
 *
 * Requires an explicit offset. A bare `YYYY-MM-DDTHH:mm` names a wall-clock reading that
 * does not identify a moment — see rule 3 in the file header — so it is refused with a
 * message that shows the caller exactly what to send instead of a generic "invalid date".
 */
export function parseInstant(value: string, field = 'timestamp'): Date {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())

  if (!hasOffset) {
    throw ApiError.validation([
      {
        path: field,
        message:
          'Send a full ISO 8601 instant with a UTC offset, for example ' +
          '2026-10-11T09:00:00+05:30. A bare local time is ambiguous and is not accepted.',
      },
    ])
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw ApiError.validation([
      { path: field, message: 'That is not a valid date and time.' },
    ])
  }

  return parsed
}

/** The instant `days` after `from`, used for the booking horizon. Exact, not calendar-aware. */
export function addDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * 24 * 60 * 60 * 1000)
}

/** UTC midnight bounds `[start, end)` covering the hospital-local day that contains `instant`. */
export function localDayBounds(
  instant: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): { start: Date; end: Date } {
  const parts = toLocalParts(instant, timeZone)

  // The hospital-local midnight, expressed as a UTC instant. Take the calendar day,
  // treat it as if it were UTC, then subtract the zone's offset at that moment.
  //
  // Two passes, because the offset is itself a function of the instant being computed:
  // the first pass can land on the wrong side of a DST transition, and re-reading the
  // offset at the corrected instant settles it. One correction is enough everywhere;
  // zones shifting by a non-integral number of minutes do not exist.
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0)
  const firstPass = asIfUtc - offsetMinutes(asIfUtc, timeZone) * 60_000
  const start = new Date(asIfUtc - offsetMinutes(firstPass, timeZone) * 60_000)

  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)

  return { start, end }
}

/**
 * The zone's offset from UTC, in minutes, at a given instant.
 *
 * Derived rather than imported: format the same instant in the zone and in UTC and take
 * the difference. This is exact for every zone including half-hour ones (`Asia/Kolkata`
 * is +05:30) and for DST, because both readings use the same rules at the same instant.
 */
export function offsetMinutes(instant: Date | number, timeZone: string): number {
  const when = typeof instant === 'number' ? instant : instant.getTime()
  const local = formatterFor(timeZone).formatToParts(new Date(when))

  const read = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((part) => part.type === type)?.value ?? '0'
    return Number(raw === '24' ? '0' : raw)
  }

  // Read the same instant in the target zone, then interpret those local parts AS IF they
  // were UTC. The gap between that and the real instant is the zone's offset — exact for
  // half-hour zones and for DST, because both readings apply the same rules at the same
  // moment.
  const asUtc = Date.UTC(
    read(local, 'year'),
    read(local, 'month') - 1,
    read(local, 'day'),
    read(local, 'hour'),
    read(local, 'minute'),
  )

  return Math.round((asUtc - when) / 60_000)
}

/** Minutes from midnight → `HH:MM`. The inverse of what a person reads off a clock. */
export function formatMinuteOfDay(minuteOfDay: number): string {
  const safe = Math.max(0, Math.min(MINUTES_PER_DAY, Math.trunc(minuteOfDay)))
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}