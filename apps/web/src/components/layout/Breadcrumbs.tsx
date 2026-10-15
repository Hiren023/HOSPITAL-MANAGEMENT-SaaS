import { ChevronRight, Home } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'

import { cn } from '../../lib/cn.js'

/**
 * Breadcrumb trail.
 *
 * `nav` + `aria-label` identifies it as navigation and separates it from the page's main
 * navigation for screen-reader users. Only the final item is a link: the earlier ones
 * are ancestors already reached, and making them current-page-adjacent links produces a
 * confusing set of nested navigation regions.
 *
 * The current page is marked `aria-current="page"`.
 */
export interface Crumb {
  label: string
  to?: string
}

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  const location = useLocation()

  // If a screen supplies no items, derive a minimal trail from the path so the header is
  // never left without orientation.
  const crumbs =
    items.length > 0
      ? items
      : location.pathname
          .split('/')
          .filter(Boolean)
          .map((segment, index, all) => ({
            label: segment.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
            to: `/${all.slice(0, index + 1).join('/')}`,
          }))

  if (crumbs.length === 0) return null

  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0', className)}>
      <ol className="flex flex-wrap items-center gap-1 text-xs text-body-subtle">
        <li className="flex items-center">
          <Link
            to="/dashboard"
            aria-label="Home"
            className="flex items-center gap-1 rounded transition-colors hover:text-body"
          >
            <Home aria-hidden="true" className="size-3.5" />
          </Link>
        </li>

        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1

          return (
            <li key={`${crumb.to ?? crumb.label}`} className="flex min-w-0 items-center gap-1">
              <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-body-subtle" />
              {isLast || !crumb.to ? (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className="truncate font-medium text-body-muted"
                >
                  {crumb.label}
                </span>
              ) : (
                <Link
                  to={crumb.to}
                  className="truncate transition-colors hover:text-body hover:underline"
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
