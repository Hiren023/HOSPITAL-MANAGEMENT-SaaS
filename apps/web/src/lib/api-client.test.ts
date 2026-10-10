import { describe, expect, it, vi } from 'vitest'

import type { ApiClient } from './api-client.js'
import { ApiClientError, createApiClient } from './api-client.js'

/**
 * API client tests.
 *
 * The client's job is to turn the server envelope into either clean data or a typed
 * error. Getting that wrong would force UI code to parse error strings, which is
 * fragile and a common source of inconsistent error states.
 */

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

const clientWith = (fetchImpl: typeof fetch, token: string | null = null): ApiClient =>
  createApiClient({ baseUrl: '/api/v1', fetchImpl, getAccessToken: () => token })

describe('successful responses', () => {
  it('unwraps the success envelope and returns only the data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, data: { id: '1', name: 'Aarav Memorial Hospital' } }),
    )

    const result = await clientWith(fetchImpl as unknown as typeof fetch).get('/hospitals')

    expect(result).toEqual({ id: '1', name: 'Aarav Memorial Hospital' })
  })

  it('handles a 204 No Content response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))

    await expect(clientWith(fetchImpl as unknown as typeof fetch).delete('/x')).resolves.toBeUndefined()
  })

  it('serialises a JSON body and sets the content type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { ok: true } }))

    await clientWith(fetchImpl as unknown as typeof fetch).post('/echo', { name: 'Test' })

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Test' })
  })

  it('builds a query string and omits null or undefined values', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: [] }))

    await clientWith(fetchImpl as unknown as typeof fetch).get('/patients', {
      query: { page: 2, q: 'kumar', cursor: undefined, cursor2: null },
    })

    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toContain('page=2')
    expect(url).toContain('q=kumar')
    expect(url).not.toContain('cursor=')
  })
})

describe('authentication header', () => {
  it('attaches a bearer token when one is available', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} }))

    await clientWith(fetchImpl as unknown as typeof fetch, 'jwt-token-value').get('/me')

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer jwt-token-value')
  })

  it('omits the header when there is no token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} }))

    await clientWith(fetchImpl as unknown as typeof fetch).get('/me')

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('sends credentials so the HttpOnly refresh cookie is included', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} }))

    await clientWith(fetchImpl as unknown as typeof fetch).get('/me')

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(init.credentials).toBe('include')
  })
})

describe('URL construction', () => {
  // Regression: `new URL('/api/v1/hospitals')` throws "Invalid URL" because the
  // constructor requires an absolute base. The browser default is a relative base,
  // so this path is the one that actually runs in production.
  it('supports a relative base URL and keeps the path relative', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} }))

    await createApiClient({ baseUrl: '/api/v1', fetchImpl: fetchImpl as unknown as typeof fetch }).get(
      '/hospitals',
    )

    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('/api/v1/hospitals')
  })

  it('supports an absolute base URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} }))

    await createApiClient({
      baseUrl: 'https://api.example.com/api/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).get('/hospitals')

    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('https://api.example.com/api/v1/hospitals')
  })

  it('tolerates a missing leading slash on the base and on the path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} }))

    await createApiClient({ baseUrl: 'api/v1', fetchImpl: fetchImpl as unknown as typeof fetch }).get(
      'hospitals',
    )

    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('/api/v1/hospitals')
  })

  it('tolerates a trailing slash on the base URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} }))

    await createApiClient({ baseUrl: '/api/v1/', fetchImpl: fetchImpl as unknown as typeof fetch }).get(
      '/hospitals',
    )

    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('/api/v1/hospitals')
  })
})

describe('error responses', () => {
  it('throws a typed error carrying the machine-readable code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'FORBIDDEN', message: 'Not allowed', requestId: 'req-123' },
        },
        { status: 403 },
      ),
    )

    const error = await clientWith(fetchImpl as unknown as typeof fetch)
      .get('/patients')
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ApiClientError)
    const clientError = error as ApiClientError
    expect(clientError.code).toBe('FORBIDDEN')
    expect(clientError.status).toBe(403)
    expect(clientError.requestId).toBe('req-123')
    expect(clientError.isClientError).toBe(true)
  })

  it('exposes field errors keyed by path for mapping onto form inputs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            requestId: 'req-456',
            details: [
              { path: 'email', message: 'Must be a valid email address' },
              { path: 'items.0.quantity', message: 'Must be greater than 0' },
            ],
          },
        },
        { status: 422 },
      ),
    )

    const error = (await clientWith(fetchImpl as unknown as typeof fetch)
      .post('/patients', {})
      .catch((thrown: unknown) => thrown)) as ApiClientError

    expect(error.fieldErrors).toEqual({
      email: 'Must be a valid email address',
      'items.0.quantity': 'Must be greater than 0',
    })
  })

  it('identifies authentication and rate-limit failures', async () => {
    const unauthenticated = new ApiClientError('UNAUTHENTICATED', 'Authentication required', 401)
    const rateLimited = new ApiClientError('RATE_LIMITED', 'Too many requests', 429)

    expect(unauthenticated.isAuthError).toBe(true)
    expect(rateLimited.isRateLimited).toBe(true)
  })

  it('reports a server error without leaking internals', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId: 'req-789' },
        },
        { status: 500 },
      ),
    )

    const error = (await clientWith(fetchImpl as unknown as typeof fetch)
      .get('/patients')
      .catch((thrown: unknown) => thrown)) as ApiClientError

    expect(error.code).toBe('INTERNAL_ERROR')
    expect(error.message).toBe('An unexpected error occurred')
    expect(error.isClientError).toBe(false)
  })

  it('throws a typed error when the response body is not valid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('<html>Gateway timeout</html>', {
        status: 504,
        headers: { 'Content-Type': 'text/html', 'X-Request-Id': 'req-gateway' },
      }),
    )

    const error = (await clientWith(fetchImpl as unknown as typeof fetch)
      .get('/patients')
      .catch((thrown: unknown) => thrown)) as ApiClientError

    expect(error).toBeInstanceOf(ApiClientError)
    expect(error.status).toBe(504)
    expect(error.requestId).toBe('req-gateway')
  })
})