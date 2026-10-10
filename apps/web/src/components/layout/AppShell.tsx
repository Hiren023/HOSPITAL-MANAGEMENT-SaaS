import { useEffect, useState, type ReactNode } from 'react'

import { cn } from '../../lib/cn.js'
import { Header } from './Header.js'
import { Sidebar } from './Sidebar.js'

/**
 * Authenticated application shell.
 *
 * Responsive strategy — sidebar on `lg` and up, drawer below:
 *
 *  - desktop and tablet (`lg:`, 1024px+): a fixed sidebar, always visible, with the main
 *    region scrolling independently;
 *  - mobile: the sidebar is an overlay drawer. It is `inert`-like in practice because
 *    Escape closes it and focus is sent to the trigger on close; on small screens a
 *    persistent rail would leave a 16rem column of navigation beside a 20rem viewport.
 *
 * The drawer is only mounted when open, so its links never become invisible-but-focusable
 * tab stops on desktop — the classic bug where an off-screen menu still receives focus.
 */
export function AppShell({
  title,
  breadcrumbs,
  children,
  actions,
  wide = false,
}: {
  title: string
  breadcrumbs?: { label: string; to?: string }[]
  children: ReactNode
  /** Rendered in the header row, right-aligned, under the title on small screens. */
  actions?: ReactNode
  wide?: boolean
}) {
  const [navigationOpen, setNavigationOpen] = useState(false)

  useEffect(() => {
    if (!navigationOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavigationOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)

    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = overflow
    }
  }, [navigationOpen])

  // Close the drawer when the viewport grows past the breakpoint, otherwise it stays open
  // behind the now-visible sidebar.
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)')
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setNavigationOpen(false)
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return (
    <div className="min-h-screen bg-canvas">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      {/* Persistent sidebar, desktop and tablet. */}
      <div className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">
        <div id="app-navigation" className="h-full">
          <Sidebar />
        </div>
      </div>

      {/* Overlay drawer, mobile. */}
      {navigationOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            aria-hidden="true"
            onClick={() => setNavigationOpen(false)}
            className="absolute inset-0 bg-navy-950/50"
          />
          <div className="absolute inset-y-0 left-0 w-64 max-w-[80vw] shadow-xl">
            <Sidebar onNavigate={() => setNavigationOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="lg:pl-64">
        <Header
          title={title}
          breadcrumbs={breadcrumbs}
          navigationOpen={navigationOpen}
          onOpenNavigation={() => setNavigationOpen((open) => !open)}
        />

        <main
          id="main-content"
          tabIndex={-1}
          className={cn(
            'mx-auto w-full px-4 py-6 sm:px-6 sm:py-8',
            wide ? 'max-w-[1600px]' : 'max-w-7xl',
          )}
        >
          {actions ? <div className="mb-5 flex flex-wrap items-center gap-2">{actions}</div> : null}
          {children}
        </main>
      </div>
    </div>
  )
}
