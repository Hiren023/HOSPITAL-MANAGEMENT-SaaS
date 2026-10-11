import mongoose, { Schema } from 'mongoose'

import { DEFAULT_PLAN, HOSPITAL_DEFAULTS, PLANS } from '@infinigrow/shared'

/**
 * Domain models.
 *
 * Models are plain Mongoose schemas; business rules live in services. Two
 * collections are deliberately NOT tenant-scoped:
 *
 *  - `hospitals` IS the tenant, so it cannot carry its own `hospitalId`.
 *  - `users` is a global identity, so a person can belong to more than one
 *    hospital. Tenant membership lives on `memberships`.
 *
 * Everything else is created through `tenantScopedSchema()`, which is what makes
 * cross-tenant access structurally impossible (docs/SECURITY.md R1).
 */

// ────────────────────────────── hospitals (the tenant) ──────────────────────────────

export const HOSPITAL_STATUSES = ['PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED'] as const
export type HospitalStatus = (typeof HOSPITAL_STATUSES)[number]

const hospitalSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    registrationNumber: { type: String, trim: true, maxlength: 80 },
    contactEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },
    contactPhone: { type: String, trim: true, maxlength: 20 },
    address: {
      line1: { type: String, trim: true, maxlength: 200 },
      line2: { type: String, trim: true, maxlength: 200 },
      city: { type: String, trim: true, maxlength: 100 },
      state: { type: String, trim: true, maxlength: 100 },
      postalCode: { type: String, trim: true, maxlength: 20 },
      country: { type: String, trim: true, maxlength: 80, default: 'India' },
    },
    status: { type: String, enum: HOSPITAL_STATUSES, default: 'PENDING', index: true },
    approvedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    suspendedAt: { type: Date },
    suspensionReason: { type: String, maxlength: 500 },
    /** Set when a suspended tenant is restored, so the lifecycle is fully traceable. */
    reactivatedAt: { type: Date },

    /**
     * Subscription plan.
     *
     * Records which commercial tier a tenant is on. Phase 4 covers ASSIGNMENT ONLY:
     * there is no payment gateway, no invoicing and no automatic suspension for
     * non-payment. The seat limit is enforced server-side when staff are added; nothing
     * here decides what anyone is charged (docs/SECURITY.md R16).
     */
    plan: { type: String, enum: PLANS, default: DEFAULT_PLAN, index: true },
    planChangedAt: { type: Date },
    planChangedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    settings: {
      currency: { type: String, default: HOSPITAL_DEFAULTS.currency },
      timezone: { type: String, default: HOSPITAL_DEFAULTS.timezone },
      slotDurationMinutes: { type: Number, default: HOSPITAL_DEFAULTS.slotDurationMinutes },
      appointmentBufferMinutes: {
        type: Number,
        default: HOSPITAL_DEFAULTS.appointmentBufferMinutes,
      },
      maxAppointmentAdvanceDays: {
        type: Number,
        default: HOSPITAL_DEFAULTS.maxAppointmentAdvanceDays,
      },
      invoicePrefix: { type: String, default: HOSPITAL_DEFAULTS.invoicePrefix },
      dateFormat: { type: String, default: HOSPITAL_DEFAULTS.dateFormat },
      patientNumberPrefix: {
        type: String,
        default: HOSPITAL_DEFAULTS.patientNumberPrefix,
      },

      /**
       * Opening hours, keyed by weekday 0–6 (Sunday = 0).
       *
       * Minutes from local midnight — the same unit a doctor's schedule block stores — so
       * a booking is checked against the roster with no conversion at all. A weekday whose
       * value is `null` is CLOSED: absence means "the hospital does not work then", which
       * is the safe reading. A booking system that defaults to open will happily take a
       * 3am consultation.
       *
       * Defaults are declared per key rather than on the object, so a hospital that has
       * never been configured is open on weekdays from its very first appointment instead
       * of appearing permanently closed.
       */
      workingHours: {
        0: { type: Schema.Types.Mixed, default: HOSPITAL_DEFAULTS.workingHours[0] },
        1: { type: Schema.Types.Mixed, default: HOSPITAL_DEFAULTS.workingHours[1] },
        2: { type: Schema.Types.Mixed, default: HOSPITAL_DEFAULTS.workingHours[2] },
        3: { type: Schema.Types.Mixed, default: HOSPITAL_DEFAULTS.workingHours[3] },
        4: { type: Schema.Types.Mixed, default: HOSPITAL_DEFAULTS.workingHours[4] },
        5: { type: Schema.Types.Mixed, default: HOSPITAL_DEFAULTS.workingHours[5] },
        6: { type: Schema.Types.Mixed, default: HOSPITAL_DEFAULTS.workingHours[6] },
      },
    },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

hospitalSchema.index({ slug: 1 }, { unique: true })
hospitalSchema.index({ status: 1, createdAt: -1 })
// Supports the platform tenant list: sorted newest-first with an optional status filter.
hospitalSchema.index({ plan: 1, createdAt: -1 })

// ────────────────────────────── users (global identity) ──────────────────────────────

export const USER_STATUSES = ['ACTIVE', 'LOCKED', 'SUSPENDED', 'PENDING_VERIFICATION'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

const userSchema = new Schema(
  {
    // Lowercased on save so lookups are case-insensitive without a collation index.
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 20 },
    firstName: { type: String, required: true, trim: true, maxlength: 100 },
    lastName: { type: String, required: true, trim: true, maxlength: 100 },

    // Never selected by default: a stray `find()` must not return a credential hash.
    passwordHash: { type: String, required: true, select: false },

    status: { type: String, enum: USER_STATUSES, default: 'ACTIVE', index: true },

    /**
     * Set once the emailed OTP is verified.
     *
     * Without this field defined, Mongoose's `strict: true` silently DROPS the value on
     * write — the flag would appear to be set in code while remaining absent in the
     * database, so verification could never be enforced.
     */
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date },

    /**
     * Marks a platform (SaaS operator) administrator.
     *
     * A `SUPER_ADMIN` holds `platform:*` permissions and has NO hospital membership, so
     * sign-in cannot resolve them through a membership like every other role. This flag
     * is how `login` recognises a platform operator and issues a token with no hospital
     * scope.
     *
     * It is deliberately NOT a normal `Role`: a platform admin is not a member of any
     * hospital, so there is no membership to hang a role on.
     */
    platformRole: { type: String, enum: ['SUPER_ADMIN'], default: null, index: true },

    mfa: {
      enabled: { type: Boolean, default: false },
      /** TOTP secret, encrypted at rest. Never selected by default. */
      secretEnc: { type: String, select: false },
      recoveryCodesHash: [{ type: String, select: false }],
    },

    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
    passwordChangedAt: { type: Date },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

userSchema.index({ email: 1 }, { unique: true })
userSchema.index({ phone: 1 }, { unique: true, sparse: true })

// ────────────────────────────── memberships (user ↔ hospital) ──────────────────────────────

/**
 * A user's role inside one hospital.
 *
 * This document is the ONLY authority for who may act in which hospital. It is not
 * tenant-scoped: resolving a membership is what *establishes* the tenant context, so
 * scoping it by hospitalId would be circular. Access to it is instead gated by
 * `PlatformScope` and audited.
 */
const membershipSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    hospitalId: { type: Schema.Types.ObjectId, ref: 'Hospital', required: true },
    role: { type: String, required: true },
    /** Explicit grants. Can only NARROW the role's ceiling, never widen it. */
    grantedPermissions: { type: [String], default: [] },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED', 'REVOKED'], default: 'ACTIVE' },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    joinedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

membershipSchema.index({ hospitalId: 1, userId: 1 }, { unique: true })
membershipSchema.index({ hospitalId: 1, role: 1, status: 1 })
membershipSchema.index({ userId: 1, status: 1 })

// ────────────────────────────── refresh sessions ──────────────────────────────

/**
 * One row per issued refresh token.
 *
 * Tokens rotate on every use. `familyId` groups a chain so that replaying an
 * already-consumed token can revoke the entire lineage — the standard defence
 * against token theft (docs/SECURITY.md R6).
 */
const refreshSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** SHA-256 of the token. The raw token is never stored. */
    tokenHash: { type: String, required: true },
    familyId: { type: String, required: true, index: true },
    hospitalId: { type: Schema.Types.ObjectId, ref: 'Hospital' },
    issuedAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    replacedByTokenHash: { type: String },
    userAgent: { type: String, maxlength: 500 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// TTL index: expired sessions are removed by MongoDB, not by application cron.
refreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
refreshSessionSchema.index({ userId: 1, revokedAt: 1 })
refreshSessionSchema.index({ tokenHash: 1 })

// ────────────────────────────── password resets ──────────────────────────────

const passwordResetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** SHA-256 of a single-use token. */
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

// ────────────────────────────── models ──────────────────────────────

export const HospitalModel = mongoose.models['Hospital']
  ? (mongoose.models['Hospital'] as mongoose.Model<unknown>)
  : mongoose.model('Hospital', hospitalSchema)

export const UserModel = mongoose.models['User']
  ? (mongoose.models['User'] as mongoose.Model<unknown>)
  : mongoose.model('User', userSchema)

export const MembershipModel = mongoose.models['Membership']
  ? (mongoose.models['Membership'] as mongoose.Model<unknown>)
  : mongoose.model('Membership', membershipSchema)

export const RefreshSessionModel = mongoose.models['RefreshSession']
  ? (mongoose.models['RefreshSession'] as mongoose.Model<unknown>)
  : mongoose.model('RefreshSession', refreshSessionSchema)

export const PasswordResetModel = mongoose.models['PasswordReset']
  ? (mongoose.models['PasswordReset'] as mongoose.Model<unknown>)
  : mongoose.model('PasswordReset', passwordResetSchema)

export type HospitalDocument = mongoose.Document & Record<string, unknown>
export type UserDocument = mongoose.Document & Record<string, unknown>
