/**
 * Validates the production configuration documented in docs/DEPLOYMENT.md Ãƒâ€šÃ‚Â§2.2 against
 * the real guards in `apps/api/src/config/env.ts`.
 *
 * ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Why this exists ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
 *
 * The deployment document listed `TRUST_PROXY=true` with no `TRUST_PROXY_HOPS`.
 * `env.ts` refuses to boot in production when that combination is present, so following
 * the document exactly produced a server that would not start ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â and the failure happens
 * on the production host, not in review.
 *
 * A deployment guide is executable configuration. It deserves the same check as code, and
 * the check has to run against the real guards rather than a copy of them.
 *
 * Each case below is a scenario an operator will actually hit.
 *
 *   npx tsx scripts/check-production-env.ts
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

/** A key pair that parses, so this tests the CONFIG and not the cryptography. */
const KEY_PAIR = spawnSync('node', ['scripts/generate-jwt-keys.mjs'], {
  encoding: 'utf8',
})

/**
 * Read one generated key out of generate-jwt-keys.mjs output.
 *
 * Matches to END OF LINE, not a non-whitespace run. A PEM header contains spaces --
 * -----BEGIN PRIVATE KEY----- -- so a \S+ style match captures exactly "-----BEGIN" and
 * stops. The harness then fed the API a ten-character "key", the placeholder check
 * rightly refused it, and the failure was reported against the production configuration
 * instead of against the test that built it.
 */
function extract(name: string): string {
  const match = KEY_PAIR.stdout.match(new RegExp(`^${name}=(?:"([^"]*)"|([^\r\n]+))`, 'm'))
  const value = match?.[1] ?? match?.[2] ?? ''
  return value.trim().replace(/\\\\n/g, '\n')
}
const PRIVATE_KEY = extract('JWT_PRIVATE_KEY')
const PUBLIC_KEY = extract('JWT_PUBLIC_KEY')

const BASE = {
  NODE_ENV: 'production',
  PORT: '4000',
  HOST: '0.0.0.0',
  LOG_LEVEL: 'warn',
  LOG_PRETTY: 'false',
  CORS_ORIGINS: 'https://app.example.com',
  REQUEST_BODY_LIMIT: '1mb',
  TRUST_PROXY: 'true',
  // The value the document previously omitted.
  TRUST_PROXY_HOPS: '1',
  MONGODB_URI: 'mongodb+srv://app:PASS@cluster.mongodb.net/?retryWrites=true&w=majority',
  MONGODB_DB_NAME: 'infinigrow_prod',
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: '5000',
  MONGODB_AUTO_INDEX: 'false',
  ENABLE_API_DOCS: 'false',
  JWT_PRIVATE_KEY: PRIVATE_KEY,
  JWT_PUBLIC_KEY: PUBLIC_KEY,
  JWT_ISSUER: 'https://api.example.com',
  JWT_AUDIENCE: 'infinigrow-web',
  CLINICAL_STORAGE_DIR: '/var/lib/infinigrow/documents',
} satisfies Record<string, string>

interface Case {
  name: string
  env: Record<string, string>
  expectBoot: boolean
  expectMessage?: RegExp
}

/**
 * The cases, each of which is a way the documented setup goes wrong.
 */
const CASES: Case[] = [
  {
    name: 'the documented configuration',
    env: BASE,
    expectBoot: true,
  },
  {
    name: 'TRUST_PROXY=true with TRUST_PROXY_HOPS omitted (the original defect)',
    env: { ...BASE, TRUST_PROXY_HOPS: undefined as unknown as string },
    expectBoot: false,
    expectMessage: /TRUST_PROXY_HOPS/,
  },
  {
    name: 'wildcard CORS',
    env: { ...BASE, CORS_ORIGINS: '*' },
    expectBoot: false,
    expectMessage: /CORS_ORIGINS/,
  },
  {
    name: 'localhost in CORS',
    env: { ...BASE, CORS_ORIGINS: 'http://localhost:5173' },
    expectBoot: false,
    expectMessage: /localhost/,
  },
  {
    name: 'API docs enabled',
    env: { ...BASE, ENABLE_API_DOCS: 'true' },
    expectBoot: false,
    expectMessage: /ENABLE_API_DOCS/,
  },
  {
    name: 'placeholder secret',
    env: { ...BASE, JWT_PRIVATE_KEY: 'changeme' },
    expectBoot: false,
    expectMessage: /placeholder/i,
  },
  {
    name: 'placeholder in the Mongo URI',
    env: { ...BASE, MONGODB_URI: 'mongodb://user:changeme@host/db' },
    expectBoot: false,
    expectMessage: /placeholder/i,
  },
  {
    name: 'debug logging in production',
    env: { ...BASE, LOG_LEVEL: 'debug' },
    expectBoot: false,
    expectMessage: /LOG_LEVEL/,
  },
]

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = 'apps/api/src/config/env.ts'

const dir = mkdtempSync(join(tmpdir(), 'envcheck-'))

let failures = 0

for (const testCase of CASES) {
  const vars = Object.entries(testCase.env).filter(([, value]) => value !== undefined)
  const runner = join(dir, 'run.mjs')

  // A fresh module graph per case, because `env.ts` validates at import time and a cached
  // module would let the first case's success mask the second case's failure.
  writeFileSync(
    runner,
    [
      "process.env.DOTENV_DISABLED = '1'",
      ...vars.map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)}`),
      "await import(process.argv[2])",  // runner receives a file:// URL
      "console.log('BOOT_OK')",
      '',
    ].join('\n'),
    'utf8',
  )

  const result = spawnSync(
    // The LOCAL tsx binary, invoked directly.
    //
    // `env.ts` is TypeScript so plain node cannot import it, and `npx` on Windows is a
    // `.cmd` shim that `spawnSync` will not resolve without a shell Ã¢â‚¬â€ which fails
    // silently, returning empty output that looks exactly like "the guard said nothing".
    // Calling the binary in node_modules removes both problems and keeps the harness
    // offline-deterministic.
    process.execPath,
    [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), runner, pathToFileURL(join(ROOT, CONFIG_PATH)).href],
    { encoding: 'utf8', env: { ...process.env, DOTENV_DISABLED: '1' }, cwd: ROOT },
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const booted = output.includes('BOOT_OK')
  const refused = /Refusing to start in production/.test(output)

  const passed =
    testCase.expectBoot ? booted : refused && (!testCase.expectMessage || testCase.expectMessage.test(output))

  if (!passed) failures += 1

  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${testCase.name}`)
  if (!passed) {
    console.log(`        expected ${testCase.expectBoot ? 'boot' : 'refusal'}`)
    console.log(`        got: ${output.trim().split('\n').slice(0, 4).join(' | ').slice(0, 300)}`)
  }
}

unlinkSync(join(dir, 'run.mjs'))

console.log(`\n${CASES.length - failures}/${CASES.length} configuration cases behave as documented.`)

if (failures > 0) {
  console.log(
    '\nA deployment guide that names values the guards reject is worse than none: the ' +
      'operator follows it and the service will not start.',
  )
  process.exit(1)
}
