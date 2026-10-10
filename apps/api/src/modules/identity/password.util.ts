import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2'

/**
 * Argon2id algorithm identifier.
 *
 * `Algorithm` is an ambient `const enum`, which cannot be read under
 * `verbatimModuleSyntax`. The value 2 is Argon2id per the argon2 specification and is
 * pinned by a test that asserts the digest header is `$argon2id$`.
 */
const ARGON2ID = 2

/**
 * Password hashing with Argon2id.
 *
 * Argon2id is the current OWASP recommendation: memory-hard and resistant to both
 * GPU cracking and side-channel attacks.
 *
 * Parameters follow the OWASP baseline (19 MiB memory, 2 iterations, parallelism 1).
 * `parallelism` is deliberately 1 — a hospital login burst would otherwise multiply
 * memory use per request and risk an out-of-memory failure.
 */

export interface Argon2Options {
  memoryCost: number
  timeCost: number
  parallelism: number
}

/** OWASP-recommended minimums for Argon2id. */
export const DEFAULT_ARGON2_OPTIONS: Argon2Options = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
}

/** Hash a plaintext password. Throws only on invalid parameters. */
export async function hashPassword(
  plaintext: string,
  options: Argon2Options = DEFAULT_ARGON2_OPTIONS,
): Promise<string> {
  return argon2Hash(plaintext, {
    algorithm: ARGON2ID,
    memoryCost: options.memoryCost,
    timeCost: options.timeCost,
    parallelism: options.parallelism,
  })
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Returns `false` for ANY failure, including a malformed or truncated hash. The
 * underlying library throws on a malformed digest, and that throw must not escape:
 * it would tell an attacker that a given account's hash is corrupt.
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false

  try {
    return await argon2Verify(storedHash, plaintext)
  } catch {
    return false
  }
}

/**
 * A hash of a value nobody knows, used to burn roughly the same CPU time when no
 * real hash exists (e.g. a not-found user).
 *
 * Without this, a login attempt for an unknown email returns far faster than one for
 * a known email, which turns response timing into a user-enumeration oracle
 * (docs/SECURITY.md R11).
 */
let decoyHashPromise: Promise<string> | null = null

export function getDecoyHash(): Promise<string> {
  decoyHashPromise ??= hashPassword('a-value-no-one-can-guess-' + Date.now())
  return decoyHashPromise
}

/** Burn equivalent CPU time when there is no real user to verify against. */
export async function performDecoyVerify(plaintext: string): Promise<false> {
  try {
    await verifyPassword(plaintext, await getDecoyHash())
  } catch {
    // Never expected; the point is only to consume comparable time.
  }
  return false
}