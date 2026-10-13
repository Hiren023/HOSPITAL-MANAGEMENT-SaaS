/**
 * Roles and permissions — the single source of truth for authorisation.
 *
 * Both the API (authorisation middleware) and the web app (UI gating) import from
 * here so that a permission can never drift between client and server.
 *
 * SECURITY: the web app uses these helpers for UX only. The API re-checks every
 * permission server-side. Never rely on hiding a UI control as access control.
 */

export const ROLES = [
  'SUPER_ADMIN',
  'HOSPITAL_ADMIN',
  'DOCTOR',
  'RECEPTIONIST',
  'STAFF',
  'PHARMACIST',
  'ACCOUNTANT',
  'PATIENT',
] as const

export type Role = (typeof ROLES)[number]

/**
 * Roles a hospital administrator may assign to a member of their own hospital.
 *
 * `SUPER_ADMIN` is excluded, and `PATIENT` too: a patient is the subject of care, not
 * a member of staff who can be given a staff account. Both exclusions are enforced in
 * this shared list rather than only in the API's validation schema, so the client's role
 * picker offers only assignable roles and cannot drift from what the server accepts.
 *
 * `SUPER_ADMIN` also cannot appear here even by accident — a hospital has no membership
 * that a platform operator could be attached to, and granting one would mint an account
 * that can suspend every hospital on the platform.
 */
export const HOSPITAL_ASSIGNABLE_ROLES = [
  'HOSPITAL_ADMIN',
  'DOCTOR',
  'RECEPTIONIST',
  'STAFF',
  'PHARMACIST',
  'ACCOUNTANT',
] as const

export type HospitalAssignableRole = (typeof HOSPITAL_ASSIGNABLE_ROLES)[number]

export function isHospitalAssignableRole(value: unknown): value is HospitalAssignableRole {
  return (
    typeof value === 'string' &&
    (HOSPITAL_ASSIGNABLE_ROLES as readonly string[]).includes(value)
  )
}

/** True for roles that may never be granted by a hospital, whatever the request says. */
export function isPlatformOnlyRole(value: string): boolean {
  return !isHospitalAssignableRole(value)
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/**
 * Permission format: `<resource>:<action>`.
 *
 * `platform:*` permissions are SaaS-operator level and are deliberately disjoint from
 * hospital-scoped permissions — see ROLE_PERMISSIONS below.
 */
export const PERMISSIONS = [
  // Platform operations (SaaS operator)
  'platform:hospital:read',
  'platform:hospital:write',
  'platform:hospital:approve',
  'platform:hospital:suspend',
  'platform:plan:manage',
  'platform:settings:manage',
  'platform:audit:read',

  /**
   * Manage a tenant's user accounts from the platform side (activate, suspend).
   *
   * Deliberately distinct from `user:write`. A hospital administrator manages staff
   * *inside their own hospital*; this operates across every tenant, so it is held only by
   * the SaaS operator and never by a hospital role.
   */
  'platform:user:manage',

  /**
   * Cross-tenant operational reports.
   *
   * Reports here are aggregate counts only — tenant totals, growth, activity volumes.
   * No permission grants a platform operator access to patient records, because no such
   * capability exists in the product (docs/SECURITY.md R14).
   */
  'platform:report:read',

  // Hospital administration
  'hospital:read',
  'hospital:write',
  'hospital:settings:manage',

  /**
   * See this hospital's own subscription: plan, status, entitlements, usage, renewal date.
   *
   * Distinct from `hospital:read`, which every tenant role holds. A doctor or a
   * pharmacist has no reason to know what the hospital pays the platform, and the cost of
   * telling them is a support conversation about a number they cannot act on.
   *
   * Read-only by design. A tenant cannot renew, upgrade or suspend itself — that is the
   * platform operator's action, and the only payment state a tenant can reach is the one
   * it already has. See `docs/specs/phase9-subscriptions.md` section 5.
   */
  'subscription:read',

  'user:read',
  'user:write',
  'user:permissions:manage',

  // Clinical organisation
  'department:read',
  'department:write',

  /**
   * Doctors and their professional profiles.
   *
   * Distinct from `user:read`: a doctor's registration number, qualifications and
   * consultation fee are professional records, not account records, and the two are not
   * the same audience.
   */
  'doctor:read',
  'doctor:write',

  /** Working schedules and availability. */
  'schedule:read',
  'schedule:write',

  // Patients
  'patient:read',
  'patient:write',

  // Appointments.
  //
  // `appointment:read` / `appointment:write` scope a DOCTOR to their OWN schedule; the
  // `:any` variants lift that and are what reception and administration hold, because
  // booking on behalf of other doctors is their job.
  //
  // Modelled as permissions rather than a role-name check so "self only" is enforced by
  // the same mechanism as everything else, and a future role that should see the whole
  // clinic is granted it explicitly rather than having it inferred from its name.
  'appointment:read',
  'appointment:write',
  'appointment:read:any',
  'appointment:write:any',

  // Clinical records
  //
  // The bare permissions mean "my own records". The `:any` variants mean "every
  // clinician's records in this hospital" and are what an administrator or a medical
  // director holds. A doctor deliberately does NOT hold them by default: clinical notes
  // are written by a named person about a person they saw, and opening them to every
  // colleague by default would make attribution decorative.
  'consultation:read',
  'consultation:write',
  'consultation:read:any',
  'consultation:write:any',
  'prescription:read',
  'prescription:write',

  // Attendance
  //
  // Same shape: `attendance:read` / `attendance:write` are self-scoped, `:any` is the
  // whole team, and `attendance:approve` is the authority that applies a correction.
  'attendance:read',
  'attendance:write',
  'attendance:read:any',
  'attendance:write:any',
  'attendance:approve',

  // Billing and finance
  'billing:read',
  'billing:write',
  'payment:read',
  'payment:write',

  // Reporting
  'report:read',
  'report:financial',

  // Platform messaging
  'notification:read',
  'notification:send',

  // Compliance
  'audit:read',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value)
}

const HOSPITAL_MANAGEMENT_PERMISSIONS = [
  'hospital:read',
  'hospital:write',
  'hospital:settings:manage',
  'subscription:read',
  'user:read',
  'user:write',
  'user:permissions:manage',
  'department:read',
  'department:write',
  'doctor:read',
  'doctor:write',
  'schedule:read',
  'schedule:write',
  'patient:read',
  'patient:write',
  'appointment:read',
  'appointment:write',
  'appointment:read:any',
  'appointment:write:any',
  'consultation:read',
  'consultation:write',
  'consultation:read:any',
  'consultation:write:any',
  'prescription:read',
  'prescription:write',
  'attendance:read',
  'attendance:write',
  'attendance:read:any',
  'attendance:write:any',
  'attendance:approve',
  'billing:read',
  'billing:write',
  'payment:read',
  'payment:write',
  'report:read',
  'report:financial',
  'notification:read',
  'notification:send',
  'audit:read',
] as const satisfies readonly Permission[]

/**
 * Fixed role → permission mapping. A hospital may grant a *subset* of these to a staff
 * membership, but never escalate beyond the role's ceiling (enforced server-side).
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = Object.freeze({
  /**
   * The SaaS operator manages tenants commercially — approval, suspension, plans.
   * There is intentionally NO default access to patient clinical data.
   * Any future support access must be an audited, time-boxed break-glass flow.
   */
  SUPER_ADMIN: new Set<Permission>([
    'platform:hospital:read',
    'platform:hospital:write',
    'platform:hospital:approve',
    'platform:hospital:suspend',
    'platform:plan:manage',
    'platform:settings:manage',
    'platform:audit:read',
    'platform:user:manage',
    'platform:report:read',
  ]),

  /** Full administration of one authorised hospital. */
  HOSPITAL_ADMIN: new Set<Permission>(HOSPITAL_MANAGEMENT_PERMISSIONS),

  /** Clinical staff. Tenant scope plus care-team scoping is applied at the service layer. */
  DOCTOR: new Set<Permission>([
    'hospital:read',
    'department:read',
    'doctor:read',
    'schedule:read',
    'schedule:write',
    'patient:read',
    'patient:write',
    'appointment:read',
    'appointment:write',
    'consultation:read',
    'consultation:write',
    'prescription:read',
    'prescription:write',
    'attendance:read',
    'attendance:write',
    'report:read',
    'notification:read',
  ]),

  /**
   * Front-desk staff. Note the absence of `consultation:read`: registration staff
   * must not be able to read clinical notes. See docs/SECURITY.md R9.
   */
  RECEPTIONIST: new Set<Permission>([
    'hospital:read',
    'department:read',
    // Reception books appointments, which requires knowing who the doctors are and
    // when they work. Read-only: a receptionist has no business editing a doctor's
    // professional record or their schedule.
    'doctor:read',
    'schedule:read',
    'patient:read',
    'patient:write',
    'appointment:read',
    'appointment:write',
    // Reception books on behalf of every doctor in the clinic, so it holds the `:any`
    // variants. This is the difference between reception's view and a doctor's.
    'appointment:read:any',
    'appointment:write:any',
    'attendance:read',
    'attendance:write',
    'notification:read',
  ]),

  /** Baseline staff: attendance and notifications only, unless explicitly granted more. */
  STAFF: new Set<Permission>([
    'hospital:read',
    'attendance:read',
    'attendance:write',
    'notification:read',
  ]),

  /** Introduced with the pharmacy module (post-MVP). */
  PHARMACIST: new Set<Permission>([
    'hospital:read',
    'department:read',
    'patient:read',
    'attendance:read',
    'attendance:write',
    'notification:read',
  ]),

  /**
   * Finance staff. Has `patient:read` for demographics only — clinical note and
   * consultation content is stripped by role-specific response schemas, not hidden
   * by the frontend. See docs/ARCHITECTURE.md section 6.4.
   */
  ACCOUNTANT: new Set<Permission>([
    'hospital:read',
    'patient:read',
    'appointment:read',
    // Billing spans the whole clinic, so an accountant sees everyone's appointments.
    // Without `:any` the self-scoping rule would show them none at all, which is not
    // "restricted", it is "broken".
    'appointment:read:any',
    'billing:read',
    'billing:write',
    'payment:read',
    'payment:write',
    'report:read',
    'report:financial',
    'attendance:read',
    'attendance:write',
    // An accountant reconciles the hospital's bills with the platform's, so the plan and
    // its renewal date are their business. Nobody else's are.
    'subscription:read',
    'notification:read',
  ]),

  /** Patient portal (post-MVP). Reserved; no permissions defined yet. */
  PATIENT: new Set<Permission>([]),
})

/** Permissions a role can never hold, regardless of any grant. */
export const PLATFORM_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'platform:hospital:read',
  'platform:hospital:write',
  'platform:hospital:approve',
  'platform:hospital:suspend',
  'platform:plan:manage',
  'platform:settings:manage',
  'platform:audit:read',
  'platform:user:manage',
  'platform:report:read',
])

/**
 * Resolve the effective permission set for a membership.
 *
 * When a membership carries explicit grants, those grants ARE the allowlist — they
 * narrow the role's ceiling. They can never widen it: a permission outside the role's
 * ceiling, or outside the platform/hospital boundary, is discarded.
 *
 * With no grants, the full role ceiling applies.
 */
export function resolvePermissions(
  role: Role,
  grantedPermissions: readonly string[] = [],
): Set<Permission> {
  const ceiling = ROLE_PERMISSIONS[role]

  if (grantedPermissions.length === 0) {
    return new Set<Permission>(ceiling)
  }

  const resolved = new Set<Permission>()

  for (const candidate of grantedPermissions) {
    if (!isPermission(candidate)) continue // unknown grants are ignored, never trusted
    if (!ceiling.has(candidate)) continue // cannot escalate above the role ceiling
    resolved.add(candidate)
  }

  return resolved
}

/** Convenience predicate: does `permissions` contain `required`? */
export function hasPermission(
  permissions: ReadonlySet<Permission> | undefined,
  required: Permission,
): boolean {
  return permissions?.has(required) ?? false
}

/** Convenience predicate: does `permissions` contain every one of `required`? */
export function hasAllPermissions(
  permissions: ReadonlySet<Permission> | undefined,
  required: readonly Permission[],
): boolean {
  if (!permissions) return false
  return required.every((permission) => permissions.has(permission))
}

/** True for roles that operate across hospitals rather than inside one tenant. */
export function isPlatformRole(role: Role): boolean {
  return role === 'SUPER_ADMIN'
}
