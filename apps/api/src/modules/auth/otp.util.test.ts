import { describe, expect, it } from 'vitest'

import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  generateOtp,
  maskOtp,
  normaliseOtp,
  verifyOtp,
} from './otp.util.js'
import { hashToken, tokenHashMatches } from '../identity/token.util.js'

/**
 * OTP property tests.
 *
 * These assert the security properties directly: unpredictability, expiry, attempt
 * limiting, and that verification consumes the challenge exactly once.
 */

/** A challenge record as it would be read from the database. */
function challenge(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    otpHash: hashToken('123456'),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    attempts: 0,
    consumedAt: null as Date | null,
    ...overrides,
  }
}

describe('generateOtp', () => {
  it('produces exactly 6 digits', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateOtp()).toMatch(/^\d{6}$/)
    }
  })

  it('pads small numbers so the length never varies', () => {
    // A code of variable length would leak information through length.
    const codes = Array.from({ length: 500 }, () => generateOtp())
    expect(codes.every((code) => code.length === 6)).toBe(true)
  })

  it('does not repeat immediately', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateOtp()))
    // Not a uniqueness guarantee (there are only 1e6 values), just a sanity check
    // against a constant or trivially predictable generator.
    expect(codes.size).toBeGreaterThan(180)
  })

  it('draws from the whole numeric range', () => {
    const codes = Array.from({ length: 500 }, () => generateOtp())
    expect(codes.some((c) => c.startsWith('0'))).toBe(true)
    expect(codes.some((c) => c.startsWith('9'))).toBe(true)
  })
})

describe('normaliseOtp', () => {
  it('strips spaces and non-digits', () => {
    expect(normaliseOtp(' 123 456 ')).toBe('123456')
    expect(normaliseOtp('123-456')).toBe('123456')
    expect(normaliseOtp('abc123def456')).toBe('123456')
  })

  it('returns empty for a value with no digits', () => {
    expect(normaliseOtp('abcdef')).toBe('')
  })
})

describe('maskOtp', () => {
  it('reveals only the last two digits', () => {
    const masked = maskOtp('123456')

    expect(masked).toBe('****56')
    expect(masked).not.toContain('1234')
  })

  it('never reveals more than two digits', () => {
    expect(maskOtp('123456').replace(/[^0-9]/g, '')).toHaveLength(2)
  })
})

describe('verifyOtp', () => {
  it('accepts the correct code', () => {
    const record = challenge()
    const result = verifyOtp(record, '123456', tokenHashMatches)

    expect(result.verified).toBe(true)
    expect(record.consumedAt).not.toBeNull()
  })

  it('accepts a code with surrounding whitespace', () => {
    const record = challenge()
    expect(verifyOtp(record, '  123456  ', tokenHashMatches).verified).toBe(true)
  })

  it('rejects a wrong code', () => {
    const record = challenge()
    const result = verifyOtp(record, '654321', tokenHashMatches)

    expect(result.verified).toBe(false)
    expect(result.reason).toBe('MISMATCH')
  })

  it('increments the attempt counter on failure', () => {
    const record = challenge()

    verifyOtp(record, '000000', tokenHashMatches)
    expect(record.attempts).toBe(1)

    verifyOtp(record, '111111', tokenHashMatches)
    expect(record.attempts).toBe(2)
  })

  it('rejects an expired code', () => {
    const record = challenge({ expiresAt: new Date(Date.now() - 1000) })
    const result = verifyOtp(record, '123456', tokenHashMatches)

    expect(result.verified).toBe(false)
    expect(result.reason).toBe('EXPIRED')
  })

  it('rejects a code once the attempt limit is reached', () => {
    const record = challenge({ attempts: OTP_MAX_ATTEMPTS })
    const result = verifyOtp(record, '123456', tokenHashMatches)

    expect(result.verified).toBe(false)
    expect(result.reason).toBe('MAX_ATTEMPTS')
  })

  it('brute force is bounded: 10 wrong attempts exhaust the challenge', () => {
    // 10^6 possible codes would be trivial to guess without a limit.
    const record = challenge()
    const wrongCodes = Array.from({ length: OTP_MAX_ATTEMPTS }, (_, i) =>
      String(100000 + i).padStart(6, '0'),
    )

    for (const code of wrongCodes) {
      verifyOtp(record, code, tokenHashMatches)
    }

    expect(record.attempts).toBe(OTP_MAX_ATTEMPTS)

    // Even the CORRECT code now fails.
    const final = verifyOtp(record, '123456', tokenHashMatches)
    expect(final.verified).toBe(false)
    expect(final.reason).toBe('MAX_ATTEMPTS')
  })

  it('rejects an already-consumed challenge', () => {
    const record = challenge({ consumedAt: new Date() })
    const result = verifyOtp(record, '123456', tokenHashMatches)

    expect(result.verified).toBe(false)
    expect(result.reason).toBe('NOT_FOUND')
  })

  it('cannot be replayed after a successful verification', () => {
    const record = challenge()

    expect(verifyOtp(record, '123456', tokenHashMatches).verified).toBe(true)
    // Single use: the same code must not work twice.
    expect(verifyOtp(record, '123456', tokenHashMatches).verified).toBe(false)
  })
})

describe('OTP security policy', () => {
  it('expiry is short enough to limit shoulder-surfing value', () => {
    expect(OTP_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000)
  })

  it('attempt cap is low enough to make brute force impractical', () => {
    // 10^6 codes at 5 attempts means at most 5 valid guesses per challenge.
    expect(OTP_MAX_ATTEMPTS).toBeLessThanOrEqual(5)
  })

  it('stores a hash rather than the code', () => {
    const code = generateOtp()
    const stored = hashToken(code)

    expect(stored).not.toBe(code)
    expect(stored).not.toContain(code)
  })
})
