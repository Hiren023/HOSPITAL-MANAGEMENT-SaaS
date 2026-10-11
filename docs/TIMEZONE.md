# Time and timezone policy

How this system represents time, why, and what that means for anyone integrating with it.

This document exists because "what time is that?" has more than one correct answer, and
picking one without saying so is how a 09:00 slot becomes 04:30 for half the world.

---

## The rule in one paragraph

**Instants are stored as UTC. Meaning is derived in the hospital's configured IANA
timezone. Clients send instants with an explicit offset and are refused bare local times.**
Every conversion happens in one file — [`apps/api/src/utilities/hospital-time.ts`](../apps/api/src/utilities/hospital-time.ts).

---

## 1. Storage: instants only

An appointment stores `startAt` and `endAt` as MongoDB `Date` values, which are instants.

Not local wall-clock strings. Not a date plus a time plus a weekday that must all agree.
One value that means exactly one moment.

That choice is what makes the rest tractable:

- **Range queries are plain comparisons.** "Everything on Tuesday" is a `$gte`/`$lt` on
  one field, not calendar arithmetic inside a query filter where it would be slow and easy
  to get subtly wrong.
- **Conflicts are set comparisons.** Two bookings overlap or they do not; there is no
  timezone reasoning in the hot path.
- **"Is this in the past?" is one comparison**, immune to every timezone question.

The weekday and the time-of-day are **derived at read time**, never stored alongside. A
stored local copy is a second source of truth that drifts the first time a hospital changes
timezone or a daylight-saving rule is updated — and it drifts silently, because both
values still look plausible.

## 2. Meaning: the hospital's timezone

A hospital's working day is local. "Today" for reception is the calendar day in *that
hospital's* zone, which is not the server's zone and often not the reader's.

Each hospital has a `settings.timezone` IANA zone (`Asia/Kolkata` by default). Every
question about whether a time is "inside working hours", "on Monday", or "on the hospital's
calendar day today" is answered by converting the instant into that zone first.

Opening hours are stored as **minutes from local midnight, keyed by weekday 0–6 (Sunday =
0)** — deliberately the same unit a doctor's weekly schedule block already uses, so the two
compare directly with no conversion between them.

## 3. Input: instants must carry an offset

The API requires:

```
startAt: "2026-10-11T09:00:00+05:30"     ← accepted
startAt: "2026-10-11T03:30:00Z"          ← accepted
startAt: "2026-10-11T09:00:00"           ← REFUSED
startAt: "2026-10-11"                    ← REFUSED
```

A bare `"09:00"` is not a moment. It is a wall-clock reading that needs a calendar and a
zone to become one, and around a daylight-saving transition **some local times do not
exist** while others happen twice. Resolving those correctly requires a full timezone
database and produces a genuinely ambiguous result.

Rather than embed that complexity and guess, the API refuses and says what to send:

> Send a full ISO 8601 instant with a UTC offset, for example
> `2026-10-11T09:00:00+05:30`. A bare local time is ambiguous and is not accepted.

The browser can compute the correct offset from the hospital's zone using `Intl`, which it
already has. And in this product the browser usually does not need to: the availability
endpoint returns each bookable slot as an instant, and the client sends one back verbatim.

### The client performs no conversion

Booking flow, end to end:

1. Client asks `GET /appointments/availability?date=…&doctorUserId=…`
2. Server returns `freeSlots: [{ startAt: "2026-10-14T05:00:00.000Z", localTime: "10:30" }]`
3. Client picks one and posts `startAt` **unchanged**

There is no local→UTC conversion anywhere in the client. That is the point: it is the
conversion most likely to be wrong, and the server already knows which instants are real.

## 4. Day and week views use the hospital's calendar day

`GET /appointments/day?date=2026-10-14` means **the hospital's 14th**, not the caller's.

An instant in a query string would mean a different day for a user in a different zone,
which is precisely the confusion this policy exists to prevent. The response carries
`timezone` and each appointment carries a derived `localTime`, so the interface never has
to re-derive anything.

## 5. No dependency

Node ships full ICU data, so `Intl.DateTimeFormat` with a `timeZone` option resolves any
IANA zone. This project uses that rather than `luxon` or `date-fns-tz`. The formatter is
cached, because constructing one is comparatively expensive on a hot path like listing a
day's appointments.

Two traps this code handles explicitly, both verified by tests:

- **`hour: 24`.** Some ICU versions render midnight as `24` even with `hour12: false`.
  Taken literally that is 1440 minutes past midnight, which would fail every
  working-hours check for a midnight slot. It is normalised to `0`.
- **Half-hour and 45-minute zones.** `Asia/Kolkata` is +05:30 and `Asia/Kathmandu` is
  +05:45. An offset derived by whole hours is wrong for both. The offset is derived by
  formatting the same instant in two zones and taking the difference, which is exact for
  every zone and for daylight saving, because both readings apply the same rules at the
  same moment.

## 6. Date of birth is a date, not an instant

A patient's date of birth is stored at **UTC midnight** and never rendered as a timestamp.

Attaching a time and offset to a birth date means someone born at midnight could display as
the previous day for anyone west of Greenwich — a person who is one day older or younger
than they are, on a clinical record. It is a calendar date, and it is treated as one.

---

## Changing a hospital's timezone

Open with `settings.timezone` is safe to change. Stored instants do not move; they are
reinterpreted in the new zone when read, which is exactly the intended behaviour for a
hospital that has genuinely relocated or corrected its configuration.

What you should expect to review afterwards:

- **Appointments already booked** now fall at a different local time. They are not
  silently moved in the database, but their local rendering changes.
- **A doctor's weekly schedule is unchanged.** It is stored in local minutes by design,
  so it means "09:00 where I work" and survives the move — which is the correct outcome
  for a doctor who moved with the hospital, and the wrong one for a hospital that merely
  corrected a typo. If the latter, the roster should be reviewed.

This is a deliberate trade: instants stay unambiguous, and the cost is that a timezone
change is an event to think about rather than a free configuration edit.

---

## Quick reference

| Concept | Stored as | Notes |
| --- | --- | --- |
| Appointment time | UTC instant (`Date`) | `startAt`, `endAt` |
| Patient date of birth | `Date` at UTC midnight | A calendar date, never a timestamp |
| Doctor roster block | Minutes from local midnight | `startMinute`, `endMinute`, by weekday |
| Hospital opening hours | Minutes from local midnight | By weekday 0–6; `null` means closed |
| Hospital timezone | IANA zone string | `settings.timezone` |
| Slot grid | UTC instant | `AppointmentSlot.slotStart`; unique per doctor |
| API input | ISO 8601 **with offset** | A bare local time is refused |
| API output | ISO 8601 UTC, plus derived local | `startAt` + `localTime` |

**Related:** [`API.md`](./API.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`SECURITY.md`](./SECURITY.md)