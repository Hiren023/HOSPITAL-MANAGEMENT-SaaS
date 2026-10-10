import type { Role } from '@infinigrow/shared'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'

import { SESSION } from '@infinigrow/shared'

import { ApiError } from '../../infrastructure/api-error.js'

/**
 * Access-token issuing and verification.
 *
 * Design decisions and why:
 *
 *  - **Asymmetric EdDSA.** Only the API holds the private key, so a leaked
 *    verification key cannot be used to mint tokens. `jose` needs no native build.
 *  - **Short lifetime (10 min).** This bounds the window in which a terminated or
 *    re-roled user retains access. It is not the primary control — the membership
 *    re-check is — but it limits the damage if that check is unavailable
 *    (docs/SECURITY.md R4).
 *  - **Minimal claims.** No permission list is embedded; permissions are recomputed
 *    from the membership on each request, so a role change takes effect immediately
 *    rather than at token expiry.
 */

export interface AccessTokenClaims {
  userId: string
  role: Role
  /** Null for a platform (SUPER_ADMIN) token with no hospital scope. */
  hospitalId: string | null
  membershipId: string | null
  sessionId: string
}

export interface TokenIssuerKeys {
  privateKey: Uint8Array
  publicKey: Uint8Array
  issuer: string
  audience: string
}

const ALGORITHM = 'EdDSA'

/**
 * Build the signer from environment-supplied secrets.
 *
 * Keys are Ed25519 PEM strings. `jose` cannot use a raw `Uint8Array` for EdDSA — it
 * requires a CryptoKey, KeyObject or JWK — so the PEM is imported here, once, at
 * module scope, and the resulting key objects are reused.
 *
 * A PEM in `\n`-escaped form (as environment variables often carry) is normalised
 * first, since a literal backslash-n would not parse.
 */
async function importKeys(
  privateKeyPem: string,
  publicKeyPem: string,
): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const { importPKCS8, importSPKI } = await import('jose')

  const normalise = (pem: string): string => pem.replace(/\\n/g, '\n').trim()

  const [privateKey, publicKey] = await Promise.all([
    importPKCS8(normalise(privateKeyPem), ALGORITHM),
    importSPKI(normalise(publicKeyPem), ALGORITHM),
  ])

  return { privateKey, publicKey }
}

/** Raw PEM material, before key import. */
export interface TokenIssuerSecrets {
  privateKeyPem: string
  publicKeyPem: string
  issuer: string
  audience: string
}

/**
 * Build the signer from environment-supplied secrets.
 *
 * The keys are read lazily so the API can boot for local development and health
 * probes before Phase 1 secrets exist, while still failing loudly on first use in an
 * environment where authentication is actually exercised.
 */
export function keysFromEnv(env: Record<string, string | undefined>): TokenIssuerSecrets {
  const privateKey = env['JWT_PRIVATE_KEY']
  const publicKey = env['JWT_PUBLIC_KEY']

  if (!privateKey || !publicKey) {
    throw new ApiError(
      'INTERNAL_ERROR',
      'JWT signing keys are not configured. Set JWT_PRIVATE_KEY and JWT_PUBLIC_KEY.',
      { isOperational: false },
    )
  }

  return {
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    issuer: env['JWT_ISSUER'] ?? 'https://api.infinigrow.local',
    audience: env['JWT_AUDIENCE'] ?? 'infinigrow-web',
  }
}

/** Import PEM material into usable key objects, with a per-secret cache. */
const importedKeys = new WeakMap<object, Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }>>()

export async function resolveKeys(
  secrets: TokenIssuerSecrets,
): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const cacheKey = secrets as unknown as object

  let keys = importedKeys.get(cacheKey)
  if (!keys) {
    keys = importKeys(secrets.privateKeyPem, secrets.publicKeyPem)
    importedKeys.set(cacheKey, keys)
  }

  return keys
}

/** Issue a signed access token. */
export async function issueAccessToken(
  claims: AccessTokenClaims,
  secrets: TokenIssuerSecrets,
  ttlSeconds: number = SESSION.ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  const { privateKey } = await resolveKeys(secrets)

  return new SignJWT({
    role: claims.role,
    hospitalId: claims.hospitalId,
    membershipId: claims.membershipId,
    sid: claims.sessionId,
  })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(secrets.issuer)
    .setAudience(secrets.audience)
    .setIssuedAt()
    .setJti(claims.sessionId)
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(privateKey)
}

interface VerifiedClaims extends JWTPayload {
  role: Role
  hospitalId: string | null
  membershipId: string | null
  sid: string
}

/**
 * Verify a token's signature, issuer, audience and expiry.
 *
 * Every failure path throws the same `UNAUTHENTICATED` error so a caller cannot
 * tell "expired" from "forged" from "signed for another audience".
 */
export async function verifyAccessToken(
  token: string,
  secrets: TokenIssuerSecrets,
): Promise<AccessTokenClaims> {
  let payload: JWTPayload

  try {
    const { publicKey } = await resolveKeys(secrets)
    const result = await jwtVerify(token, publicKey, {
      algorithms: [ALGORITHM],
      issuer: secrets.issuer,
      audience: secrets.audience,
    })
    payload = result.payload
  } catch {
    throw ApiError.unauthenticated('Invalid or expired access token')
  }

  const claims = payload as VerifiedClaims

  if (!claims.sub || typeof claims.role !== 'string' || typeof claims.sid !== 'string') {
    throw ApiError.unauthenticated('Invalid or expired access token')
  }

  return {
    userId: claims.sub,
    role: claims.role as Role,
    hospitalId: typeof claims.hospitalId === 'string' ? claims.hospitalId : null,
    membershipId: typeof claims.membershipId === 'string' ? claims.membershipId : null,
    sessionId: claims.sid,
  }
}

/** Seconds remaining before expiry; used to decide when to refresh on the client. */
export function accessTokenTtlSeconds(): number {
  return SESSION.ACCESS_TOKEN_TTL_SECONDS
}
