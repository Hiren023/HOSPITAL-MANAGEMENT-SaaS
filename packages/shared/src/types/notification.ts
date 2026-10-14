/**
 * Notification vocabulary shared by the API and the web app.
 *
 * ── The preview rule lives here, not in a service ──────────────────────────────
 *
 * `assertSafePreview` is the single most important function in this module, and it is
 * here rather than in `notification.service.ts` for one reason: the web app needs it too.
 * The template preview screen runs the same assertion live as somebody types, so the rule
 * shown to the user and the rule enforced by the server cannot be two implementations that
 * drift apart. One function, two callers, one behaviour.
 *
 * ── Why a validator and not a convention ───────────────────────────────────────
 *
 * Every plausible way to leak clinical information through a message is a matter of
 * someone writing different text. "Don't put the diagnosis in the SMS" is a rule that
 * holds until the day someone needs a more specific message, and it fails silently: the
 * message goes out, the leak is in a third party's hands, and nothing anywhere said no.
 *
 * So the body is checked mechanically. The check is imperfect by nature — no regex
 * reliably distinguishes "your result is 6.2" from a phone number — and that limitation
 * is why it is a **blocker on a reviewable list of templates** rather than a guarantee.
 * See the caveats on `FORBIDDEN_TERMS`.
 */

/** Channels this module can address. No push, no chat: both are separate products. */
export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value)
}

/**
 * Delivery states.
 *
 * `PENDING` is where everything starts, including a message handed to a provider that
 * reports nothing. `SENT` means a provider accepted it for delivery, which is **not** the
 * same as the recipient receiving it — most SMS gateways cannot tell the difference and
 * say "sent" for a number that no longer exists.
 *
 * `DELIVERED` exists in the vocabulary and is **unreachable in this MVP**, by the same
 * design that stops `PaymentProvider` reporting `VERIFIED`. See `phase9-module-a-notifications.md` §7.
 */
export const NOTIFICATION_STATUSES = [
  'PENDING',
  'SENT',
  'DELIVERED',
  'FAILED',
  'BOUNCED',
  'SUPPRESSED',
] as const

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number]

export function isNotificationStatus(value: unknown): value is NotificationStatus {
  return typeof value === 'string' && (NOTIFICATION_STATUSES as readonly string[]).includes(value)
}

/**
 * Terminal states. Nothing further happens to a notification in one of these without a
 * person acting.
 *
 * `SUPPRESSED` is terminal for a *send*, not for the message: it records that consent or a
 * preference stopped this attempt, which is why it is kept rather than deleted. A delivery
 * log that only lists what went out cannot answer "did we try to contact this patient?",
 * and that question is asked after an incident.
 */
export const TERMINAL_NOTIFICATION_STATUSES: readonly NotificationStatus[] = [
  'DELIVERED',
  'BOUNCED',
  'SUPPRESSED',
]

/**
 * What a message is about.
 *
 * The category exists so a recipient can opt out of one kind and keep another — see
 * `NotificationPreference`. A patient who does not want payment reminders should not have
 * to stop hearing about appointments to get that.
 */
export const NOTIFICATION_CATEGORIES = [
  'APPOINTMENT',
  'CLINICAL',
  'BILLING',
  'ADMINISTRATIVE',
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
}

/** Why a send was refused. Recorded rather than thrown away, so "no message" is explainable. */
export const SUPPRESSION_REASONS = [
  'NO_CONSENT',
  'CONSENT_REVOKED',
  'PREFERENCE_DISABLED',
  'NO_CONTACT_DETAILS',
  'UNSAFE_PREVIEW',
] as const

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

// ─────────────────────────── the preview rule ───────────────────────────

/**
 * Terms that must never appear in a notification body.
 *
 * ── What this list is and is not ──────────────────────────────────────────────
 *
 * It catches the ordinary mistakes: a template pasted from a clinical note, a
 * prescription, or a lab report. It is **not** a guarantee. A diagnosis written in plain
 * words ("chest infection") contains none of these terms and would pass, and no keyword
 * list can prevent that.
 *
 * The real control is structural, and this is the second line:
 *
 *  1. **Templates are code, not user input.** There is no endpoint that accepts a body.
 *    Nobody can type clinical text into a message; the only writable text is the
 *    recipient's own name, a date, a time and a department name, all substituted into
 *    reviewed templates.
 *  2. **Review is a human gate.** Adding a template means editing a file, which is a pull
 *    request someone reads.
 *
 * A keyword list on top of those is defence in depth, not the defence itself.
 */
export const FORBIDDEN_PREVIEW_TERMS: readonly string[] = [
  // Diagnoses and clinical findings.
  'diagnos',
  'prescri',
  'medicat',
  'symptom',
  'allerg',
  'lesion',
  'tumor',
  'tumour',
  'carcinoma',
  'malignan',
  'infarct',
  'stroke',
  'fracture',
  'infection',
  'sepsis',
  'hypertension',
  'diabet',
  'asthma',
  'hiv',
  'hepatitis',
  'tubercul',
  'migraine',
  'epilep',
  // Test results.
  'result',
  'report shows',
  'lab ',
  'blood sugar',
  'hemoglobin',
  'haemoglobin',
  'positive for',
  'negative for',
  'elevated',
  'abnormal',
  'normal range',
  'mg/dl',
  'mmol',
  // Medicines and dosages.
  'tablet',
  'tab ',
  'capsule',
  ' mg',
  ' ml',
  'mcg',
  'dose',
  'dosage',
  'prescription',
  ' rx',
  // Clinical narrative.
  'consultation note',
  'clinical note',
  'vitals',
  'blood pressure',
  'temperature',
  'complaint',
  'follow-up visit',
]

/**
 * Patterns that are refused regardless of context.
 *
 * The numeric-result rule is the interesting one: a message saying "6.2" is almost
 * certainly a measurement, and a measurement in a channel a third party can read is the
 * exact thing this module exists to prevent. Refusing is cheap; the cost of a false
 * positive is a message somebody rewords.
 */
export const FORBIDDEN_PREVIEW_PATTERNS: readonly RegExp[] = [
  // A bare decimal that could be a measurement, e.g. "6.2", "12.5 mg/dl".
  /\b\d+\.\d+\b/,
  // A percentage, which reads as a probability or a score.
  /\b\d{1,3}\s?%/,
  // Anything that looks like a patient or record identifier.
  /\b[A-Z]{2,}-\d{3,}\b/,
  // A UHID-style reference.
  /\bUHID\b/i,
]

/**
 * Placeholder names a template may use.
 *
 * An **allow-list**. Only these can be substituted, so clinical text has no way in — not
 * because it was forbidden, but because there is no slot for it.
 */
export const ALLOWED_PREVIEW_PLACEHOLDERS: readonly string[] = [
  'recipientName',
  'dateLabel',
  'timeLabel',
  'departmentName',
  'locationName',
]

export const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g

export interface PreviewCheck {
  safe: boolean
  /** The offending term or pattern, for the template reviewer's benefit. */
  reason: string | null
}

/**
 * Does this body contain anything that must not go into a message?
 *
 * `allowedPlaceholders` is checked too, and separately: a template using an unlisted slot
 * is refused even when its prose is clean, because that is the mechanism by which clinical
 * text would reach a message later.
 *
 * Never throws. A caller rendering a live preview needs an answer, not an exception.
 */
export function checkPreview(
  body: string,
  options: { allowedPlaceholders?: readonly string[] } = {},
): PreviewCheck {
  const allowed = options.allowedPlaceholders ?? ALLOWED_PREVIEW_PLACEHOLDERS
  const haystack = body.toLowerCase()

  for (const term of FORBIDDEN_PREVIEW_TERMS) {
    if (haystack.includes(term)) {
      return { safe: false, reason: `contains the clinical term "${term.trim()}"` }
    }
  }

  for (const pattern of FORBIDDEN_PREVIEW_PATTERNS) {
    if (pattern.test(body)) {
      return { safe: false, reason: `matches the refused pattern ${pattern}` }
    }
  }

  // A placeholder nobody sanctioned is a hole where clinical text would go.
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1] ?? ''
    if (!allowed.includes(name)) {
      return { safe: false, reason: `uses the unapproved placeholder "{{${name}}}"` }
    }
  }

  return { safe: true, reason: null }
}

/** Throwing form, for server-side enforcement. */
export function assertSafePreview(
  body: string,
  options: { allowedPlaceholders?: readonly string[] } = {},
): void {
  const result = checkPreview(body, options)
  if (!result.safe) {
    throw new Error(`Notification body rejected: it ${result.reason}.`)
  }
}

// ─────────────────────────── retry policy ───────────────────────────

/**
 * Delay before each retry, in milliseconds. Index 0 is before the second attempt.
 *
 * The shape is deliberately rather than a clean exponential. Each step is roughly three to
 * four times the last, but the values are whole minutes and hours because that is what the
 * failure modes are: a mobile carrier's SMS gateway recovers in minutes, a weekend does
 * not, and a bounced address is caught by validation rather than by trying six times.
 *
 * Five entries, so six attempts in total — which is the cap the specification names. An
 * earlier draft had four entries here, which produced `MAX_ATTEMPTS = 5` and quietly
 * disagreed with the documented "capped at 6". The count is derived, so the fix belongs
 * in this array and nowhere else.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [
  60_000, // 1 minute
  5 * 60_000, // 5 minutes
  30 * 60_000, // 30 minutes
  2 * 3_600_000, // 2 hours
  6 * 3_600_000, // 6 hours
]

/**
 * Total attempts, including the first.
 *
 * Six is where retrying stops helping. A number that is malformed fails immediately and is
 * never retried at all; a number that is merely unreachable has had two hours of trying.
 */
export const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1

/**
 * When should attempt number `attemptsSoFar + 1` happen?
 *
 * Returns `null` once the cap is reached — the caller must treat that as "give up", not as
 * "try again later". Returning a time past the cap is how a queue becomes infinite.
 */
export function nextAttemptAt(
  attemptsSoFar: number,
  from: Date = new Date(),
): Date | null {
  if (attemptsSoFar >= MAX_ATTEMPTS) return null

  // `attemptsSoFar === 0` is the first attempt, which is immediate.
  const delay = attemptsSoFar === 0 ? 0 : (RETRY_BACKOFF_MS[attemptsSoFar - 1] ?? null)
  if (delay === null) return null

  return new Date(from.getTime() + delay)
}

/** A human label for a state. "Pending" should never be dressed up as "sent". */
export function notificationStatusLabel(status: NotificationStatus): string {
  switch (status) {
    case 'PENDING':
      return 'Queued'
    case 'SENT':
      return 'Handed to provider'
    case 'DELIVERED':
      return 'Delivered'
    case 'FAILED':
      return 'Failed'
    case 'BOUNCED':
      return 'Bounced'
    case 'SUPPRESSED':
      return 'Not sent'
  }
}