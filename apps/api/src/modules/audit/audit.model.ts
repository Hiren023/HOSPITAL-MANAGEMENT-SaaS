import { Schema } from 'mongoose'
import mongoose from 'mongoose'

/**
 * Audit log — the accountability backbone for a healthcare system
 * (docs/SECURITY.md R15).
 *
 * Design decisions:
 *
 *  - **Append-only, enforced at the schema level.** A pre-hook rejects `updateOne`,
 *    `updateMany`, `deleteOne`, `deleteMany` and `findOneAndUpdate`. No route may
 *    edit or remove an audit entry; there is deliberately no service method that can.
 *  - **Not tenant-scoped.** A `SUPER_ADMIN` action has no hospital, so the tenant
 *    plugin cannot be applied. Tenant filtering is done by the read path instead.
 *  - **Identifiers, never values.** `metadata` records the *names* of fields that
 *    changed, not their contents. Credentials, tokens and patient data must never
 *    reach this collection — `recordAudit` strips them (see audit.service.ts).
 */
const auditLogSchema = new Schema(
  {
    /** Null for platform-level actions that have no hospital. */
    hospitalId: { type: Schema.Types.ObjectId, ref: 'Hospital', index: true },

    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    actorRole: { type: String },
    /** True for a service or system actor with no signed-in user. */
    isSystemActor: { type: Boolean, default: false },

    action: { type: String, required: true, maxlength: 100, index: true },
    resourceType: { type: String, maxlength: 80 },
    resourceId: { type: String, maxlength: 100 },

    outcome: {
      type: String,
      enum: ['SUCCESS', 'FAILURE', 'DENIED'],
      default: 'SUCCESS',
      index: true,
    },

    ip: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 500 },
    requestId: { type: String, maxlength: 100 },

    /** Field NAMES only — never field values. */
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: true, strictQuery: true },
)

auditLogSchema.index({ hospitalId: 1, createdAt: -1 })
auditLogSchema.index({ actorUserId: 1, createdAt: -1 })
auditLogSchema.index({ action: 1, createdAt: -1 })

/**
 * Reject any attempt to mutate an existing audit entry.
 *
 * This is a schema-level guarantee rather than a convention: even a developer who
 * writes `AuditLogModel.deleteMany({})` at a console prompt cannot remove evidence.
 */
const IMMUTABLE_OPERATIONS = [
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'replaceOne',
] as const

for (const operation of IMMUTABLE_OPERATIONS) {
  auditLogSchema.pre(operation as never, { query: true, document: false } as never, function () {
    throw new Error(
      `AuditLog is append-only: "${operation}" is not permitted. ` +
        'Audit entries may only be created, never modified or removed.',
    )
  })
}

export const AuditLogModel =
  (mongoose.models['AuditLog'] as mongoose.Model<Record<string, unknown>> | undefined) ??
  mongoose.model<Record<string, unknown>>('AuditLog', auditLogSchema)

/** Canonical action names, so audit queries cannot drift between modules. */
export const AUDIT_ACTIONS = {
  // Authentication
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout',
  TOKEN_REFRESHED: 'auth.token.refreshed',
  TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',
  ACCOUNT_LOCKED: 'auth.account.locked',

  // Password
  PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password.reset_completed',
  PASSWORD_CHANGED: 'auth.password.changed',

  // Email / OTP
  OTP_REQUESTED: 'auth.otp.requested',
  OTP_VERIFIED: 'auth.otp.verified',
  OTP_FAILED: 'auth.otp.failed',
  EMAIL_VERIFIED: 'auth.email.verified',

  // Tenant lifecycle
  HOSPITAL_REGISTERED: 'hospital.registered',
  HOSPITAL_APPROVED: 'hospital.approved',
  HOSPITAL_REJECTED: 'hospital.rejected',
  HOSPITAL_SUSPENDED: 'hospital.suspended',

  // Membership / access
  MEMBERSHIP_CREATED: 'membership.created',
  MEMBERSHIP_REVOKED: 'membership.revoked',
  PERMISSIONS_CHANGED: 'membership.permissions_changed',

  // Authorisation
  ACCESS_DENIED: 'access.denied',
  CROSS_TENANT_ATTEMPT: 'access.cross_tenant_attempt',
  PLATFORM_SCOPE_USED: 'access.platform_scope_used',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]
