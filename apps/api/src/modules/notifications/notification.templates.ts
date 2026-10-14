/**
 * Built-in notification templates.
 *
 * ── These are code, and that is the whole privacy control ──────────────────────
 *
 * There is no endpoint that accepts a message body. Every message this module can send is
 * one of the templates below, with only the recipient's own name, a date, a time, a
 * department name or a location name substituted in. Clinical text has no slot to
 * occupy.
 *
 * A user-authored template feature was considered and rejected for the MVP. It sounds
 * harmless — "let reception reword the reminder" — but a template body is exactly where a
 * diagnosis would end up the first time somebody wanted to be helpful. Reviewing a
 * template is cheap; un-sending a leaked diagnosis is not. If it is ever added, the
 * review and the preview validator must come with it, not after.
 *
 * ── "Sign in to view it" ───────────────────────────────────────────────────────
 *
 * The clinical and billing templates deliberately say only that something exists. An SMS is
 * readable by whoever holds the phone, is stored in the handset, travels over a network
 * the operator logs, and may sit in a backup. The notification says **that**; the
 * authorised application says **what**.
 */

import {
  assertSafePreview,
  type NotificationCategory,
  type NotificationChannel,
} from '@infinigrow/shared'

export interface TemplateDefinition {
  /** Stable key used in API calls. Never localised, never renamed. */
  key: string
  channel: NotificationChannel
  category: NotificationCategory
  /** Short description for the UI, never sent to anyone. */
  description: string
  /** Subject line. `null` for SMS, which has none. */
  subject: string | null
  body: string
  active: boolean
}

/**
 * Every message the system can send.
 *
 * `assertSafePreview` runs over these **at module load**, not only in a test. A template
 * that fails the rule takes the process down at boot rather than quietly entering the
 * system: a privacy control that can be switched off by adding a line is not a control.
 */
const DEFINITIONS: readonly TemplateDefinition[] = [
  {
    key: 'APPOINTMENT_REMINDER',
    channel: 'SMS',
    category: 'APPOINTMENT',
    description: 'Reminds a patient of an upcoming appointment.',
    subject: null,
    body: 'Hello {{recipientName}}, your appointment is on {{dateLabel}} at {{timeLabel}}. Please arrive 10 minutes early. Reply HELP for help.',
    active: true,
  },
  {
    key: 'APPOINTMENT_REMINDER_EMAIL',
    channel: 'EMAIL',
    category: 'APPOINTMENT',
    description: 'Reminds a patient of an upcoming appointment by email.',
    subject: 'Your appointment on {{dateLabel}}',
    body: 'Hello {{recipientName}}, your appointment is on {{dateLabel}} at {{timeLabel}} in {{departmentName}}. Please arrive 10 minutes early.',
    active: true,
  },
  {
    key: 'CONSULTATION_READY',
    channel: 'SMS',
    category: 'CLINICAL',
    description: 'Tells a patient a consultation record is available.',
    subject: null,
    // No department, no date: "a record is ready" is the entire content.
    body: 'Hello {{recipientName}}, a record is ready. Sign in to view it.',
    active: true,
  },
  {
    key: 'REPORT_READY',
    channel: 'SMS',
    category: 'CLINICAL',
    description: 'Tells a patient a report is available.',
    subject: null,
    // Deliberately says "report", never what the report says. A result value in a
    // message is the single most damaging leak this module could produce.
    body: 'Hello {{recipientName}}, a report is available. Sign in to view it.',
    active: true,
  },
  {
    key: 'PAYMENT_RECEIPT',
    channel: 'SMS',
    category: 'BILLING',
    description: 'Tells a patient a receipt is available.',
    subject: null,
    body: 'Hello {{recipientName}}, a receipt is available. Sign in to view it.',
    active: true,
  },
  {
    key: 'PAYMENT_REMINDER',
    channel: 'EMAIL',
    category: 'BILLING',
    description: 'Reminds a patient that an invoice is outstanding.',
    subject: 'An invoice is outstanding',
    // No amount. An SMS saying "you owe 4,200" discloses both a debt and a balance to
    // whoever holds the phone; the amount belongs in the application.
    body: 'Hello {{recipientName}}, an invoice is outstanding on your account. Sign in to view it.',
    active: true,
  },
  {
    key: 'WELCOME',
    channel: 'EMAIL',
    category: 'ADMINISTRATIVE',
    description: 'Welcomes a newly registered patient.',
    subject: 'Welcome',
    body: 'Hello {{recipientName}}, your account at {{locationName}} is ready. Sign in to view it.',
    active: true,
  },
  {
    key: 'APPOINTMENT_RESCHEDULED',
    channel: 'SMS',
    category: 'APPOINTMENT',
    description: 'Tells a patient an appointment moved.',
    subject: null,
    body: 'Hello {{recipientName}}, your appointment has changed to {{dateLabel}} at {{timeLabel}}. Sign in to view the details.',
    active: true,
  },
]

/**
 * Fails at import if any built-in template breaks the preview rule.
 *
 * Run unconditionally. The alternative — validating templates in a test — means the check
 * passes in CI and does nothing at runtime, so a template added in a hurry is shipped
 * without anyone looking.
 */
for (const definition of DEFINITIONS) {
  assertSafePreview(definition.body)
  if (definition.subject !== null) assertSafePreview(definition.subject)
}

const BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]))

export function templateByKey(key: string): TemplateDefinition | null {
  return BY_KEY.get(key) ?? null
}

export function allTemplates(): readonly TemplateDefinition[] {
  return DEFINITIONS
}

export function templatesForChannel(channel: NotificationChannel): TemplateDefinition[] {
  return DEFINITIONS.filter((definition) => definition.channel === channel && definition.active)
}

export const TEMPLATE_KEYS = DEFINITIONS.map((definition) => definition.key) as readonly string[]

/**
 * Substitute the allowed placeholders.
 *
 * Deliberately a **fixed set of substitutions**, not a generic merge. A caller cannot pass
 * `{ diagnosis: '...' }` and have it land in the body, because the only keys this function
 * will look for are the five allowed ones. This is the structural half of the privacy
 * control described at the top of the file.
 *
 * An unresolved placeholder is left as-is rather than replaced with an empty string: a
 * message reading "your appointment is on  at 10:30" is obviously broken, and an obviously
 * broken message gets fixed. A message reading "your appointment is on 12 Oct at " is
 * merely wrong.
 */
export function renderTemplate(
  definition: TemplateDefinition,
  values: Partial<Record<'recipientName' | 'dateLabel' | 'timeLabel' | 'departmentName' | 'locationName', string>>,
): { subject: string | null; body: string } {
  const replace = (input: string): string =>
    input.replace(/\{\{\s*(recipientName|dateLabel|timeLabel|departmentName|locationName)\s*\}\}/g, (match, key: string) => {
      const value = values[key as keyof typeof values]
      return value === undefined || value === '' ? match : value
    })

  // Re-checked on the RENDERED text. A substituted value is attacker-influenced in the
  // sense that it comes from a patient record: a patient whose name is "Dr. High BP
  // Tablet 500mg" would otherwise carry a clinical term straight into a message.
  const body = replace(definition.body)
  assertSafePreview(body)

  const subject = definition.subject === null ? null : replace(definition.subject)
  if (subject !== null) assertSafePreview(subject)

  return { subject, body }
}