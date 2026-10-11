import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'

/**
 * Application-level integration tests.
 *
 * These drive the real Express app in-process over Supertest. No socket is opened and
 * no database is required.
 */

const app = createApp()

describe('service metadata', () => {
  it('serves product information at the root', async () => {
    const response = await request(app).get('/')

    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.data.product).toBe('Infinigrow Hospital Cloud')
    expect(response.body.data.vendor).toBe('Infinigrow Softech')
    expect(response.body.data.tagline).toBe('Ideas grow without limits')
  })
})

describe('health probes', () => {
  it('reports liveness without touching the database', async () => {
    const response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(response.body.data.status).toBe('ok')
    expect(response.body.data.service).toBe('infinigrow-hospital-cloud-api')
    expect(typeof response.body.data.uptimeSeconds).toBe('number')
  })

  it('reports NOT ready when the database is unreachable', async () => {
    const response = await request(app).get('/health/ready')

    // No database is connected in this suite, so readiness must fail honestly.
    expect(response.status).toBe(503)
    expect(response.body.data.checks.database).toBe('down')
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE')
  })
})

describe('API root', () => {
  it('advertises the error-code vocabulary and role matrix', async () => {
    const response = await request(app).get('/api/v1')

    expect(response.status).toBe(200)
    expect(response.body.data.basePath).toBe('/api/v1')
    expect(response.body.data.errorCodes).toContain('TENANT_SCOPE_REQUIRED')
    expect(response.body.data.roles).toContain('HOSPITAL_ADMIN')
    expect(response.body.meta.requestId).toBeTypeOf('string')
  })
})

describe('security headers', () => {
  it('does not advertise the framework', async () => {
    const response = await request(app).get('/')
    expect(response.headers['x-powered-by']).toBeUndefined()
  })

  it('sets nosniff, referrer and frame protections', async () => {
    const response = await request(app).get('/')

    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
  })
})

describe('request correlation', () => {
  it('generates a request id and echoes it in the response header', async () => {
    const response = await request(app).get('/health')

    expect(response.headers['x-request-id']).toBeTypeOf('string')
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('honours a well-formed client-supplied request id', async () => {
    const response = await request(app).get('/health').set('X-Request-Id', 'client-abc12345')

    expect(response.headers['x-request-id']).toBe('client-abc12345')
  })

  it('replaces a malformed request id rather than echoing it (log-injection defence)', async () => {
    // Note: a literal newline cannot be sent at all — Node's HTTP client rejects
    // invalid header values before the request leaves the process. The values below are
    // the malformed ids that can actually reach the server.
    const response = await request(app).get('/health').set('X-Request-Id', 'short')

    expect(response.headers['x-request-id']).not.toBe('short')
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('replaces a request id containing spaces', async () => {
    const response = await request(app).get('/health').set('X-Request-Id', 'has spaces here')

    expect(response.headers['x-request-id']).not.toBe('has spaces here')
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('CORS policy', () => {
  it('allows a configured origin', async () => {
    const response = await request(app).get('/').set('Origin', 'http://localhost:5173')
    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('rejects an origin that is not on the allowlist', async () => {
    const response = await request(app).get('/').set('Origin', 'https://evil.example.com')
    expect(response.status).toBe(403)
  })

  it('allows non-browser callers that send no Origin header', async () => {
    const response = await request(app).get('/health')
    expect(response.status).toBe(200)
  })
})

describe('error envelope', () => {
  it('returns a NOT_FOUND envelope for an unknown route', async () => {
    const response = await request(app).get('/api/v1/does-not-exist')

    expect(response.status).toBe(404)
    expect(response.body.success).toBe(false)
    expect(response.body.error.code).toBe('NOT_FOUND')
    expect(response.body.error.requestId).toBeTypeOf('string')
  })

  it('uses a generic message for NOT_FOUND so ids cannot be enumerated', async () => {
    // A path matching NO route. This used to be `/api/v1/patients/000…`, genuinely unknown
    // when written — but `/patients` is a real tenant-scoped route now, so it answers 401,
    // correctly, because authentication precedes routing. Reusing it here would assert the
    // opposite of what this test is about.
    const response = await request(app).get(
      '/api/v1/no-such-resource/000000000000000000000000',
    )

    expect(response.status).toBe(404)
    expect(response.body.error.message).toBe('Resource not found')
  })

  it('rejects malformed JSON with a validation error rather than a 500', async () => {
    const response = await request(app)
      .post('/api/v1/echo')
      .set('Content-Type', 'application/json')
      .send('{"broken": ')

    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('never includes a stack trace in the response body', async () => {
    const response = await request(app).get('/api/v1/does-not-exist')
    const serialised = JSON.stringify(response.body)

    expect(serialised).not.toContain('at Object.')
    expect(response.body.error).not.toHaveProperty('stack')
  })
})
