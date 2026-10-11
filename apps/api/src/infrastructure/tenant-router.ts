import { Router, type RequestHandler } from 'express'

import { authenticate, requireTenantScope } from '../middleware/auth.js'

/**
 * A router whose every route is authenticated and tenant-scoped before it runs.
 *
 * ── Why a registrar and not `router.use(...)` ──────────────────────────────────
 *
 * The obvious way to apply a boundary to a whole router is
 * `router.use(authenticate, requireTenantScope)`. That is wrong, and wrong in a way that
 * fails silently.
 *
 * `router.use` runs for every path that ENTERS the router, including paths that match no
 * route at all. A router mounted at the API root therefore turns a per-router boundary
 * into a global one on `/api/v1/*`: unknown paths answer `401` instead of `404`, and
 * `requireTenantScope` rejects a `SUPER_ADMIN` before the platform routes are ever
 * reached. Neither the routes nor the middleware were wrong — the boundary simply leaked
 * past the thing it was meant to wrap.
 *
 * ── Why a registrar and not per-handler middleware ─────────────────────────────
 *
 * The alternative is listing `authenticate, requireTenantScope` on each route. That
 * restores the scope but loses the guarantee: a route added tomorrow without those two
 * lines is publicly reachable, and nothing fails until someone exploits it.
 *
 * A registrar keeps both properties. The router itself is never exported in a form that
 * allows a bare `router.get(...)`, so the only way to add a route is through `route()`,
 * which prepends the boundary. A route cannot be added without it, and it cannot affect
 * anything outside the router.
 */
export interface TenantRouter {
  /** The router to mount in `app.ts`. */
  router: Router
  /** The only way to register a route on it. */
  route: (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    ...handlers: RequestHandler[]
  ) => void
}

export function createTenantRouter(): TenantRouter {
  const router = Router()

  const route: TenantRouter['route'] = (method, path, ...handlers) => {
    router[method](path, authenticate, requireTenantScope, ...handlers)
  }

  return { router, route }
}