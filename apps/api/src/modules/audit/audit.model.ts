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
  HOSPITAL_REACTIVATED: 'hospital.reactivated',

  /**
   * A tenant record was opened in the platform console.
   *
   * Recorded separately from the mutation actions because *reading* a tenant is itself
   * sensitive: an operator browsing tenants at scale is exactly the access pattern a
   * hospital would want to be able to review after the fact.
   */
  HOSPITAL_VIEWED: 'hospital.viewed',
  HOSPITAL_PLAN_CHANGED: 'hospital.plan_changed',
  HOSPITAL_USER_VIEWED: 'hospital.users_viewed',

  // Membership / access
  MEMBERSHIP_CREATED: 'membership.created',
  MEMBERSHIP_REVOKED: 'membership.revoked',
  PERMISSIONS_CHANGED: 'membership.permissions_changed',
  MEMBERSHIP_STATUS_CHANGED: 'membership.status_changed',

  // Hospital administration (Phase 5)
  HOSPITAL_PROFILE_UPDATED: 'hospital.profile_updated',
  HOSPITAL_SETTINGS_UPDATED: 'hospital.settings_updated',
  DEPARTMENT_CREATED: 'department.created',
  DEPARTMENT_UPDATED: 'department.updated',
  DOCTOR_PROFILE_CREATED: 'doctor_profile.created',
  DOCTOR_PROFILE_UPDATED: 'doctor_profile.updated',
  SCHEDULE_UPDATED: 'doctor.schedule_updated',

  // Patients
  //
  // A patient record identifies a person who has not consented to its existence in this
  // system, so reads are audited as well as writes. What is NOT audited is the record's
  // contents: the metadata records that a record was opened and by whom, never the
  // demographics, and never an appointment reason.
  PATIENT_REGISTERED: 'patient.registered',
  PATIENT_UPDATED: 'patient.updated',
  PATIENT_VIEWED: 'patient.viewed',
  PATIENT_SEARCHED: 'patient.searched',

  // Appointments
  APPOINTMENT_BOOKED: 'appointment.booked',
  APPOINTMENT_RESCHEDULED: 'appointment.rescheduled',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  APPOINTMENT_STATUS_CHANGED: 'appointment.status_changed',
  APPOINTMENT_COMPLETED: 'appointment.completed',
  APPOINTMENT_NO_SHOW: 'appointment.no_show',
  APPOINTMENT_VIEWED: 'appointment.viewed',

  // Billing.
  //
  // Amounts are recorded as integer minor units with the currency alongside them.
  // Nothing identifying about a patient is: the trail is readable by `audit:read`, which
  // is a wider group than `billing:read`, and a financial log should not become a second
  // copy of the patient register.
  SERVICE_CREATED: 'service.created',
  SERVICE_UPDATED: 'service.updated',
  INVOICE_CREATED: 'invoice.created',
  INVOICE_ISSUED: 'invoice.issued',
  INVOICE_VOIDED: 'invoice.voided',
  INVOICE_VIEWED: 'invoice.viewed',
  PAYMENT_RECORDED: 'payment.recorded',
  PAYMENT_REFUNDED: 'payment.refunded',
  PAYMENT_VERIFIED: 'payment.verified',
  REPORT_VIEWED: 'report.viewed',
  REPORT_EXPORTED: 'report.exported',

  // Clinical records.
  //
  // Metadata carries identifiers only — never clinical narrative. The audit trail is
  // readable by `audit:read`, which is deliberately a wider group than
  // `consultation:read`, and a log is a far easier place for a medical record to leak
  // out of than the record itself is.
  CONSULTATION_CREATED: 'consultation.created',
  CONSULTATION_UPDATED: 'consultation.updated',
  CONSULTATION_AMENDED: 'consultation.amended',
  CONSULTATION_FINALIZED: 'consultation.finalized',
  CONSULTATION_VIEWED: 'consultation.viewed',
  PRESCRIPTION_CREATED: 'prescription.created',
  PRESCRIPTION_ISSUED: 'prescription.issued',
  PRESCRIPTION_VIEWED: 'prescription.viewed',
  PRESCRIPTION_DOCUMENT_DOWNLOADED: 'prescription.document_downloaded',

  // Attendance.
  ATTENDANCE_CHECKED_IN: 'attendance.checked_in',
  ATTENDANCE_CHECKED_OUT: 'attendance.checked_out',
  ATTENDANCE_CORRECTION_REQUESTED: 'attendance.correction_requested',
  ATTENDANCE_CORRECTION_APPROVED: 'attendance.correction_approved',
  ATTENDANCE_CORRECTION_REJECTED: 'attendance.correction_rejected',

  /**
   * A user account was activated or suspended from the platform side.
   *
   * Separate from `membership.revoked`: this changes the global account state, so it
   * locks the person out of EVERY hospital they belong to, not one membership.
   */
  USER_STATUS_CHANGED: 'user.status_changed',

  // Authorisation
  ACCESS_DENIED: 'access.denied',
  CROSS_TENANT_ATTEMPT: 'access.cross_tenant_attempt',
  PLATFORM_SCOPE_USED: 'access.platform_scope_used',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]
