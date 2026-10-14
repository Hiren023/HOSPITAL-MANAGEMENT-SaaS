import mongoose, { Schema } from 'mongoose'
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  SUPPRESSION_REASONS,
} from '@infinigrow/shared'

import { tenantScopedSchema } from '../../infrastructure/db/tenant-plugin.js'

/**
 * Notification storage.
 *
 * ── What is NOT stored on a Notification ───────────────────────────────────────
 *
 * There is no `to` field. No phone number, no email address, no rendered body.
 *
 * `recipientRef` is an opaque reference to a patient or a user, and the contact point is
 * looked up from that record at send time. This is not tidiness, it is a correction
 * problem: a notification is history, history does not get rewritten when a patient's
 * number changes, and a table full of phone numbers is a breach waiting for an export
 * mistake. Storing the reference keeps the queue working and the contact data in exactly
 * one place.
 *
 * The rendered body is likewise not stored. It is derived from a reviewed template plus
 * five allowed values, and a stored copy would be clinical text sitting in a table that
 * exports more freely than a clinical record does.
 */

/** An opaque pointer at whoever is being contacted. Never a contact detail itself. */
export const RECIPIENT_KINDS = ['PATIENT', 'USER'] as const

const notificationSchema = tenantScopedSchema(
  'Notification',
  {
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
    /** A key from `notification.templates.ts`. Never a body. */
    templateKey: { type: String, required: true, trim: true, maxlength: 60 },

    recipientKind: { type: String, enum: RECIPIENT_KINDS, required: true },
    /** `Patient` or `User` id. Resolved to a contact point only at send time. */
    recipientRef: { type: Schema.Types.ObjectId, required: true },

    category: { type: String, enum: NOTIFICATION_CATEGORIES, required: true },

    status: { type: String, enum: NOTIFICATION_STATUSES, required: true, default: 'PENDING' },

    attempts: { type: Number, required: true, default: 0, min: 0 },
    maxAttempts: { type: Number, required: true, default: 6, min: 1 },

    /** When the next attempt is due. `null` means the queue should not pick this up. */
    nextAttemptAt: { type: Date },

    /** Append-only, so "what went wrong, and when" is answerable after an incident. */
    attemptsLog: {
      type: [
        new Schema(
          {
            attempt: { type: Number, required: true },
            at: { type: Date, required: true, default: () => new Date() },
            outcome: { type: String, required: true, maxlength: 30 },
            reason: { type: String, trim: true, maxlength: 300 },
            providerMessageId: { type: String, trim: true, maxlength: 200 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    providerMessageId: { type: String, trim: true, maxlength: 200 },
    failureReason: { type: String, trim: true, maxlength: 300 },
    /** Set when the status is SUPPRESSED, so "why was nothing sent" is answerable. */
    suppressionReason: { type: String, enum: SUPPRESSION_REASONS },

    /** The five values a template may substitute. Never clinical text. */
    substitutions: {
      recipientName: { type: String, trim: true, maxlength: 100 },
      dateLabel: { type: String, trim: true, maxlength: 60 },
      timeLabel: { type: String, trim: true, maxlength: 40 },
      departmentName: { type: String, trim: true, maxlength: 120 },
      locationName: { type: String, trim: true, maxlength: 120 },
    },

    enqueuedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    sentAt: { type: Date },
    /** Unreachable in this MVP. See `notification-provider.ts`. */
    deliveredAt: { type: Date },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// The queue sweep: everything due, in order.
notificationSchema.index({ status: 1, nextAttemptAt: 1 })
// The list screen, newest first, for one tenant.
//
// `{hospitalId, createdAt: -1}` is deliberately NOT declared here: `tenantScopedSchema`
// adds it to every tenant-scoped schema, and declaring it twice makes Mongoose warn that
// the options of the duplicate definition will not be applied — which is a trap, because
// the next person to add `unique: true` to the second copy would silently get no unique
// index at all.
notificationSchema.index({ hospitalId: 1, recipientRef: 1, createdAt: -1 })

/**
 * Consent, per recipient and per channel.
 *
 * Modelled as a mutable record rather than an append-only log so that "revoke" is a
 * single field flip and the answer to "may we message this person right now" is a lookup
 * rather than a fold. The audit trail carries the history of the decision; this table
 * carries the decision.
 */
const consentSchema = tenantScopedSchema(
  'NotificationConsent',
  {
    recipientKind: { type: String, enum: RECIPIENT_KINDS, required: true },
    recipientRef: { type: Schema.Types.ObjectId, required: true },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
    granted: { type: Boolean, required: true },
    grantedAt: { type: Date },
    revokedAt: { type: Date },
    /** How the decision was captured. "who said so" matters when it is disputed. */
    source: { type: String, trim: true, maxlength: 40 },
    recordedByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// One consent record per recipient per channel. Without this, "grant" could append a
// second row and a naive read would find whichever came first — so revocation could
// silently not take effect.
consentSchema.index({ hospitalId: 1, recipientRef: 1, channel: 1 }, { unique: true })

/**
 * A staff member's own channel/category preferences.
 *
 * Scoped to a `User`, not a `recipientRef`, because this is the *hospital's own people*
 * choosing not to be emailed. Patients get `NotificationConsent`, which is consent rather
 * than preference — a different relationship with a different default.
 */
const preferenceSchema = tenantScopedSchema(
  'NotificationPreference',
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
    category: { type: String, enum: NOTIFICATION_CATEGORIES, required: true },
    enabled: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

preferenceSchema.index({ hospitalId: 1, userId: 1, channel: 1, category: 1 }, { unique: true })

/**
 * Register a model under a name, reusing one already registered.
 *
 * ── Why this does NOT use `mongoose.model<T>(...)` ──────────────────────────────
 *
 * Passing an explicit type argument to `mongoose.model` forces TypeScript to fully
 * instantiate `Model<T>`. `Model` has hundreds of members, every one of them generic, so
 * resolving them over `Record<string, unknown>` means resolving hundreds of generic
 * signatures against an index-signature type. That is a known and reproducible way to
 * make `tsc` exhaust its heap.
 *
 * It did. `npm run typecheck` on the API workspace died with
 * `FATAL ERROR: Ineffective mark-compacts near heap limit` at every heap size from 3 GB
 * to 8 GB. Bisecting the project found this file; the other seven model modules compile
 * in milliseconds.
 *
 * `Model<unknown>` is what every other model module here uses, and `mongoose.model(...)`
 * is called WITHOUT a type argument so the instantiation stays lazy. If a module ever
 * needs a precisely-typed model, the fix is a repository wrapper returning a narrow
 * interface — never an explicit argument here.
 */
function register(name: string, schema: Schema): mongoose.Model<unknown> {
  const existing = mongoose.models[name] as mongoose.Model<unknown> | undefined

  // `mongoose.model()` without a type argument resolves to a heavily-parameterised
  // `Model`, which is not structurally identical to the `Model<unknown>` the registry is
  // typed as. Widening once here is cheaper — and far more readable — than instantiating
  // the generic at the call site, which is what exhausted the compiler.
  return existing ?? (mongoose.model(name, schema) as unknown as mongoose.Model<unknown>)
}

export const NotificationModel = register('Notification', notificationSchema)
export const NotificationConsentModel = register('NotificationConsent', consentSchema)
export const NotificationPreferenceModel = register('NotificationPreference', preferenceSchema)