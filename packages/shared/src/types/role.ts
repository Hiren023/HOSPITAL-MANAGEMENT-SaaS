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

  // Hospital administration
  'hospital:read',
  'hospital:write',
  'hospital:settings:manage',
  'user:read',
  'user:write',
  'user:permissions:manage',

  // Clinical organisation
  'department:read',
  'department:write',

  // Patients
  'patient:read',
  'patient:write',

  // Appointments
  'appointment:read',
  'appointment:write',

  // Clinical records
  'consultation:read',
  'consultation:write',
  'prescription:read',
  'prescription:write',

  // Attendance
  'attendance:read',
  'attendance:write',
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
  'user:read',
  'user:write',
  'user:permissions:manage',
  'department:read',
  'department:write',
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
  ]),

  /** Full administration of one authorised hospital. */
  HOSPITAL_ADMIN: new Set<Permission>(HOSPITAL_MANAGEMENT_PERMISSIONS),

  /** Clinical staff. Tenant scope plus care-team scoping is applied at the service layer. */
  DOCTOR: new Set<Permission>([
    'hospital:read',
    'department:read',
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
    'patient:read',
    'patient:write',
    'appointment:read',
    'appointment:write',
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
    'billing:read',
    'billing:write',
    'payment:read',
    'payment:write',
    'report:read',
    'report:financial',
    'attendance:read',
    'attendance:write',
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
