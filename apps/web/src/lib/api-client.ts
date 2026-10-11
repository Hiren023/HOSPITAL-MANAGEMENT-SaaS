import type { ApiErrorCode, ApiFieldError, ApiResponse } from '@infinigrow/shared'

import { tokenStore } from '../auth/token-store.js'

/**
 * Typed API client.
 *
 * Responsibilities:
 *  - unwrap the standard response envelope, so callers work with data, not envelopes;
 *  - convert every failure into an `ApiClientError` carrying a machine-readable
 *    `code`, so UI logic branches on codes rather than parsing messages;
 *  - attach the access token from an in-memory provider (never `localStorage`);
 *  - abort in-flight requests when the caller signals cancellation.
 *
 * Authentication design note: the access token is supplied by `getAccessToken` and is
 * expected to live in memory only. The refresh token is an `HttpOnly` cookie handled
 * by the browser and is never readable from JavaScript
 * (docs/SECURITY.md R6 / R7).
 */

export class ApiClientError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly details: ApiFieldError[] | undefined
  readonly requestId: string | undefined

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    details?: ApiFieldError[],
    requestId?: string,
  ) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.details = details
    this.requestId = requestId
  }

  /** True for failures that are worth showing to a person as-is. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500
  }

  get isAuthError(): boolean {
    return this.code === 'UNAUTHENTICATED' || this.code === 'MFA_REQUIRED'
  }

  get isRateLimited(): boolean {
    return this.code === 'RATE_LIMITED'
  }

  /** Field-level errors keyed by path, for mapping onto form inputs. */
  get fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const detail of this.details ?? []) {
      result[detail.path] = detail.message
    }
    return result
  }
}

export type TokenProvider = () => string | null

export interface ApiClientOptions {
  baseUrl: string
  getAccessToken?: TokenProvider
  /** Injection seam for tests. */
  fetchImpl?: typeof fetch
  defaultHeaders?: Record<string, string>
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined | null>
}

/**
 * Origin used only to make a relative base URL parseable by the URL constructor.
 * A relative URL is the browser default (`/api/v1`) so that requests stay same-origin
 * and travel through the dev proxy, avoiding CORS entirely in development.
 */
const RELATIVE_BASE_ORIGIN = 'http://localhost.invalid'

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions['query']): string {
  const normalisedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  const normalisedPath = path.startsWith('/') ? path : `/${path}`
  const combined = `${normalisedBase}${normalisedPath}`

  const absolute = isAbsoluteUrl(combined)
  const url = new URL(combined, absolute ? undefined : RELATIVE_BASE_ORIGIN)

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value))
    }
  }

  // Preserve relativity so the browser resolves against the current origin.
  return absolute ? url.toString() : `${url.pathname}${url.search}`
}

export class ApiClient {
  readonly baseUrl: string
  private readonly getAccessToken: TokenProvider
  /** Injected implementation, when one was supplied. */
  private readonly fetchImpl: typeof fetch | null
  private readonly defaultHeaders: Record<string, string>

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl
    this.getAccessToken = options.getAccessToken ?? (() => null)
    this.fetchImpl = options.fetchImpl ?? null
    this.defaultHeaders = options.defaultHeaders ?? {}
  }

  /**
   * Resolved per request rather than captured at construction.
   *
   * Binding `globalThis.fetch` in the constructor captures whatever was installed at
   * module-load time, so any later substitution — an interceptor, a test double, a
   * service-worker shim — is silently ignored. Looking it up per call keeps the client
   * honest about what it is actually using.
   */
  private get fetch(): typeof fetch {
    return this.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  async request<TData>(path: string, options: RequestOptions = {}): Promise<TData> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.defaultHeaders,
      ...options.headers,
    }

    const token = this.getAccessToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    let body: string | undefined
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.body)
    }

    const response = await this.fetch(buildUrl(this.baseUrl, path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: options.signal,
      // Send cookies so the HttpOnly refresh-token cookie travels with the request.
      credentials: 'include',
    })

    // 204 has no body to parse.
    if (response.status === 204) {
      return undefined as TData
    }

    let payload: ApiResponse<TData>
    try {
      payload = (await response.json()) as ApiResponse<TData>
    } catch {
      throw new ApiClientError(
        'INTERNAL_ERROR',
        'The server returned a response that could not be read.',
        response.status,
        undefined,
        response.headers.get('X-Request-Id') ?? undefined,
      )
    }

    if (!payload.success) {
      throw new ApiClientError(
        payload.error.code,
        payload.error.message,
        response.status,
        payload.error.details,
        payload.error.requestId,
      )
    }

    return payload.data
  }

  get<TData>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<TData> {
    return this.request<TData>(path, { ...options, method: 'GET' })
  }

  post<TData>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<TData>(path, { ...options, method: 'POST', body })
  }

  put<TData>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<TData>(path, { ...options, method: 'PUT', body })
  }

  patch<TData>(
    path: string,
    body?: unknown,
    options: Omit<RequestOptions, 'method' | 'body'> = {},
  ) {
    return this.request<TData>(path, { ...options, method: 'PATCH', body })
  }

  delete<TData>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<TData>(path, { ...options, method: 'DELETE' })
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClient(options)
}

/**
 * Default client. The Vite dev server proxies `/api` to the API (see vite.config.ts).
 *
 * The token provider reads the in-memory store, so the token is never written to
 * `localStorage` or `sessionStorage` where any script on the page could read it
 * (docs/SECURITY.md R6).
 */
export const apiClient = createApiClient({
  baseUrl: import.meta.env['VITE_API_BASE_URL'] ?? '/api/v1',
  getAccessToken: () => tokenStore.get(),
})
