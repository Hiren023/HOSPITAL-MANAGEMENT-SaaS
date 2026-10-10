import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Opaque token generation and hashing.
 *
 * Refresh and password-reset tokens are 256-bit random values stored **hashed**.
 * A database leak therefore does not hand an attacker usable sessions.
 *
 * The hash is a plain SHA-256 rather than a password KDF: these are high-entropy
 * random values, so there is no dictionary to attack and the KDF would only add
 * latency to every request.
 */

const TOKEN_BYTES = 32

/** Generate a URL-safe random token. Returned to the client exactly once. */
export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** Deterministic hash used for storage and lookup. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Constant-time comparison of two hashes.
 *
 * `===` on hash strings leaks timing information; this does not.
 */
export function tokenHashMatches(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashToken(token), 'utf8')
  const stored = Buffer.from(storedHash, 'utf8')

  if (candidate.length !== stored.length) return false
  return timingSafeEqual(candidate, stored)
}

/** New lineage identifier for a refresh-token chain. */
export function newFamilyId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * RFC 4648 base32 alphabet, as required by RFC 6238 TOTP.
 *
 * Plain base64 contains `+`, `/` and `=`, none of which belong in a secret an
 * authenticator app will parse.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Encode raw bytes as unpadded RFC 4648 base32. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }

  return output
}

/** MFA enrolment secret, base32-encoded for authenticator apps. */
export function generateMfaSecret(): string {
  return base32Encode(randomBytes(20))
}

/** Single-use MFA recovery codes, shown once at enrolment. */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => randomBytes(5).toString('hex').toUpperCase())
}

/** New request id when the client did not supply a usable one. */
export function newRequestId(): string {
  return randomBytes(16).toString('hex')
}
