import process from 'node:process'
import { z } from 'zod'

/**
 * Environment configuration — validated once, at startup, and validated strictly.
 *
 * Design goals:
 *  1. Fail fast. A misconfigured deployment must not start and then fail halfway
 *     through a patient record request.
 *  2. Never accept a placeholder secret in production.
 *  3. Provide safe development defaults so a new contributor can run locally.
 *
 * This module deliberately throws on invalid configuration. Importing it is safe;
 * *using* the exported `env` value is what triggers validation.
 */

/**
 * Set to `1` to skip loading a local `.env` file entirely.
 *
 * The test suite sets this so that a developer's local `.env` — which may contain a
 * real Atlas URI — can never influence test runs.
 */
const SKIP_DOTENV = process.env['DOTENV_DISABLED'] === '1'

// Load a local .env file when present. In production the variables come from the
// platform's secret manager and this simply finds no file.
if (!SKIP_DOTENV) {
  try {
    process.loadEnvFile()
  } catch {
    // No .env file — rely on the real process environment.
  }
}

const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/**
 * Parse a boolean from an environment variable.
 *
 * `z.coerce.boolean()` cannot be used here: it applies JavaScript truthiness, so the
 * string "false" would be coerced to `true`. That class of bug silently disables
 * security controls, so we accept only explicit tokens.
 */
const booleanFromEnv = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes')

/**
 * Values that indicate a secret was copied from the template and never replaced.
 *
 * Matched anywhere in the string, not just at the start — a connection string such as
 * `mongodb://changeme` puts the placeholder in the middle, and an anchored pattern
 * would wave it straight through into production.
 */
const PLACEHOLDER_PATTERN =
  /(changeme|change-me|replace[-_ ]?me|placeholder|your[-_ ]?(secret|password|key|token)|xxx+|<[^>]+>)/i

const isMongoUri = (value: string): boolean => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://')

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Pretty-printed logs are for humans; JSON is required for log aggregation. */
  LOG_PRETTY: booleanFromEnv.default(false),

  /** Comma-separated list of browser origins permitted to call the API. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /**
   * Only enable behind a trusted reverse proxy / load balancer that sets
   * `X-Forwarded-For`. Enabling it without a proxy allows clients to spoof their IP,
   * which defeats IP-based rate limiting and poisons audit logs.
   */
  TRUST_PROXY: booleanFromEnv.default(false),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  REQUEST_BODY_LIMIT: z.string().default('1mb'),

  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017'),
  MONGODB_DB_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default('infinigrow'),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  /** Guard against accidentally dropping data. */
  MONGODB_AUTO_INDEX: booleanFromEnv.default(false),

  /** Serves the OpenAPI explorer. Force-disabled in production by the schema below. */
  ENABLE_API_DOCS: booleanFromEnv.default(true),
})

export type RawEnv = z.infer<typeof rawEnvSchema>

/**
 * Cross-field rules that depend on NODE_ENV.
 *
 * These are the checks that actually protect production: a template secret or a
 * wildcard CORS policy must never survive into a production deployment.
 */
function applyEnvironmentRules(env: RawEnv): RawEnv {
  if (env.NODE_ENV !== 'production') return env

  const problems: string[] = []

  if (PLACEHOLDER_PATTERN.test(env.MONGODB_URI)) {
    problems.push('MONGODB_URI still contains a placeholder value')
  }
  if (!isMongoUri(env.MONGODB_URI)) {
    problems.push('MONGODB_URI must start with mongodb:// or mongodb+srv://')
  }
  if (env.CORS_ORIGINS.includes('*')) {
    problems.push('CORS_ORIGINS must not be a wildcard in production')
  }
  if (env.CORS_ORIGINS.includes('localhost')) {
    problems.push('CORS_ORIGINS must not reference localhost in production')
  }
  if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') {
    problems.push('LOG_LEVEL must not be debug or trace in production')
  }
  if (env.ENABLE_API_DOCS) {
    problems.push('ENABLE_API_DOCS must be false in production')
  }
  if (env.TRUST_PROXY && env.TRUST_PROXY_HOPS === 0) {
    problems.push('TRUST_PROXY is true but TRUST_PROXY_HOPS is 0, which defeats proxy trust')
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production with unsafe configuration:\n  - ${problems.join('\n  - ')}`,
    )
  }

  return env
}

function loadEnv(): RawEnv {
  const parsed = rawEnvSchema.safeParse(process.env)

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${details}`)
  }

  return applyEnvironmentRules(parsed.data)
}

const raw = loadEnv()

export interface AppEnv extends RawEnv {
  readonly isProduction: boolean
  readonly isDevelopment: boolean
  readonly isTest: boolean
  readonly corsOrigins: string[]
}

export const env: AppEnv = Object.freeze({
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
})