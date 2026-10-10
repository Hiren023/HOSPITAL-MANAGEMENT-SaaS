import type { Permission } from '@infinigrow/shared'
import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'

import { useAuth } from './auth-context.js'
import { hasAnyPermission, hasPermission, isPlatformUser } from './session.js'

/**
 * Route guards.
 *
 * These decide what a person may *reach in the UI*. They are a usability and defence-
 * in-depth layer, never the security boundary: the API independently re-checks the
 * permission on every request using a token it issued and signed itself, and derives
 * `hospitalId` from that token rather than from anything the client sent
 * (docs/SECURITY.md R11). A guard bypass therefore yields an empty shell, not data.
 *
 * They are still built properly, because a menu that offers a page the person cannot
 * open is a broken product, and because a route guard is what stops a user from
 * discovering the existence of modules they have no business seeing.
 */

/** Shown while the refresh cookie is exchanged for an access token. */
function RestoringScreen() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-canvas"
    >
      <p className="text-sm text-ink-muted">Restoring your session…</p>
    </div>
  )
}

/** Shown when the session is valid but lacks the permission for this route. */
export function UnauthorizedState({
  message = 'You do not have permission to view this page.',
}: {
  message?: string
}) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-6 py-20 text-center">
      <div
        aria-hidden="true"
        className="mb-5 flex size-12 items-center justify-center rounded-full bg-warning-bg text-xl font-semibold text-warning"
      >
        403
      </div>
      <h1 className="text-2xl font-semibold">Access restricted</h1>
      <p role="alert" className="mt-2 text-sm text-ink-muted">
        {message}
      </p>
      <p className="mt-1 text-sm text-ink-subtle">
        If you need this, ask a hospital administrator to update your role.
      </p>
      <a
        href="/dashboard"
        className="mt-6 text-sm font-medium text-brand-700 underline underline-offset-4 hover:text-brand-800"
      >
        Return to your dashboard
      </a>
    </div>
  )
}

/**
 * Requires a signed-in identity.
 *
 * `state.from` carries the attempted location so the login screen can return the person
 * to where they were headed rather than dropping them on the dashboard.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'restoring') return <RestoringScreen />

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  return <>{children}</>
}

/** Requires a specific permission. */
export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission
  children: ReactNode
}) {
  const { status, user } = useAuth()

  if (status === 'restoring') return <RestoringScreen />

  if (status === 'anonymous' || user === null) {
    return <Navigate to="/login" replace />
  }

  if (!hasPermission(user, permission)) {
    return <UnauthorizedState />
  }

  return <>{children}</>
}

/** Requires any one of several permissions (an "any of" gate). */
export function RequireAnyPermission({
  permissions,
  children,
}: {
  permissions: Permission[]
  children: ReactNode
}) {
  const { status, user } = useAuth()

  if (status === 'restoring') return <RestoringScreen />

  if (status === 'anonymous' || user === null) {
    return <Navigate to="/login" replace />
  }

  if (!hasAnyPermission(user, permissions)) {
    return <UnauthorizedState />
  }

  return <>{children}</>
}

/**
 * Requires a platform administrator.
 *
 * Hospital-scoped routes use the opposite of this: `RequireTenantScope`, which sends a
 * platform operator away from tenant screens, because a platform operator has no
 * hospital to render.
 */
export function RequirePlatform({ children }: { children: ReactNode }) {
  const { status, user } = useAuth()

  if (status === 'restoring') return <RestoringScreen />

  if (status === 'anonymous' || user === null) {
    return <Navigate to="/login" replace />
  }

  if (!isPlatformUser(user)) {
    return <UnauthorizedState message="This area is for platform administrators only." />
  }

  return <>{children}</>
}

/** Requires a hospital membership — the inverse of `RequirePlatform`. */
export function RequireTenantScope({ children }: { children: ReactNode }) {
  const { status, user } = useAuth()

  if (status === 'restoring') return <RestoringScreen />

  if (status === 'anonymous' || user === null) {
    return <Navigate to="/login" replace />
  }

  if (isPlatformUser(user) || user.hospitalId === null) {
    return (
      <UnauthorizedState message="This area belongs to a hospital. You are signed in as a platform administrator." />
    )
  }

  return <>{children}</>
}
