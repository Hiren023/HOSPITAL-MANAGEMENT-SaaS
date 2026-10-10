import type { Permission, Role } from '@infinigrow/shared'

import { apiClient } from '../lib/api-client.js'

/**
 * Session types and the authentication calls that back them.
 *
 * Every function here hits the real API. There is no mock path, no fallback identity
 * and no "pretend" session: if the server says the credentials are wrong, the user is
 * told they are wrong (docs/PROJECT_PROPOSAL.md rule 16 — no fake controls).
 */

/** The signed-in identity, as returned by `login`, `refresh` and `me`. */
export interface SessionUser {
  userId: string
  email: string
  firstName: string
  lastName: string
  role: Role
  /** `null` for a platform administrator, who has no hospital membership. */
  hospitalId: string | null
  hospitalName: string | null
  membershipId: string | null
  permissions: Permission[]
  emailVerified: boolean
}

export interface AuthResult {
  accessToken: string
  expiresInSeconds: number
  user: SessionUser
}

/**
 * A platform administrator operates across every tenant and therefore has no hospital
 * in scope. This is the single place that decides whether an app route is a platform
 * route or a hospital route, so the condition cannot drift between screens.
 */
export function isPlatformUser(user: SessionUser): boolean {
  return user.role === 'SUPER_ADMIN'
}

export async function signIn(input: { email: string; password: string }): Promise<AuthResult> {
  return apiClient.post<AuthResult>('/auth/login', input)
}

export async function restoreSession(): Promise<AuthResult> {
  return apiClient.post<AuthResult>('/auth/refresh', {})
}

export async function fetchCurrentUser(): Promise<SessionUser> {
  return apiClient.get<SessionUser>('/auth/me')
}

export async function signOut(): Promise<void> {
  await apiClient.post<{ signedOut: boolean }>('/auth/logout', {})
}

export async function registerHospital(input: {
  hospitalName: string
  registrationNumber: string
  contactEmail: string
  contactPhone?: string
  addressLine1?: string
  city?: string
  state?: string
  postalCode?: string
  admin: {
    firstName: string
    lastName: string
    email: string
    password: string
  }
}): Promise<{ hospitalId: string; status: string; message?: string }> {
  return apiClient.post('/platform/hospitals', input)
}

/**
 * True when the identity carries a permission.
 *
 * The role's permission ceiling is already applied server-side (the token contains the
 * intersection of grants and role ceiling), so this checks the granted set rather than
 * re-deriving it. Hiding a menu item is presentation only — the API re-checks every
 * request independently (docs/SECURITY.md R11).
 */
export function hasPermission(user: SessionUser, permission: Permission): boolean {
  return user.permissions.includes(permission)
}

export function hasAnyPermission(user: SessionUser, permissions: Permission[]): boolean {
  return permissions.some((permission) => hasPermission(user, permission))
}
