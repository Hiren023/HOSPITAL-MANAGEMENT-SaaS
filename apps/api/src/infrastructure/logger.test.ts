import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { REDACTED_FIELD_NAMES, REDACTED_HEADER_NAMES, REDACTED_VALUE, createLogger } from './logger.js'

/**
 * Log redaction tests (docs/SECURITY.md R8).
 *
 * These assert a security property, not a formatting detail: a secret or a piece of
 * patient information must never appear in the log stream.
 */

/**
 * Capture one log line.
 *
 * Pino delivers to the destination stream asynchronously, so the write must be flushed
 * before the output is inspected — otherwise the assertion reads an empty buffer and
 * would pass for the wrong reason.
 */
async function captureLog(write: (logger: ReturnType<typeof createLogger>) => void): Promise<string> {
  const chunks: string[] = []

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })

  const logger = createLogger({ destination: stream, level: 'info' })
  write(logger)

  await new Promise((resolve) => setImmediate(resolve))

  return chunks.join('')
}

describe('logger destination', () => {
  it('writes to the supplied stream rather than stdout', async () => {
    // Regression: pino 10 ignores a `stream` key inside the options object and silently
    // logs to stdout. This asserts the destination is genuinely honoured, so the
    // redaction tests below cannot pass vacuously.
    const line = await captureLog((logger) => logger.info({ marker: 'captured-here' }, 'test'))

    expect(line).toContain('captured-here')
  })
})

describe('logger redaction', () => {
  it('redacts a password field', async () => {
    const line = await captureLog((logger) =>
      logger.info({ email: 'user@example.test', password: 'correct-horse-battery-staple' }, 'login attempt'),
    )

    expect(line).not.toContain('correct-horse-battery-staple')
    expect(line).toContain(REDACTED_VALUE)
    // Non-sensitive context stays available for debugging.
    expect(line).toContain('user@example.test')
  })

  it('strips request headers entirely rather than serialising them', async () => {
    // The `req` serialiser emits method, url and remote address only, so a bearer
    // token or cookie is dropped before redaction even runs.
    const line = await captureLog((logger) =>
      logger.info(
        {
          req: {
            method: 'GET',
            url: '/api/v1/patients',
            headers: {
              authorization: 'Bearer eyJhbGciOi.super.secret.token',
              cookie: 'refresh_token=abcdef123456',
            },
          },
        },
        'incoming request',
      ),
    )

    expect(line).not.toContain('eyJhbGciOi.super.secret.token')
    expect(line).not.toContain('abcdef123456')
    expect(line).not.toContain('"headers"')
    expect(line).toContain('"url":"/api/v1/patients"')
  })

  it('redacts a headers object logged outside a request', async () => {
    // Defence in depth: a developer who logs headers directly still gets redaction.
    const line = await captureLog((logger) =>
      logger.info(
        {
          headers: {
            authorization: 'Bearer eyJhbGciOi.super.secret.token',
            cookie: 'refresh_token=abcdef123456',
          },
        },
        'headers',
      ),
    )

    expect(line).not.toContain('eyJhbGciOi.super.secret.token')
    expect(line).not.toContain('abcdef123456')
    expect(line).toContain(REDACTED_VALUE)
  })

  it('redacts patient identifiers and clinical content', async () => {
    const line = await captureLog((logger) =>
      logger.info(
        {
          patient: {
            name: 'TEST Patient',
            dateOfBirth: '1975-04-02',
            phone: '+91 98765 43210',
            diagnosis: 'synthetic-diagnosis-value',
            chiefComplaint: 'synthetic-complaint-value',
          },
        },
        'clinical record accessed',
      ),
    )

    expect(line).not.toContain('1975-04-02')
    expect(line).not.toContain('98765 43210')
    expect(line).not.toContain('synthetic-diagnosis-value')
    expect(line).not.toContain('synthetic-complaint-value')
  })

  it('redacts nested clinical fields under any parent key', async () => {
    const line = await captureLog((logger) =>
      logger.info({ consultationPayload: { diagnosis: 'hidden-diagnosis' } }, 'nested'),
    )

    expect(line).not.toContain('hidden-diagnosis')
    expect(line).toContain(REDACTED_VALUE)
  })

  it('declares redaction for every sensitive field and header we know about', () => {
    expect(REDACTED_FIELD_NAMES).toContain('password')
    expect(REDACTED_FIELD_NAMES).toContain('diagnosis')
    expect(REDACTED_FIELD_NAMES).toContain('dateOfBirth')
    expect(REDACTED_HEADER_NAMES).toContain('authorization')
    expect(REDACTED_HEADER_NAMES).toContain('cookie')
  })
})

describe('logger output format', () => {
  it('emits a single JSON object per line with the service identifier', async () => {
    const line = await captureLog((logger) => logger.info('ready'))

    const parsed = JSON.parse(line.trim()) as Record<string, unknown>
    expect(parsed['msg']).toBe('ready')
    expect(parsed['service']).toBe('infinigrow-hospital-cloud-api')
  })

  it('serialises a request to method and url only, never headers', async () => {
    const line = await captureLog((logger) =>
      logger.info(
        { req: { method: 'GET', url: '/api/v1/patients', headers: { authorization: 'Bearer secret-token' } } },
        'request',
      ),
    )

    const parsed = JSON.parse(line.trim()) as { req: Record<string, unknown> }
    expect(parsed.req['method']).toBe('GET')
    expect(parsed.req['url']).toBe('/api/v1/patients')
    expect(parsed.req['headers']).toBeUndefined()
  })
})