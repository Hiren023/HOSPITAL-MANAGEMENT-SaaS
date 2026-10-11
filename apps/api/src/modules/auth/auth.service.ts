import { ROLE_PERMISSIONS, SESSION, type Role } from '@infinigrow/shared'
import { Types, type Model } from 'mongoose'

import { ApiError } from '../../infrastructure/api-error.js'
import {
  issueAccessToken,
  keysFromEnv,
  type AccessTokenClaims,
} from '../identity/access-token.util.js'
import { hashPassword, performDecoyVerify, verifyPassword } from '../identity/password.util.js'
import {
  generateOpaqueToken,
  hashToken,
  newFamilyId,
  tokenHashMatches,
} from '../identity/token.util.js'
import {
  MembershipModel,
  PasswordResetModel,
  RefreshSessionModel,
  UserModel,
} from '../identity/models.js'
import { AUDIT_ACTIONS } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'
import { hashToken as hashOtp } from '../identity/token.util.js'
import { findManyViaAggregate } from '../../utilities/mongo-compat.js'
import { OtpChallengeModel } from './otp.model.js'
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  generateOtp,
  verifyOtp,
} from './otp.util.js'
import { OtpDeliveryNotConfiguredError, resolveOtpDelivery } from './otp-delivery.js'

/**
 * Authentication service.
 *
 * Session model (documented in docs/AUTH.md):
 *   - **Access token**: short-lived (10 min) EdDSA JWT, held in memory by the client,
 *     sent as `Authorization: Bearer`. Not a cookie, so it is never attached to
 *     cross-site requests automatically.
 *   - **Refresh token**: opaque 256-bit value in an `HttpOnly; Secure; SameSite=Strict`
 *     cookie, stored hashed. Rotated on every use; replaying a consumed token revokes
 *     the whole family.
 *
 * Both properties that matter for tenant safety: no token is ever trusted for scope
 * without a membership re-check, and no token ever carries PHI.
 */

export interface RequestMeta {
  ip: string
  userAgent: string
  requestId: string
}

export interface SessionTokens {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
}

export interface CurrentUser {
  userId: string
  email: string
  firstName: string
  lastName: string
  role: Role
  hospitalId: string | null
  hospitalName: string | null
  membershipId: string | null
  permissions: string[]
  emailVerified: boolean
}

const userModel = () => UserModel as Model<Record<string, unknown>>
const membershipModel = () => MembershipModel as Model<Record<string, unknown>>
const refreshSessionModel = () => RefreshSessionModel as Model<Record<string, unknown>>
const passwordResetModel = () => PasswordResetModel as Model<Record<string, unknown>>
void passwordResetModel
const otpModel = () => OtpChallengeModel as Model<Record<string, unknown>>

/**
 * Record a failed sign-in and lock the account once the threshold is crossed.
 *
 * The counter lives on the user document, so the lockout survives a restart and is not
 * defeated by rotating IPs.
 */
async function registerFailedLogin(
  userId: string,
  email: string,
  meta: RequestMeta,
): Promise<void> {
  const user = await userModel().findById(userId).select('failedLoginCount').exec()
  if (!user) return

  const nextCount = (Number(user['failedLoginCount'] ?? 0) + 1) as number
  const update: Record<string, unknown> = { failedLoginCount: nextCount }

  if (nextCount >= 5) {
    update['lockedUntil'] = new Date(Date.now() + 15 * 60 * 1000)
    update['failedLoginCount'] = 0

    await recordAudit({
      action: AUDIT_ACTIONS.ACCOUNT_LOCKED,
      actorUserId: userId,
      resourceType: 'User',
      resourceId: userId,
      outcome: 'FAILURE',
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      metadata: { email },
    })
  }

  await userModel().updateOne({ _id: userId }, { $set: update }).exec()
}

async function issueSession(input: {
  userId: string
  role: Role
  hospitalId: string | null
  membershipId: string | null
  meta: RequestMeta
  familyId?: string
}): Promise<SessionTokens> {
  const secrets = keysFromEnv(process.env)
  const refreshToken = generateOpaqueToken()
  const familyId = input.familyId ?? newFamilyId()

  const claims: AccessTokenClaims = {
    userId: input.userId,
    role: input.role,
    hospitalId: input.hospitalId,
    membershipId: input.membershipId,
    sessionId: newFamilyId(),
  }

  const accessToken = await issueAccessToken(claims, secrets)

  await refreshSessionModel().create({
    userId: input.userId,
    tokenHash: hashToken(refreshToken),
    familyId,
    hospitalId: input.hospitalId,
    expiresAt: new Date(Date.now() + SESSION.REFRESH_TOKEN_TTL_SECONDS * 1000),
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
  })

  return { accessToken, refreshToken, expiresInSeconds: SESSION.ACCESS_TOKEN_TTL_SECONDS }
}

/**
 * Authenticate an email + password, optionally selecting a hospital.
 *
 * With no `hospitalId`, a user holding several memberships is refused and told to
 * choose — silently picking one would be a surprising privilege decision.
 */
/**
 * The identity models are imported lazily throughout this module, because
 * `identity/models.js` and the auth service are mutually dependent. This keeps that
 * lazy import in one named place rather than repeating `await import(...)`.
 */
async function hospitalModelAsync(): Promise<Model<Record<string, unknown>>> {
  const module = await import('../identity/models.js')
  return module.HospitalModel as Model<Record<string, unknown>>
}

export async function login(input: {
  email: string
  password: string
  hospitalId?: string
  meta: RequestMeta
}): Promise<{ tokens: SessionTokens; user: CurrentUser }> {
  const email = input.email.trim().toLowerCase()

  const user = await userModel()
    .findOne({ email })
    .select(
      'email passwordHash status lockedUntil firstName lastName emailVerified failedLoginCount platformRole',
    )
    .exec()

  if (!user) {
    // Burn comparable CPU time so response timing cannot enumerate accounts
    // (docs/SECURITY.md R11).
    await performDecoyVerify(input.password)

    await recordAudit({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      outcome: 'FAILURE',
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
      requestId: input.meta.requestId,
      metadata: { email, reason: 'NO_SUCH_USER' },
    })

    throw ApiError.unauthenticated('Invalid email or password')
  }

  const userId = String(user['_id'])
  const status = user['status'] as string | undefined

  if (status && status !== 'ACTIVE') {
    await recordAudit({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      actorUserId: userId,
      outcome: 'FAILURE',
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: { email, reason: 'ACCOUNT_NOT_ACTIVE' },
    })
    throw ApiError.forbidden('This account is not active')
  }

  const lockedUntil = user['lockedUntil'] as Date | undefined
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    throw new ApiError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.')
  }

  const passwordHash = String(user['passwordHash'] ?? '')
  const passwordOk = await verifyPassword(input.password, passwordHash)

  if (!passwordOk) {
    await registerFailedLogin(userId, email, input.meta)

    await recordAudit({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      actorUserId: userId,
      outcome: 'FAILURE',
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: { email, reason: 'BAD_PASSWORD' },
    })

    // Identical message for every failure: no account enumeration.
    throw ApiError.unauthenticated('Invalid email or password')
  }

  await userModel()
    .updateOne({ _id: userId }, { $set: { failedLoginCount: 0, lastLoginAt: new Date() } })
    .exec()

  const memberships = await membershipModel().find({ userId, status: 'ACTIVE' }).lean().exec()

  // A platform administrator holds `platform:*` permissions and has NO hospital
  // membership by design. Resolving them through a membership would make platform
  // sign-in impossible, so they get a token with no hospital scope — which the
  // `requirePlatformPermission` guard then requires to be a SUPER_ADMIN.
  if (user['platformRole'] === 'SUPER_ADMIN' && memberships.length === 0) {
    const platformTokens = await issueSession({
      userId,
      role: 'SUPER_ADMIN',
      hospitalId: null,
      membershipId: null,
      meta: input.meta,
    })

    await recordAudit({
      action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      actorUserId: userId,
      actorRole: 'SUPER_ADMIN',
      hospitalId: null,
      resourceType: 'User',
      resourceId: userId,
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
      requestId: input.meta.requestId,
      metadata: { email, scope: 'platform' },
    })

    return {
      tokens: platformTokens,
      user: {
        userId,
        email: String(user['email']),
        firstName: String(user['firstName']),
        lastName: String(user['lastName']),
        role: 'SUPER_ADMIN',
        hospitalId: null,
        hospitalName: null,
        membershipId: null,
        permissions: [...ROLE_PERMISSIONS.SUPER_ADMIN],
        emailVerified: Boolean(user['emailVerified']),
      },
    }
  }

  if (memberships.length === 0) {
    throw ApiError.forbidden('This account is not a member of any hospital')
  }

  /**
   * A suspended tenant's staff must not be able to sign in.
   *
   * Suspension is the platform's most drastic lever: it is supposed to cut a hospital
   * off entirely. Checking only membership status left that lever decorative — the
   * membership stayed ACTIVE, so every user of a suspended hospital kept signing in
   * normally while the platform console insisted access had been revoked.
   *
   * The lookup is deliberately a plain equality filter per distinct hospital id, so the
   * tenant-scoped plugin leaves it alone; it is not wrapped in platform scope, which
   * would return nothing at all.
   */
  const hospitalIds = [
    ...new Set(memberships.map((m) => new Types.ObjectId(String(m['hospitalId'])))),
  ]
  const hospitalStatuses = await findManyViaAggregate<Record<string, unknown>>(
    await hospitalModelAsync(),
    // Real ObjectIds, not strings: `aggregate` performs no casting, so a string here
    // matches nothing at all rather than raising an error.
    { _id: { $in: hospitalIds } },
    100,
    { _id: 1, status: 1 } as unknown as Record<string, 0 | 1>,
  )

  const statusById = new Map<string, string>(
    hospitalStatuses.map((row) => [String(row['_id']), String(row['status'])]),
  )

  const suspendedMembership = memberships.find((m) =>
    ['SUSPENDED', 'REJECTED'].includes(statusById.get(String(m['hospitalId'])) ?? ''),
  )

  if (suspendedMembership !== undefined) {
    const hospitalId = String(suspendedMembership['hospitalId'])
    await recordAudit({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      actorUserId: userId,
      actorRole: String(suspendedMembership['role'] ?? ''),
      hospitalId,
      resourceType: 'Hospital',
      resourceId: hospitalId,
      outcome: 'DENIED',
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
      requestId: input.meta.requestId,
      metadata: {
        reason: 'tenant_not_active',
        hospitalStatus: statusById.get(hospitalId) ?? 'UNKNOWN',
      },
    })

    throw ApiError.forbidden(
      'This hospital is not currently active. Contact your hospital administrator.',
    )
  }

  const chosen = input.hospitalId
    ? memberships.find((m) => String(m['hospitalId']) === input.hospitalId)
    : memberships.length === 1
      ? memberships[0]
      : undefined

  if (memberships.length > 1 && !chosen) {
    throw ApiError.badRequest(
      'This account belongs to multiple hospitals. Choose one and try again.',
    )
  }

  if (!chosen) {
    throw ApiError.forbidden('You do not have access to the requested hospital')
  }

  const membership = chosen as Record<string, unknown>
  const role = membership['role'] as Role
  const hospitalId = String(membership['hospitalId'])
  const membershipId = String(membership['_id'])

  const { resolvePermissions } = await import('@infinigrow/shared')
  const permissions = [
    ...resolvePermissions(role, (membership['grantedPermissions'] as string[]) ?? []),
  ]

  const hospital = await (
    (
      await import('../identity/models.js')
    ).HospitalModel as Model<Record<string, unknown>>
  )
    .findById(hospitalId)
    .select('name')
    .lean()
    .exec()

  const tokens = await issueSession({
    userId,
    role,
    hospitalId,
    membershipId,
    meta: input.meta,
  })

  await recordAudit({
    action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
    actorUserId: userId,
    actorRole: role,
    hospitalId,
    resourceType: 'Membership',
    resourceId: membershipId,
    ip: input.meta.ip,
    userAgent: input.meta.userAgent,
    requestId: input.meta.requestId,
    metadata: { email },
  })

  return {
    tokens,
    user: {
      userId,
      email: String(user['email']),
      firstName: String(user['firstName']),
      lastName: String(user['lastName']),
      role,
      hospitalId,
      hospitalName: hospital ? String(hospital['name']) : null,
      membershipId,
      permissions,
      emailVerified: Boolean(user['emailVerified']),
    },
  }
}

/**
 * Rotate a refresh token.
 *
 * Reuse of an already-consumed token is treated as theft: the entire family is
 * revoked, which logs the attacker out and forces a legitimate re-authentication.
 */
export async function refreshSession(input: {
  refreshToken: string
  meta: RequestMeta
}): Promise<{ tokens: SessionTokens; user: CurrentUser }> {
  const tokenHash = hashToken(input.refreshToken)

  const session = await refreshSessionModel().findOne({ tokenHash }).lean().exec()

  if (!session) {
    throw ApiError.unauthenticated('Invalid or expired session')
  }

  const revokedAt = session['revokedAt'] as Date | undefined
  const expiresAt = session['expiresAt'] as Date

  if (revokedAt) {
    // Replay of a consumed token: assume compromise of this token lineage.
    await refreshSessionModel()
      .updateMany({ familyId: session['familyId'] }, { $set: { revokedAt: new Date() } })
      .exec()

    await recordAudit({
      action: AUDIT_ACTIONS.TOKEN_REUSE_DETECTED,
      actorUserId: String(session['userId']),
      resourceType: 'RefreshSession',
      resourceId: String(session['_id']),
      outcome: 'DENIED',
      ip: input.meta.ip,
      requestId: input.meta.requestId,
    })

    throw ApiError.unauthenticated('Session has been revoked. Please sign in again.')
  }

  if (expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthenticated('Session expired. Please sign in again.')
  }

  const userId = String(session['userId'])

  const membership = await membershipModel()
    .findOne({ userId, hospitalId: session['hospitalId'], status: 'ACTIVE' })
    .lean()
    .exec()

  if (!membership) {
    // Access revoked since the token was issued.
    await revokeFamily(String(session['familyId']))
    throw ApiError.unauthenticated('Session is no longer valid')
  }

  const role = membership['role'] as Role

  const newTokens = await issueSession({
    userId,
    role,
    hospitalId: String(membership['hospitalId']),
    membershipId: String(membership['_id']),
    meta: input.meta,
    familyId: String(session['familyId']),
  })

  // Mark the old token consumed and link it to its replacement, so a replay is
  // detectable.
  await refreshSessionModel()
    .updateOne(
      { _id: session['_id'] },
      { $set: { revokedAt: new Date(), replacedByTokenHash: hashToken(newTokens.refreshToken) } },
    )
    .exec()

  const { resolvePermissions } = await import('@infinigrow/shared')

  await recordAudit({
    action: AUDIT_ACTIONS.TOKEN_REFRESHED,
    actorUserId: userId,
    actorRole: role,
    hospitalId: String(membership['hospitalId']),
    resourceType: 'RefreshSession',
    resourceId: String(session['_id']),
    ip: input.meta.ip,
    requestId: input.meta.requestId,
  })

  return {
    tokens: newTokens,
    user: {
      userId,
      email: '',
      firstName: '',
      lastName: '',
      role,
      hospitalId: String(membership['hospitalId']),
      hospitalName: null,
      membershipId: String(membership['_id']),
      permissions: [
        ...resolvePermissions(role, (membership['grantedPermissions'] as string[]) ?? []),
      ],
      emailVerified: true,
    },
  }
}

async function revokeFamily(familyId: string): Promise<void> {
  await refreshSessionModel()
    .updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } })
    .exec()
}

/** Revoke the session behind a refresh token. Idempotent. */
export async function logout(input: { refreshToken?: string; meta: RequestMeta }): Promise<void> {
  if (!input.refreshToken) return

  const session = await refreshSessionModel()
    .findOne({ tokenHash: hashToken(input.refreshToken) })
    .exec()

  if (!session) return

  await revokeFamily(String(session['familyId']))

  await recordAudit({
    action: AUDIT_ACTIONS.LOGOUT,
    actorUserId: String(session['userId']),
    hospitalId: session['hospitalId'] ? String(session['hospitalId']) : null,
    resourceType: 'RefreshSession',
    resourceId: String(session['_id']),
    ip: input.meta.ip,
    requestId: input.meta.requestId,
  })
}

/**
 * Begin a password reset.
 *
 * The response is identical whether or not the address exists, so this endpoint cannot
 * be used to enumerate registered users.
 */
export async function requestPasswordReset(input: {
  email: string
  meta: RequestMeta
}): Promise<{ deliveryFailed: boolean }> {
  const email = input.email.trim().toLowerCase()
  const delivery = resolveOtpDelivery(process.env)

  const user = await userModel().findOne({ email }).select('_id').lean().exec()

  if (!user) {
    await recordAudit({
      action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
      outcome: 'SUCCESS',
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: { email, userFound: false },
    })
    // No delivery attempted, and no hint to the caller.
    return { deliveryFailed: delivery === null }
  }

  if (!delivery) {
    // Fail loudly to the operator, but never fall back to logging the code.
    await recordAudit({
      action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
      outcome: 'FAILURE',
      actorUserId: String(user['_id']),
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: { reason: 'NO_DELIVERY_PROVIDER' },
    })

    return { deliveryFailed: true }
  }

  const userId = String(user['_id'])

  // Supersede any outstanding challenge for this purpose.
  await otpModel()
    .updateMany(
      { userId, purpose: 'PASSWORD_RESET', consumedAt: null },
      { $set: { consumedAt: new Date() } },
    )
    .exec()

  const code = generateOtp()

  await otpModel().create({
    userId,
    email,
    purpose: 'PASSWORD_RESET',
    otpHash: hashOtp(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    attempts: 0,
    ip: input.meta.ip,
    requestId: input.meta.requestId,
  })

  await delivery.sendOtp({
    to: email,
    code,
    purpose: 'PASSWORD_RESET',
    expiresInMinutes: Math.round(OTP_TTL_MS / 60_000),
  })

  await recordAudit({
    action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
    actorUserId: userId,
    resourceType: 'User',
    resourceId: userId,
    ip: input.meta.ip,
    requestId: input.meta.requestId,
    metadata: { email },
  })

  return { deliveryFailed: false }
}

/** Complete a password reset with a valid code. */
export async function resetPassword(input: {
  email: string
  code: string
  newPassword: string
  meta: RequestMeta
}): Promise<void> {
  const email = input.email.trim().toLowerCase()

  const challenge = await otpModel()
    .findOne({ email, purpose: 'PASSWORD_RESET', consumedAt: null })
    .select('+otpHash')
    .sort({ createdAt: -1 })
    .exec()

  if (!challenge) {
    throw ApiError.badRequest('Invalid or expired code')
  }

  const result = verifyOtp(
    {
      otpHash: String(challenge['otpHash']),
      expiresAt: challenge['expiresAt'] as Date,
      attempts: Number(challenge['attempts'] ?? 0),
    },
    input.code,
    tokenHashMatches,
  )

  if (!result.verified) {
    await otpModel()
      .updateOne({ _id: challenge['_id'] }, { $set: { attempts: challenge['attempts'] } })
      .exec()

    await recordAudit({
      action: AUDIT_ACTIONS.OTP_FAILED,
      actorUserId: String(challenge['userId']),
      outcome: 'FAILURE',
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: { purpose: 'PASSWORD_RESET', reason: result.reason },
    })

    throw ApiError.badRequest('Invalid or expired code')
  }

  const userId = String(challenge['userId'])

  await userModel()
    .updateOne(
      { _id: userId },
      {
        $set: {
          passwordHash: await hashPassword(input.newPassword),
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
        },
      },
    )
    .exec()

  await otpModel()
    .updateOne({ _id: challenge['_id'] }, { $set: { consumedAt: new Date() } })
    .exec()

  // A password change invalidates every existing session.
  await refreshSessionModel()
    .updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } })
    .exec()

  await recordAudit({
    action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
    actorUserId: userId,
    resourceType: 'User',
    resourceId: userId,
    ip: input.meta.ip,
    requestId: input.meta.requestId,
  })
}

/** Build the current-user projection from a verified context. */
export async function getCurrentUser(context: {
  userId: string
  role: Role
  hospitalId: string | null
  membershipId: string | null
  permissions: readonly string[]
}): Promise<CurrentUser> {
  const user = await userModel()
    .findById(context.userId)
    .select('email firstName lastName emailVerified')
    .lean()
    .exec()

  if (!user) throw ApiError.unauthenticated('Invalid or expired access token')

  let hospitalName: string | null = null
  if (context.hospitalId) {
    const hospital = await (
      (
        await import('../identity/models.js')
      ).HospitalModel as Model<Record<string, unknown>>
    )
      .findById(context.hospitalId)
      .select('name')
      .lean()
      .exec()
    hospitalName = hospital ? String(hospital['name']) : null
  }

  return {
    userId: context.userId,
    email: String(user['email']),
    firstName: String(user['firstName']),
    lastName: String(user['lastName']),
    role: context.role,
    hospitalId: context.hospitalId,
    hospitalName,
    membershipId: context.membershipId,
    permissions: [...context.permissions],
    emailVerified: Boolean(user['emailVerified']),
  }
}

export const OTP_LIMITS = {
  maxAttempts: OTP_MAX_ATTEMPTS,
  ttlMs: OTP_TTL_MS,
  resendCooldownMs: OTP_RESEND_COOLDOWN_MS,
}

export { OtpDeliveryNotConfiguredError }
