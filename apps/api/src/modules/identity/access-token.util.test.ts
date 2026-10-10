import { generateKeyPairSync } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  issueAccessToken,
  keysFromEnv,
  verifyAccessToken,
  type TokenIssuerSecrets,
} from './access-token.util.js'

/**
 * Access-token tests.
 *
 * The property that matters: a token must be unforgeable and tamper-evident, and a
 * token minted for a different audience or issuer must be rejected.
 */

/**
 * A real Ed25519 key pair, generated per run.
 *
 * Hard-coded PEM strings would risk a test key ever being used in production, and
 * `jose` refuses to sign with anything other than an imported CryptoKey.
 */
let keys: TokenIssuerSecrets

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })

  keys = {
    privateKeyPem: privateKey as unknown as string,
    publicKeyPem: publicKey as unknown as string,
    issuer: 'https://api.test.invalid',
    audience: 'infinigrow-test',
  }
})

const baseClaims = {
  userId: '507f1f77bcf86cd799439011',
  role: 'HOSPITAL_ADMIN' as const,
  hospitalId: '507f191e810c19729de860ea',
  membershipId: '507f1f77bcf86cd799439022',
  sessionId: 'session-abc-123',
}

describe('issueAccessToken / verifyAccessToken', () => {
  it('round-trips the claims', async () => {
    const token = await issueAccessToken(baseClaims, keys)
    const verified = await verifyAccessToken(token, keys)

    expect(verified.userId).toBe(baseClaims.userId)
    expect(verified.role).toBe('HOSPITAL_ADMIN')
    expect(verified.hospitalId).toBe(baseClaims.hospitalId)
    expect(verified.membershipId).toBe(baseClaims.membershipId)
    expect(verified.sessionId).toBe(baseClaims.sessionId)
  })

  it('encodes a platform token with no hospital scope', async () => {
    const token = await issueAccessToken(
      { ...baseClaims, role: 'SUPER_ADMIN', hospitalId: null, membershipId: null },
      keys,
    )
    const verified = await verifyAccessToken(token, keys)

    expect(verified.role).toBe('SUPER_ADMIN')
    expect(verified.hospitalId).toBeNull()
    expect(verified.membershipId).toBeNull()
  })

  it('produces three JWT segments', async () => {
    const token = await issueAccessToken(baseClaims, keys)
    expect(token.split('.')).toHaveLength(3)
  })

  it('rejects a token signed by a different key', async () => {
    const token = await issueAccessToken(baseClaims, keys)

    // A genuine but unrelated key pair, so this tests the real verification path.
    const { publicKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })

    await expect(
      verifyAccessToken(token, { ...keys, publicKeyPem: publicKey as unknown as string }),
    ).rejects.toThrow(/Invalid or expired/)
  })

  it('rejects a token whose payload was tampered with', async () => {
    const token = await issueAccessToken(baseClaims, keys)
    const [header, payload, signature] = token.split('.') as [string, string, string]

    // Re-encode the payload with an escalated role.
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    decoded['role'] = 'SUPER_ADMIN'
    const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')

    await expect(verifyAccessToken(`${header}.${forged}.${signature}`, keys)).rejects.toThrow(
      /Invalid or expired/,
    )
  })

  it('rejects a token minted for a different audience', async () => {
    const token = await issueAccessToken(baseClaims, { ...keys, audience: 'someone-else' })

    await expect(verifyAccessToken(token, keys)).rejects.toThrow(/Invalid or expired/)
  })

  it('rejects a token minted by a different issuer', async () => {
    const token = await issueAccessToken(baseClaims, { ...keys, issuer: 'https://evil.invalid' })

    await expect(verifyAccessToken(token, keys)).rejects.toThrow(/Invalid or expired/)
  })

  it('rejects an expired token', async () => {
    // Negative TTL produces a token whose exp is already in the past.
    const token = await issueAccessToken(baseClaims, keys, -60)

    await expect(verifyAccessToken(token, keys)).rejects.toThrow(/Invalid or expired/)
  })

  it('rejects structurally invalid tokens', async () => {
    for (const token of ['', 'not-a-token', 'a.b', 'a.b.c.d']) {
      await expect(verifyAccessToken(token, keys)).rejects.toThrow(/Invalid or expired/)
    }
  })

  it('rejects an "alg: none" downgrade attempt', async () => {
    const token = await issueAccessToken(baseClaims, keys)
    const [, payload, signature] = token.split('.') as [string, string, string]

    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString(
      'base64url',
    )

    await expect(verifyAccessToken(`${noneHeader}.${payload}.${signature}`, keys)).rejects.toThrow(
      /Invalid or expired/,
    )
  })

  it('uses the same message for every failure, so nothing is disclosed', async () => {
    const messages = await Promise.all(
      ['', 'garbage', 'a.b.c'].map(async (token) => {
        try {
          await verifyAccessToken(token, keys)
          return 'NO_ERROR'
        } catch (error) {
          return (error as Error).message
        }
      }),
    )

    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).toBe('Invalid or expired access token')
  })
})

describe('keysFromEnv', () => {
  it('builds key material from provided secrets', () => {
    const result = keysFromEnv({
      JWT_PRIVATE_KEY: keys.privateKeyPem,
      JWT_PUBLIC_KEY: keys.publicKeyPem,
      JWT_ISSUER: 'https://api.example.com',
      JWT_AUDIENCE: 'infinigrow-web',
    })

    expect(result.issuer).toBe('https://api.example.com')
    expect(result.audience).toBe('infinigrow-web')
  })

  it('defaults the issuer and audience when omitted', () => {
    const result = keysFromEnv({
      JWT_PRIVATE_KEY: keys.privateKeyPem,
      JWT_PUBLIC_KEY: keys.publicKeyPem,
    })

    expect(result.issuer).toBeTruthy()
    expect(result.audience).toBe('infinigrow-web')
  })

  it('fails loudly when signing keys are absent', () => {
    expect(() => keysFromEnv({})).toThrow(/JWT signing keys are not configured/)
    expect(() => keysFromEnv({ JWT_PRIVATE_KEY: keys.privateKeyPem })).toThrow(/not configured/)
    expect(() => keysFromEnv({ JWT_PUBLIC_KEY: keys.publicKeyPem })).toThrow(/not configured/)
  })

  it('tolerates PEM supplied with escaped newlines, as env vars often carry', async () => {
    const escaped = keysFromEnv({
      JWT_PRIVATE_KEY: keys.privateKeyPem.replace(/\n/g, '\\n'),
      JWT_PUBLIC_KEY: keys.publicKeyPem.replace(/\n/g, '\\n'),
      JWT_ISSUER: 'https://api.example.com',
      JWT_AUDIENCE: 'infinigrow-web',
    })

    const token = await issueAccessToken(baseClaims, escaped)
    await expect(verifyAccessToken(token, escaped)).resolves.toMatchObject({
      userId: baseClaims.userId,
    })
  })
})
