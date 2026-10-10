import { randomInt } from 'node:crypto'

/**
 * One-time-password generation and verification.
 *
 * Security properties:
 *  - **6 digits from a CSPRNG.** `Math.random()` is not cryptographically secure and
 *    would let an attacker predict a victim's OTP.
 *  - **Short expiry.** An OTP is only useful for a few minutes; a long-lived one turns
 *    a shoulder-surfed code into a lasting credential.
 *  - **Attempt-limited.** Brute-forcing a 6-digit code is trivial otherwise — 10^6
 *    possibilities, and 10 guesses/second is 28 hours.
 *  - **Stored hashed.** A leaked database must not hand over live OTPs.
 *  - **Never logged.** Delivery goes through an adapter that cannot write to the log.
 */

export const OTP_LENGTH = 6
export const OTP_MAX_ATTEMPTS = 5
export const OTP_TTL_MS = 10 * 60 * 1000 // 10 minutes
/** Minimum gap between OTP requests for the same destination. */
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000

/** Cryptographically secure numeric OTP. */
export function generateOtp(): string {
  // randomInt is unbiased; building the string from Math.random would not be.
  return String(randomInt(0, 1_000_000)).padStart(OTP_LENGTH, '0')
}

/** Normalise a user-entered code so " 123 456 " still verifies. */
export function normaliseOtp(input: string): string {
  return input.replace(/\D/g, '')
}

/**
 * Mask for display. Only ever the last two digits.
 *
 * Even a UI that does not need the code should not be handed a full secret.
 */
export function maskOtp(otp: string): string {
  return `${'*'.repeat(Math.max(0, otp.length - 2))}${otp.slice(-2)}`
}

export interface OtpVerificationResult {
  verified: boolean
  reason?: 'EXPIRED' | 'MAX_ATTEMPTS' | 'MISMATCH' | 'NOT_FOUND'
}

/**
 * Verify a submitted code against a stored record.
 *
 * The record is mutated in place: `attempts` increments on every failure so a caller
 * persists it and the counter survives a process restart.
 */
export function verifyOtp(
  record: { otpHash: string; expiresAt: Date; attempts: number; consumedAt?: Date | null },
  submitted: string,
  compare: (candidate: string, storedHash: string) => boolean,
): OtpVerificationResult {
  if (record.consumedAt) return { verified: false, reason: 'NOT_FOUND' }
  if (record.attempts >= OTP_MAX_ATTEMPTS) return { verified: false, reason: 'MAX_ATTEMPTS' }
  if (record.expiresAt.getTime() <= Date.now()) return { verified: false, reason: 'EXPIRED' }

  const candidate = normaliseOtp(submitted)
  if (!compare(candidate, record.otpHash)) {
    record.attempts += 1
    return { verified: false, reason: 'MISMATCH' }
  }

  record.consumedAt = new Date()
  return { verified: true }
}
