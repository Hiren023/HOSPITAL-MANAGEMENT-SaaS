import type { Role } from '@infinigrow/shared'

import { AuditLogModel, type AuditAction } from './audit.model.js'

/**
 * Audit event recording.
 *
 * The single choke point for every security-relevant action. Two rules are enforced
 * here rather than trusted to callers:
 *
 *  1. **Never record secrets.** Passwords, tokens, OTPs and MFA secrets are stripped
 *     from `metadata` by key name, even if a caller passes them by mistake.
 *  2. **Never record values that are not needed to reconstruct the event.** The
 *     metadata is intended to hold field NAMES, ids and outcomes — not payloads.
 *     Recording a request body here would put PHI into an append-only store that is
 *     broadly readable (docs/SECURITY.md R8).
 */

/** Keys stripped from audit metadata, matched case-insensitively. */
const FORBIDDEN_METADATA_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'oldpassword',
  'confirmpassword',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'resettoken',
  'otp',
  'otpcode',
  'mfasecret',
  'recoverycodes',
  'secret',
  'apikey',
  'authorization',
  'cookie',
  'diagnosis',
  'chiefcomplaint',
  'prescription',
  'medication',
  'examination',
  'advice',
  'vitals',

  // Identifiers. These must match the fields the application logger redacts —
  // a gap between the two lists is how PHI ends up in a log that looks protected.
  'dateofbirth',
  'dob',
  'aadhaar',
  'aadhar',
  'pan',
  'phone',
  'phonenumber',
  'address',
  'emergencycontact',
  'uhid',
])

/**
 * Remove forbidden keys at every depth of the metadata tree.
 *
 * Recursive because metadata is assembled ad hoc and a nested `{ otp }` must not
 * survive just because it sits one level down.
 */
export function redactAuditMetadata(value: unknown, depth = 0): unknown {
  // Bound the recursion: a deeply nested or cyclic structure must not hang the audit
  // write, because failing to audit is worse than losing a little detail.
  if (depth > 6) return '[TRUNCATED]'

  if (Array.isArray(value)) {
    return value.map((item) => redactAuditMetadata(item, depth + 1))
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  const result: Record<string, unknown> = {}

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]'
      continue
    }
    result[key] = redactAuditMetadata(nested, depth + 1)
  }

  return result
}

export interface AuditInput {
  action: AuditAction
  actorUserId?: string | null
  actorRole?: Role | string | null
  isSystemActor?: boolean
  hospitalId?: string | null
  resourceType?: string
  resourceId?: string
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED'
  ip?: string
  userAgent?: string
  requestId?: string
  metadata?: Record<string, unknown>
}

/**
 * Write one audit entry.
 *
 * Never throws: an audit failure must not turn a successful request into a 500, but
 * it must be loud in the application log so the gap is noticed.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await AuditLogModel.create({
      hospitalId: input.hospitalId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      isSystemActor: input.isSystemActor ?? false,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      outcome: input.outcome ?? 'SUCCESS',
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      metadata: redactAuditMetadata(input.metadata ?? {}),
    })
  } catch (error) {
    // Imported lazily to avoid a module cycle (logger -> env -> ...).
    const { logger } = await import('../../infrastructure/logger.js')
    logger.error(
      { err: error, action: input.action, requestId: input.requestId },
      'Failed to write audit entry',
    )
  }
}
