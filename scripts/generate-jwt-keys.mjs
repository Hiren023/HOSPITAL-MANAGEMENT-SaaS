/**
 * Generates an Ed25519 key pair for JWT signing and prints a .env-ready snippet.
 *
 * Run:  node scripts/generate-jwt-keys.mjs
 *
 * Paste the output into `.env`. NEVER commit the private key.
 */

import { generateKeyPairSync } from 'node:crypto'

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const single = (pem) => pem.trim().replace(/\n/g, '\\n')

console.log('# ── Copy into your .env ─────────────────────────────────────────────')
console.log(`JWT_PRIVATE_KEY=${single(privateKey)}`)
console.log(`JWT_PUBLIC_KEY=${single(publicKey)}`)
console.log('# ────────────────────────────────────────────────────────────────────')
console.log('')
console.log('Store the private key in your platform secret manager in production.')
console.log('Never commit it. The CI secret scan will reject it.')