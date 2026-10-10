import { describe, expect, it } from 'vitest'

import {
  PERMISSIONS,
  PLATFORM_ONLY_PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  hasAllPermissions,
  hasPermission,
  isPlatformRole,
  isPermission,
  isRole,
  resolvePermissions,
} from '../types/role.js'

describe('role and permission type guards', () => {
  it('recognises known roles and rejects unknown ones', () => {
    expect(isRole('DOCTOR')).toBe(true)
    expect(isRole('SUPER_ADMIN')).toBe(true)
    expect(isRole('doctor')).toBe(false)
    expect(isRole('ROOT')).toBe(false)
    expect(isRole(null)).toBe(false)
    expect(isRole(42)).toBe(false)
  })

  it('recognises known permissions and rejects unknown ones', () => {
    expect(isPermission('patient:read')).toBe(true)
    expect(isPermission('patient:delete-everything')).toBe(false)
    expect(isPermission(undefined)).toBe(false)
  })
})

describe('ROLE_PERMISSIONS matrix integrity', () => {
  it('defines a permission set for every declared role', () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role], `missing permission set for ${role}`).toBeInstanceOf(Set)
    }
  })

  it('only ever contains declared permissions', () => {
    const declared = new Set<string>(PERMISSIONS)
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(declared.has(permission), `${role} holds undeclared ${permission}`).toBe(true)
      }
    }
  })

  it('never lets a hospital-scoped role hold a platform permission', () => {
    for (const role of ROLES) {
      if (isPlatformRole(role)) continue
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(
          PLATFORM_ONLY_PERMISSIONS.has(permission),
          `${role} must not hold platform permission ${permission}`,
        ).toBe(false)
      }
    }
  })

  it('restricts SUPER_ADMIN to platform permissions only (least privilege)', () => {
    // A support operator managing tenants must NOT silently browse clinical records.
    expect(hasPermission(ROLE_PERMISSIONS.SUPER_ADMIN, 'patient:read')).toBe(false)
    expect(hasPermission(ROLE_PERMISSIONS.SUPER_ADMIN, 'consultation:read')).toBe(false)
    expect(hasPermission(ROLE_PERMISSIONS.SUPER_ADMIN, 'billing:read')).toBe(false)
    expect(hasPermission(ROLE_PERMISSIONS.SUPER_ADMIN, 'platform:hospital:approve')).toBe(true)
  })

  it('prevents RECEPTIONIST and ACCOUNTANT from reading clinical notes', () => {
    // Front-desk staff must not read clinical notes (docs/SECURITY.md R9).
    expect(hasPermission(ROLE_PERMISSIONS.RECEPTIONIST, 'consultation:read')).toBe(false)
    expect(hasPermission(ROLE_PERMISSIONS.RECEPTIONIST, 'prescription:read')).toBe(false)
    // Finance staff must not read clinical notes either.
    expect(hasPermission(ROLE_PERMISSIONS.ACCOUNTANT, 'consultation:read')).toBe(false)
    expect(hasPermission(ROLE_PERMISSIONS.ACCOUNTANT, 'prescription:read')).toBe(false)
  })

  it('gives DOCTOR the clinical permissions it needs', () => {
    expect(hasPermission(ROLE_PERMISSIONS.DOCTOR, 'patient:read')).toBe(true)
    expect(hasPermission(ROLE_PERMISSIONS.DOCTOR, 'consultation:write')).toBe(true)
    expect(hasPermission(ROLE_PERMISSIONS.DOCTOR, 'prescription:write')).toBe(true)
  })

  it('gives STAFF a deliberately minimal baseline', () => {
    expect(hasPermission(ROLE_PERMISSIONS.STAFF, 'attendance:write')).toBe(true)
    expect(hasPermission(ROLE_PERMISSIONS.STAFF, 'patient:read')).toBe(false)
    expect(hasPermission(ROLE_PERMISSIONS.STAFF, 'billing:read')).toBe(false)
  })

  it('gives HOSPITAL_ADMIN full hospital administration', () => {
    expect(hasPermission(ROLE_PERMISSIONS.HOSPITAL_ADMIN, 'user:permissions:manage')).toBe(true)
    expect(hasPermission(ROLE_PERMISSIONS.HOSPITAL_ADMIN, 'audit:read')).toBe(true)
    expect(hasPermission(ROLE_PERMISSIONS.HOSPITAL_ADMIN, 'platform:hospital:approve')).toBe(false)
  })
})

describe('resolvePermissions', () => {
  it('returns the role ceiling when nothing is granted', () => {
    const resolved = resolvePermissions('STAFF', [])
    expect(resolved.size).toBe(ROLE_PERMISSIONS.STAFF.size)
  })

  it('defaults to the role ceiling when no grants are supplied', () => {
    expect(resolvePermissions('DOCTOR').size).toBe(ROLE_PERMISSIONS.DOCTOR.size)
  })

  it('narrows the ceiling when a subset is granted', () => {
    const resolved = resolvePermissions('HOSPITAL_ADMIN', ['patient:read', 'patient:write'])
    expect(hasPermission(resolved, 'patient:read')).toBe(true)
    expect(hasPermission(resolved, 'billing:write')).toBe(false)
    expect(resolved.size).toBe(2)
  })

  it('refuses to escalate above the role ceiling', () => {
    const resolved = resolvePermissions('STAFF', ['billing:write', 'patient:read'])
    expect(hasPermission(resolved, 'billing:write')).toBe(false)
    expect(hasPermission(resolved, 'patient:read')).toBe(false)
  })

  it('refuses to grant platform permissions to a hospital role', () => {
    const resolved = resolvePermissions('HOSPITAL_ADMIN', ['platform:hospital:approve'])
    expect(hasPermission(resolved, 'platform:hospital:approve')).toBe(false)
  })

  it('ignores unknown permission strings instead of throwing', () => {
    const resolved = resolvePermissions('STAFF', ['attendance:read', 'totally:made:up'])
    expect(hasPermission(resolved, 'attendance:read')).toBe(true)
    expect(resolved.size).toBe(1)
  })
})

describe('permission predicates', () => {
  it('hasPermission returns false when the set is undefined (fail closed)', () => {
    expect(hasPermission(undefined, 'patient:read')).toBe(false)
  })

  it('hasAllPermissions requires every listed permission', () => {
    const set = ROLE_PERMISSIONS.DOCTOR
    expect(hasAllPermissions(set, ['patient:read', 'consultation:write'])).toBe(true)
    expect(hasAllPermissions(set, ['patient:read', 'billing:write'])).toBe(false)
  })

  it('hasAllPermissions fails closed on an undefined set', () => {
    expect(hasAllPermissions(undefined, ['patient:read'])).toBe(false)
  })
})
