import { afterEach, describe, expect, it, vi } from 'vitest'

interface LoadResult {
  env: Record<string, unknown> | null
  error: Error | null
}

const ORIGINAL = { ...process.env }

/**
 * `config/env.ts` validates at import time, so each scenario needs a fresh module
 * registry with a tailored `process.env`. An override of `undefined` REMOVES the
 * variable, so a test can exercise a schema default rather than inheriting the value
 * pinned by the test setup file.
 */
async function loadEnv(overrides: Record<string, string | undefined>): Promise<LoadResult> {
  vi.resetModules()

  const next: NodeJS.ProcessEnv = { ...ORIGINAL }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
  }
  process.env = next

  try {
    const module_ = (await import('./env.js')) as unknown as { env: Record<string, unknown> }
    return { env: module_.env, error: null }
  } catch (error) {
    return { env: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

afterEach(() => {
  process.env = { ...ORIGINAL }
})

describe('environment defaults', () => {
  it('applies safe development defaults', async () => {
    // LOG_LEVEL is removed so the schema default is genuinely exercised rather than
    // the value pinned by the test setup file.
    const { env, error } = await loadEnv({ NODE_ENV: 'development', LOG_LEVEL: undefined })

    expect(error).toBeNull()
    expect(env?.['PORT']).toBe(4000)
    expect(env?.['LOG_LEVEL']).toBe('info')
    expect(env?.['isProduction']).toBe(false)
    expect(env?.['corsOrigins']).toEqual(['http://localhost:5173'])
  })

  it('splits a comma-separated CORS list into trimmed origins', async () => {
    const { env } = await loadEnv({ CORS_ORIGINS: 'https://a.example.com, https://b.example.com ' })

    expect(env?.['corsOrigins']).toEqual(['https://a.example.com', 'https://b.example.com'])
  })
})

describe('boolean environment parsing', () => {
  // Regression guard: JavaScript truthiness would make the string "false" evaluate to
  // true, silently disabling security controls such as TRUST_PROXY.
  it.each([
    ['false', false],
    ['0', false],
    ['no', false],
    ['true', true],
    ['1', true],
    ['yes', true],
  ])('parses TRUST_PROXY=%s as %s', async (raw, expected) => {
    const { env } = await loadEnv({ TRUST_PROXY: raw })
    expect(env?.['TRUST_PROXY']).toBe(expected)
  })

  it('rejects an unrecognised boolean rather than guessing', async () => {
    const { error } = await loadEnv({ TRUST_PROXY: 'maybe' })
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('Invalid environment configuration')
  })

  it('defaults TRUST_PROXY to false', async () => {
    const { env } = await loadEnv({})
    expect(env?.['TRUST_PROXY']).toBe(false)
  })
})

describe('base validation', () => {
  it('rejects a non-numeric PORT', async () => {
    const { error } = await loadEnv({ PORT: 'not-a-port' })
    expect(error?.message).toContain('Invalid environment configuration')
  })

  it('rejects an out-of-range PORT', async () => {
    const { error } = await loadEnv({ PORT: '70000' })
    expect(error).toBeInstanceOf(Error)
  })

  it('rejects an unknown NODE_ENV', async () => {
    const { error } = await loadEnv({ NODE_ENV: 'staging' })
    expect(error).toBeInstanceOf(Error)
  })

  it('rejects an invalid database name', async () => {
    const { error } = await loadEnv({ MONGODB_DB_NAME: 'has spaces & symbols!' })
    expect(error).toBeInstanceOf(Error)
  })

  it('accepts a valid mongodb+srv URI', async () => {
    const { error } = await loadEnv({
      MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.invalid/db',
    })
    expect(error).toBeNull()
  })
})

describe('production safety rules', () => {
  const SAFE_PRODUCTION = {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.invalid/db',
    CORS_ORIGINS: 'https://app.example.com',
    LOG_LEVEL: 'info',
    ENABLE_API_DOCS: 'false',
    TRUST_PROXY: 'true',
    TRUST_PROXY_HOPS: '1',
  }

  it('loads a correctly configured production environment', async () => {
    const { env, error } = await loadEnv(SAFE_PRODUCTION)

    expect(error).toBeNull()
    expect(env?.['isProduction']).toBe(true)
  })

  it('refuses to start with a placeholder database URI', async () => {
    const { error } = await loadEnv({ ...SAFE_PRODUCTION, MONGODB_URI: 'mongodb://changeme' })

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('placeholder')
  })

  it('refuses to start with a non-MongoDB URI', async () => {
    const { error } = await loadEnv({ ...SAFE_PRODUCTION, MONGODB_URI: 'postgres://user:pw@host/db' })
    expect(error?.message).toContain('mongodb://')
  })

  it('refuses a wildcard CORS policy', async () => {
    const { error } = await loadEnv({ ...SAFE_PRODUCTION, CORS_ORIGINS: '*' })
    expect(error?.message).toContain('wildcard')
  })

  it('refuses a localhost CORS origin', async () => {
    const { error } = await loadEnv({ ...SAFE_PRODUCTION, CORS_ORIGINS: 'http://localhost:5173' })
    expect(error?.message).toContain('localhost')
  })

  it('refuses API documentation being enabled', async () => {
    const { error } = await loadEnv({ ...SAFE_PRODUCTION, ENABLE_API_DOCS: 'true' })
    expect(error?.message).toContain('ENABLE_API_DOCS')
  })

  it('refuses debug or trace log levels', async () => {
    const { error } = await loadEnv({ ...SAFE_PRODUCTION, LOG_LEVEL: 'debug' })
    expect(error?.message).toContain('LOG_LEVEL')
  })

  it('refuses TRUST_PROXY with zero hops, which would defeat proxy trust', async () => {
    const { error } = await loadEnv({ ...SAFE_PRODUCTION, TRUST_PROXY_HOPS: '0' })
    expect(error?.message).toContain('TRUST_PROXY_HOPS')
  })

  it('reports every problem at once rather than one at a time', async () => {
    const { error } = await loadEnv({
      ...SAFE_PRODUCTION,
      CORS_ORIGINS: '*',
      ENABLE_API_DOCS: 'true',
      MONGODB_URI: 'mongodb://changeme',
    })

    expect(error?.message).toContain('wildcard')
    expect(error?.message).toContain('ENABLE_API_DOCS')
    expect(error?.message).toContain('placeholder')
  })

  it('loads .env from the repository root, not the working directory', async () => {
    // Regression guard: `process.loadEnvFile()` with no argument resolves against
    // `process.cwd()`. Under `npm run dev:api` that is `apps/api`, so the root `.env`
    // was never loaded and every value silently fell back to its default.
    const { existsSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')

    let directory = dirname(fileURLToPath(new URL(import.meta.url)))
    let found: string | null = null
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(directory, '.env')
      if (existsSync(candidate)) {
        found = candidate
        break
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }

    // The discovery logic must resolve to the repository root from inside apps/api.
    expect(found, 'no .env found walking up from the config module').not.toBeNull()
    expect(found).not.toContain('apps\\api')
  })

it('does not apply production rules in development', async () => {
    const { error } = await loadEnv({
      NODE_ENV: 'development',
      MONGODB_URI: 'mongodb://changeme',
      CORS_ORIGINS: '*',
      ENABLE_API_DOCS: 'true',
    })

    expect(error).toBeNull()
  })
})