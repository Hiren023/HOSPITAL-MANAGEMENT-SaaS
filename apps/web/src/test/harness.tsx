import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, vi } from 'vitest'

import { AuthProvider } from '../auth/auth-context.js'
import { tokenStore } from '../auth/token-store.js'
import type { Permission, Role } from '@infinigrow/shared'

/**
 * Test harness.
 *
 * `fetch` is mocked rather than the API client module, so the tests exercise the real
 * request path: envelope parsing, header attachment, error mapping and credential
 * handling all run for real. Mocking `apiClient` itself would let a regression in the
 * client pass every test — which is exactly the bug class these tests exist to catch.
 */

export interface MockUser {
  userId?: string
  email?: string
  firstName?: string
  lastName?: string
  role: Role
  hospitalId?: string | null
  hospitalName?: string | null
  membershipId?: string | null
  permissions: Permission[]
  emailVerified?: boolean
}

export interface RecordedRequest {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
}

export interface MockRoute {
  method?: string
  status?: number
  /** Success payload, wrapped in the standard envelope by the harness. */
  data?: unknown
  /** Failure envelope body. */
  error?: { code: string; message: string; details?: unknown[] }
  /** Matched instead of `data` when provided. */
  raw?: string
}

type Routes = Record<string, MockRoute | MockRoute[]>

export interface FetchMock {
  requests: RecordedRequest[]
}

function successEnvelope(data: unknown, requestId = 'test-request') {
  return { success: true, data, meta: { requestId } }
}

function failureEnvelope(error: NonNullable<MockRoute['error']>, requestId = 'test-request') {
  return { success: false, error: { ...error, requestId }, meta: { requestId } }
}

/**
 * Installs a `fetch` mock that serves the given routes.
 *
 * Keys are `"METHOD /path"`. A path containing `?` is matched by pathname only, so a
 * test does not have to spell out every query parameter. When several responses are
 * supplied for one route they are returned in order, which is how the refresh-rotation
 * path is tested.
 */
export function mockApi(routes: Routes): FetchMock {
  const state: FetchMock = { requests: [] }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.startsWith('http') ? new URL(url).pathname : (url.split('?')[0] ?? url)

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }

    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }

    state.requests.push({ url, method, body, headers })

    const entry = routes[`${method} ${path}`]
    if (entry === undefined) {
      return new Response(
        JSON.stringify(
          failureEnvelope({ code: 'NOT_FOUND', message: `No mock for ${method} ${path}` }),
        ),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const response = Array.isArray(entry)
      ? (entry[Math.min(state.requests.length - 1, entry.length - 1)] as MockRoute)
      : entry

    if (response.raw !== undefined) {
      return new Response(response.raw, {
        status: response.status ?? 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const status = response.status ?? (response.error !== undefined ? 400 : 200)

    const payload =
      response.error !== undefined
        ? failureEnvelope(response.error)
        : successEnvelope(response.data ?? null)

    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  vi.stubGlobal('fetch', fetchMock)

  return state
}

/** No active session: the refresh call 401s, which is what a first-time visitor sees. */
export const NO_SESSION: Routes = {
  'POST /api/v1/auth/refresh': {
    status: 401,
    error: { code: 'UNAUTHENTICATED', message: 'No active session' },
  },
}

export function sessionRoutes(user: MockUser, accessToken = 'test-access-token'): Routes {
  return {
    'POST /api/v1/auth/refresh': {
      data: { accessToken, expiresInSeconds: 600, user },
    },
    'POST /api/v1/auth/login': {
      data: { accessToken, expiresInSeconds: 600, user },
    },
    'POST /api/v1/auth/logout': { data: { signedOut: true } },
    'GET /api/v1/auth/me': { data: user },
  }
}

/** Providers every application screen needs. */
export function TestProviders({ children, route = '/' }: { children: ReactNode; route?: string }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })

  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

export interface RenderAppOptions extends Omit<RenderOptions, 'wrapper'> {
  route?: string
}

export function renderApp(ui: ReactElement, options: RenderAppOptions = {}): RenderResult {
  const { route = '/', ...rest } = options
  return render(ui, {
    wrapper: ({ children }) => <TestProviders route={route}>{children}</TestProviders>,
    ...rest,
  })
}

/**
 * Renders the REAL `App` — router, guards and all — at a given path.
 *
 * Required whenever a test is about authorisation. Rendering a guarded page component
 * directly bypasses the guard entirely, so an assertion like "this page must not call the
 * API for a hospital user" would pass for the wrong reason and would keep passing even if
 * the guard were deleted.
 *
 * `App` supplies its own `AuthProvider`, so only the router and query client are added
 * here; wrapping it in a second provider would shadow the real one.
 */
export async function renderAppRoutes(path: string): Promise<RenderResult> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })

  const { App } = await import('../App.js')

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  tokenStore.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
