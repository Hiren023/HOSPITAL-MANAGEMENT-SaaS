import { describe, expect, it } from 'vitest'

import { verifyPassword, hashPassword, DEFAULT_ARGON2_OPTIONS } from './password.util.js'

/**
 * Password hashing tests.
 *
 * Real Argon2id is used rather than a mock: the properties under test (memory-hardness
 * parameters, tolerance of malformed input) only exist in the real implementation.
 */

describe('hashPassword / verifyPassword', () => {
  it('produces an argon2id digest', async () => {
    const digest = await hashPassword('correct-horse-battery-staple')

    expect(digest.startsWith('$argon2id$')).toBe(true)
  })

  it('produces a different digest each time (salted)', async () => {
    const first = await hashPassword('correct-horse-battery-staple')
    const second = await hashPassword('correct-horse-battery-staple')

    expect(first).not.toBe(second)
    // Both must still verify, proving the salt is applied rather than ignored.
    await expect(verifyPassword('correct-horse-battery-staple', first)).resolves.toBe(true)
    await expect(verifyPassword('correct-horse-battery-staple', second)).resolves.toBe(true)
  })

  it('accepts the correct password', async () => {
    const digest = await hashPassword('correct-horse-battery-staple')
    await expect(verifyPassword('correct-horse-battery-staple', digest)).resolves.toBe(true)
  })

  it('rejects an incorrect password', async () => {
    const digest = await hashPassword('correct-horse-battery-staple')
    await expect(verifyPassword('wrong-password', digest)).resolves.toBe(false)
    await expect(verifyPassword('', digest)).resolves.toBe(false)
    await expect(verifyPassword('Correct-Horse-Battery-Staple', digest)).resolves.toBe(false)
  })

  it('returns false rather than throwing for a malformed hash', async () => {
    // The underlying library throws on a corrupt digest. That throw must never reach
    // the caller: it would tell an attacker the account's stored hash is invalid.
    for (const bad of ['', 'not-a-hash', '$argon2id$broken', 'plaintext-password']) {
      await expect(verifyPassword('anything', bad)).resolves.toBe(false)
    }
  })

  it('does not embed the plaintext in the digest', async () => {
    const plaintext = 'correct-horse-battery-staple'
    const digest = await hashPassword(plaintext)

    expect(digest).not.toContain(plaintext)
  })

  it('encodes the configured cost parameters', async () => {
    const digest = await hashPassword('correct-horse-battery-staple', DEFAULT_ARGON2_OPTIONS)

    expect(digest).toContain(`m=${DEFAULT_ARGON2_OPTIONS.memoryCost}`)
    expect(digest).toContain(`t=${DEFAULT_ARGON2_OPTIONS.timeCost}`)
    expect(digest).toContain(`p=${DEFAULT_ARGON2_OPTIONS.parallelism}`)
  })

  it('uses memory-hard parameters (19 MiB)', () => {
    expect(DEFAULT_ARGON2_OPTIONS.memoryCost).toBeGreaterThanOrEqual(19_456)
    expect(DEFAULT_ARGON2_OPTIONS.parallelism).toBe(1)
  })

  it('handles a long passphrase', async () => {
    const long = 'a'.repeat(200)
    const digest = await hashPassword(long)

    await expect(verifyPassword(long, digest)).resolves.toBe(true)
  })

  it('handles unicode in a password', async () => {
    const unicode = 'correct-horse-बattery-🔋-staple'
    const digest = await hashPassword(unicode)

    await expect(verifyPassword(unicode, digest)).resolves.toBe(true)
  })
}, 30_000)