import { Router, type RequestHandler } from 'express'

import type { ModuleKey } from '@infinigrow/shared'

import { authenticate, requireTenantScope } from '../middleware/auth.js'
import { requireModule } from '../modules/subscriptions/entitlement.middleware.js'

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

/**
 * Create a tenant router, optionally behind a subscription entitlement.
 *
 * ── The module gate belongs here, not on each route ───────────────────────────
 *
 * A hospital's plan decides which modules it may use, and that check has to run on the
 * server. Putting `requireModule('BILLING')` on 30 individual billing routes would work
 * right up until somebody adds a 31st and forgets it — and the failure would be silent,
 * because the missing gate looks exactly like a working route until a tenant on the
 * Starter plan reaches it.
 *
 * So the gate is a property of the *router*, not of each route. A router is created for
 * a module, and every route registered on it inherits the check by construction. Adding
 * a route cannot skip it, and there is no list of handlers to keep in sync.
 *
 * It stays inside `route()` rather than becoming `router.use(...)` for the reason set out
 * above: `router.use` also runs for paths that match no route, which would turn a 404
 * into a 403 and leak the fact that a module exists at all.
 *
 * ── Write methods additionally require a writable subscription ─────────────────
 *
 * Derived from the HTTP method rather than declared per route, because the same "did this
 * change anything?" question applies to every module and deriving it means a new POST
 * route is write-gated without anyone remembering. There are no side-effecting GETs in
 * this API; if one is ever added it needs a documented exception here, not a silent
 * hole.
 */
export function createTenantRouter(options: { module?: ModuleKey } = {}): TenantRouter {
  const router = Router()
  const gate = options.module

  const route: TenantRouter['route'] = (method, path, ...handlers) => {
    const entitlement =
      gate === undefined
        ? []
        : [requireModule(gate, { write: method !== 'get' })]

    router[method](path, authenticate, requireTenantScope, ...entitlement, ...handlers)
  }

  return { router, route }
}