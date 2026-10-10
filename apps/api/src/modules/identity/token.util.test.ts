import { describe, expect, it } from 'vitest'

import {
  generateMfaSecret,
  generateOpaqueToken,
  generateRecoveryCodes,
  hashToken,
  newFamilyId,
  newRequestId,
  tokenHashMatches,
} from './token.util.js'

describe('generateOpaqueToken', () => {
  it('produces a high-entropy URL-safe token', () => {
    const token = generateOpaqueToken()

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    // 32 bytes of entropy, base64url encoded.
    expect(token.length).toBeGreaterThanOrEqual(43)
  })

  it('produces a different token every time', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateOpaqueToken()))

    expect(tokens.size).toBe(100)
  })
})

describe('hashToken', () => {
  it('is deterministic, so a stored token can be looked up', () => {
    const token = generateOpaqueToken()

    expect(hashToken(token)).toBe(hashToken(token))
  })

  it('produces a 64-character hex digest', () => {
    expect(hashToken('any-token')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never reveals the original token', () => {
    const token = generateOpaqueToken()

    expect(hashToken(token)).not.toBe(token)
    expect(token).not.toContain(hashToken(token))
  })

  it('produces different hashes for different tokens', () => {
    expect(hashToken(generateOpaqueToken())).not.toBe(hashToken(generateOpaqueToken()))
  })
})

describe('tokenHashMatches', () => {
  it('matches a token against its own hash', () => {
    const token = generateOpaqueToken()
    expect(tokenHashMatches(token, hashToken(token))).toBe(true)
  })

  it('rejects a different token', () => {
    expect(tokenHashMatches(generateOpaqueToken(), hashToken(generateOpaqueToken()))).toBe(false)
  })

  it('rejects an empty stored hash', () => {
    expect(tokenHashMatches('token', '')).toBe(false)
  })
})

describe('identifiers', () => {
  it('generates distinct family ids', () => {
    expect(new Set(Array.from({ length: 50 }, () => newFamilyId())).size).toBe(50)
  })

  it('generates a hex request id', () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('MFA material', () => {
  it('generates a base32 secret suitable for an authenticator app', () => {
    const secret = generateMfaSecret()

    expect(secret.length).toBeGreaterThanOrEqual(20)
    expect(secret).toMatch(/^[A-Za-z2-7]+$/)
  })

  it('generates eight unique recovery codes by default', () => {
    const codes = generateRecoveryCodes()

    expect(codes).toHaveLength(8)
    expect(new Set(codes).size).toBe(8)
    expect(codes.every((code) => /^[0-9A-F]{10}$/.test(code))).toBe(true)
  })

  it('honours a custom recovery-code count', () => {
    expect(generateRecoveryCodes(4)).toHaveLength(4)
  })
})
