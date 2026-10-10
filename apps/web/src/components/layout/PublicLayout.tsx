import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Menu, X } from 'lucide-react'

import { Button } from '../ui/Button.js'
import { cn } from '../../lib/cn.js'
import { BrandMark } from './BrandMark.js'

const LINKS = [
  { label: 'Product', href: '#product' },
  { label: 'Features', href: '#features' },
  { label: 'Security', href: '#security' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'FAQ', href: '#faq' },
]

/**
 * Public marketing layout.
 *
 * `skip-link` is present here too: a marketing page is exactly where a keyboard user is
 * most likely to arrive from a search result and immediately want the sign-in link.
 *
 * The mobile menu closes on Escape and on navigating, so it never strands an overlay over
 * the content.
 */
export function PublicLayout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link to="/" className="shrink-0" aria-label="Infinigrow Hospital Cloud, home">
            <BrandMark />
          </Link>

          <nav aria-label="Main" className="ml-auto hidden items-center gap-1 md:flex">
            {LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="rounded-lg px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 md:ml-2">
            <Link to="/login" className="hidden sm:block">
              <Button variant="ghost" size="sm">
                Sign in
              </Button>
            </Link>
            <Link to="/register">
              <Button size="sm">Request a demo</Button>
            </Link>

            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-controls="public-mobile-menu"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              className="rounded-lg p-2 text-ink-muted transition-colors hover:bg-surface-muted md:hidden"
            >
              {menuOpen ? (
                <X aria-hidden="true" className="size-5" />
              ) : (
                <Menu aria-hidden="true" className="size-5" />
              )}
            </button>
          </div>
        </div>

        {menuOpen ? (
          <nav
            id="public-mobile-menu"
            aria-label="Main"
            className="border-t border-line bg-surface md:hidden"
          >
            <ul className="px-4 py-2">
              {LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2.5 text-sm text-ink-muted transition-colors hover:bg-surface-muted"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
              <li className="border-t border-line pt-2 sm:hidden">
                <NavLink
                  to="/login"
                  onClick={() => setMenuOpen(false)}
                  className="block rounded-lg px-3 py-2.5 text-sm font-medium text-brand-700"
                >
                  Sign in
                </NavLink>
              </li>
            </ul>
          </nav>
        ) : null}
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1">
        {children}
      </main>

      <footer className="border-t border-line bg-navy-900 text-navy-200">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-4">
          <div className="md:col-span-2">
            <BrandMark tone="light" />
            <p className="mt-4 max-w-sm text-sm text-navy-300">
              Hospital management software for Indian healthcare providers, built with tenant
              isolation and an auditable security model from the first line of code.
            </p>
          </div>

          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white">Product</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {[
                { label: 'Features', href: '#features' },
                { label: 'Security', href: '#security' },
                { label: 'Pricing', href: '#pricing' },
                { label: 'FAQ', href: '#faq' },
              ].map((link) => (
                <li key={link.href}>
                  <a href={link.href} className="transition-colors hover:text-white">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white">Account</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <Link to="/login" className="transition-colors hover:text-white">
                  Sign in
                </Link>
              </li>
              <li>
                <Link to="/register" className="transition-colors hover:text-white">
                  Register your hospital
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-white/10">
          <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
            <p className="text-xs text-navy-300">
              © {new Date().getFullYear()} Infinigrow Softech. Infinigrow Hospital Cloud is a
              product of Infinigrow Softech.
            </p>
            <p className="mt-2 text-xs text-navy-400">
              Demonstration software. Hospital, staff and patient details shown anywhere in this
              product are fictional.
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}

/** Consistent section wrapper: vertical rhythm, optional tint, labelled heading. */
export function Section({
  id,
  title,
  description,
  children,
  tone = 'default',
  className,
}: {
  id?: string
  title?: string
  description?: string
  children: ReactNode
  tone?: 'default' | 'muted' | 'navy'
  className?: string
}) {
  const toneClass = {
    default: 'bg-surface',
    muted: 'bg-canvas',
    navy: 'bg-navy-900 text-navy-100',
  }[tone]

  return (
    <section id={id} className={cn('scroll-mt-16 py-16 sm:py-20', toneClass, className)}>
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        {title ? (
          <div className="max-w-2xl">
            <h2
              className={cn('text-2xl font-semibold sm:text-3xl', tone === 'navy' && 'text-white')}
            >
              {title}
            </h2>
            {description ? (
              <p
                className={cn(
                  'mt-3 text-base',
                  tone === 'navy' ? 'text-navy-200' : 'text-ink-muted',
                )}
              >
                {description}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className={cn(title && 'mt-10')}>{children}</div>
      </div>
    </section>
  )
}
