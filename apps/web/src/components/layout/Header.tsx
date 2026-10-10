import { LogOut, Menu, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useAuth } from '../../auth/auth-context.js'
import { isPlatformUser } from '../../auth/session.js'
import { Button } from '../ui/Button.js'
import { RoleBadge } from '../ui/Badge.js'
import { cn } from '../../lib/cn.js'
import { Breadcrumbs } from './Breadcrumbs.js'

/**
 * Application header.
 *
 * Holds the mobile navigation trigger, breadcrumbs, and the account menu. On small
 * screens the sidebar becomes an overlay drawer (see AppShell); on large screens this
 * header sits above a persistent sidebar.
 *
 * The account menu is a real disclosure button with `aria-expanded` and `aria-controls`,
 * closing on Escape and on outside click, because a menu that traps a keyboard user's
 * focus in a non-modal element is one of the most common accessibility defects in
 * application shells.
 */
export function Header({
  onOpenNavigation,
  navigationOpen = false,
  title,
  breadcrumbs,
}: {
  onOpenNavigation: () => void
  navigationOpen?: boolean
  title: string
  breadcrumbs?: { label: string; to?: string }[]
}) {
  const { user, signOut } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return

    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        document.getElementById('account-menu-button')?.focus()
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
        <button
          type="button"
          onClick={onOpenNavigation}
          aria-label={navigationOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={navigationOpen}
          aria-controls="app-navigation"
          className="-ml-1 rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink lg:hidden"
        >
          {navigationOpen ? (
            <X aria-hidden="true" className="size-5" />
          ) : (
            <Menu aria-hidden="true" className="size-5" />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-navy-900">{title}</h1>
          {breadcrumbs ? <Breadcrumbs items={breadcrumbs} className="mt-0.5" /> : null}
        </div>

        {user ? (
          <div className="relative shrink-0" ref={menuRef}>
            <button
              id="account-menu-button"
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-controls="account-menu"
              className="flex items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-2 text-left transition-colors hover:bg-surface-muted"
            >
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800"
              >
                {user.firstName?.[0] ?? ''}
                {user.lastName?.[0] ?? ''}
              </span>
              <span className="hidden min-w-0 sm:block">
                <span className="block truncate text-xs font-medium text-ink">
                  {user.firstName} {user.lastName}
                </span>
                <span className="block truncate text-[0.6875rem] text-ink-subtle">
                  {isPlatformUser(user) ? 'Platform' : user.hospitalName}
                </span>
              </span>
            </button>

            <div
              id="account-menu"
              role="menu"
              hidden={!menuOpen}
              className={cn(
                'absolute right-0 z-40 mt-2 w-60 overflow-hidden rounded-card border border-line bg-surface shadow-lg',
              )}
            >
              <div className="border-b border-line px-4 py-3">
                <p className="truncate text-sm font-medium text-ink">{user.email}</p>
                <div className="mt-1.5">
                  <RoleBadge role={user.role} />
                </div>
              </div>
              <div className="p-1.5">
                <Button
                  variant="ghost"
                  full
                  leadingIcon={<LogOut aria-hidden="true" className="size-4" />}
                  onClick={() => void signOut()}
                  className="justify-start"
                >
                  Sign out
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </header>
  )
}
