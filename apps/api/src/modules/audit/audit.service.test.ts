import { describe, expect, it } from 'vitest'

import { redactAuditMetadata } from './audit.service.js'

/**
 * Audit redaction tests.
 *
 * The audit collection is append-only and broadly readable. Anything written there
 * effectively becomes permanent, so the redaction guarantee matters more here than
 * almost anywhere else in the system (docs/SECURITY.md R8, R15).
 */

describe('redactAuditMetadata', () => {
  it('removes a password at the top level', () => {
    expect(redactAuditMetadata({ password: 'hunter2-correct-horse' })).toEqual({
      password: '[REDACTED]',
    })
  })

  it('removes every credential-ish key, case-insensitively', () => {
    const redacted = redactAuditMetadata({
      password: 'a',
      newPassword: 'b',
      refreshToken: 'c',
      accessToken: 'd',
      otp: '123456',
      mfaSecret: 'f',
      apiKey: 'g',
      secret: 'h',
      Authorization: 'Bearer x',
      Cookie: 'session=y',
    }) as Record<string, string>

    for (const [key, value] of Object.entries(redacted)) {
      expect(value, `${key} was not redacted`).toBe('[REDACTED]')
    }
  })

  it('removes patient identifiers and clinical content', () => {
    const redacted = redactAuditMetadata({
      dateOfBirth: '1975-04-02',
      aadhaar: '1234 5678 9012',
      diagnosis: 'a fictional condition',
      chiefComplaint: 'a fictional complaint',
      phone: '+91 98765 43210',
    }) as Record<string, string>

    for (const value of Object.values(redacted)) {
      expect(value).toBe('[REDACTED]')
    }
  })

  it('removes a secret nested inside an object', () => {
    // A nested `{ otp }` must not survive merely because it is one level down.
    const redacted = redactAuditMetadata({
      request: { password: 'leaked', email: 'user@example.test' },
    }) as { request: Record<string, string> }

    expect(redacted.request['password']).toBe('[REDACTED]')
    // A non-sensitive field is preserved for debugging.
    expect(redacted.request['email']).toBe('user@example.test')
  })

  it('removes a secret nested inside an array', () => {
    const redacted = redactAuditMetadata({
      attempts: [{ password: 'leaked' }, { password: 'also-leaked' }],
    }) as { attempts: { password: string }[] }

    for (const attempt of redacted.attempts) {
      expect(attempt.password).toBe('[REDACTED]')
    }
  })

  it('bounds recursion depth on a deeply nested structure', () => {
    // A pathological structure must not hang the audit write — failing to audit is
    // worse than losing some detail.
    let deep: Record<string, unknown> = { password: 'bottom' }
    for (let i = 0; i < 40; i += 1) {
      deep = { nested: deep }
    }

    const serialised = JSON.stringify(redactAuditMetadata(deep))
    expect(serialised).not.toContain('bottom')
    expect(serialised).toContain('TRUNCATED')
  })

  it('survives a cyclic structure without throwing', () => {
    const cyclic: Record<string, unknown> = { password: 'leaked' }
    cyclic['self'] = cyclic

    expect(() => redactAuditMetadata(cyclic)).not.toThrow()
    // The depth guard terminates it, and the secret is still removed.
    expect(JSON.stringify(redactAuditMetadata(cyclic))).not.toContain('leaked')
  })

  it('leaves benign metadata untouched', () => {
    const input = {
      hospitalName: 'Aarav Memorial Hospital',
      fieldsProvided: ['hospitalName', 'contactEmail'],
      rowsReturned: 12,
      reason: 'BAD_PASSWORD',
    }

    expect(redactAuditMetadata(input)).toEqual(input)
  })

  it('preserves non-string values such as numbers and booleans', () => {
    expect(redactAuditMetadata({ attempts: 5, success: false })).toEqual({
      attempts: 5,
      success: false,
    })
  })

  it('handles an empty object and null', () => {
    expect(redactAuditMetadata({})).toEqual({})
    expect(redactAuditMetadata(null)).toBeNull()
    expect(redactAuditMetadata(undefined)).toBeUndefined()
  })
})