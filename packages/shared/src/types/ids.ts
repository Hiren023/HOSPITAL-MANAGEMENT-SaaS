/**
 * Branded identifier types.
 *
 * Branding makes it a compile error to pass, for example, a `HospitalId` where a
 * `PatientId` is expected. This matters here because tenant scoping bugs are the
 * highest-severity defect class in this product.
 */

declare const brandSymbol: unique symbol

export type Brand<TBase, TBrand extends string> = TBase & {
  readonly [brandSymbol]: TBrand
}

/** A MongoDB ObjectId in its 24-character hexadecimal string form. */
export type ObjectId = Brand<string, 'ObjectId'>

export type UserId = Brand<ObjectId, 'UserId'>
export type HospitalId = Brand<ObjectId, 'HospitalId'>
export type MembershipId = Brand<ObjectId, 'MembershipId'>
export type DepartmentId = Brand<ObjectId, 'DepartmentId'>
export type DoctorProfileId = Brand<ObjectId, 'DoctorProfileId'>
export type StaffProfileId = Brand<ObjectId, 'StaffProfileId'>
export type PatientId = Brand<ObjectId, 'PatientId'>
export type AppointmentId = Brand<ObjectId, 'AppointmentId'>
export type ConsultationId = Brand<ObjectId, 'ConsultationId'>
export type PrescriptionId = Brand<ObjectId, 'PrescriptionId'>
export type InvoiceId = Brand<ObjectId, 'InvoiceId'>
export type PaymentId = Brand<ObjectId, 'PaymentId'>
export type BillingItemId = Brand<ObjectId, 'BillingItemId'>
export type NotificationId = Brand<ObjectId, 'NotificationId'>
export type AuditLogId = Brand<ObjectId, 'AuditLogId'>
export type SessionId = Brand<string, 'SessionId'>

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/

export function isObjectId(value: unknown): value is ObjectId {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value)
}

/** Parse an untrusted string into an `ObjectId`, or return null. Never throws. */
export function toObjectId(value: unknown): ObjectId | null {
  return isObjectId(value) ? value : null
}

/**
 * Convert an untrusted string into a specific branded id type.
 * Returns null rather than throwing so callers must handle invalid input explicitly.
 */
export function toBrandedId<TBrand extends string>(value: unknown): Brand<ObjectId, TBrand> | null {
  return isObjectId(value) ? (value as Brand<ObjectId, TBrand>) : null
}
