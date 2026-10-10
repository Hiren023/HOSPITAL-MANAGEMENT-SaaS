import { ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '../../lib/cn.js'

/**
 * Pagination control.
 *
 * Page numbers are real `<button>`s so keyboard and screen-reader users can jump
 * directly, rather than "previous / next" alone which forces linear traversal through a
 * long list. The current page carries `aria-current="page"`, and a live region reports
 * the result range so a user knows what just changed after pressing a page button.
 */
export interface PaginationProps {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  /** Total records, used for the result summary. */
  total?: number
  className?: string
}

function pageWindow(page: number, pageCount: number): Array<number | 'gap'> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1)

  const pages = new Set<number>([1, pageCount, page, page - 1, page + 1])
  const sorted = [...pages]
    .filter((value) => value >= 1 && value <= pageCount)
    .sort((a, b) => a - b)

  const result: Array<number | 'gap'> = []
  let previous = 0
  for (const value of sorted) {
    if (previous && value - previous > 1) result.push('gap')
    result.push(value)
    previous = value
  }
  return result
}

export function Pagination({ page, pageCount, onPageChange, total, className }: PaginationProps) {
  if (pageCount <= 1) return null

  const pages = pageWindow(page, pageCount)

  const buttonClass =
    'flex size-9 items-center justify-center rounded-lg text-sm font-medium transition-colors ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600'

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex flex-wrap items-center justify-between gap-3', className)}
    >
      {typeof total === 'number' ? (
        <p aria-live="polite" className="text-xs text-ink-muted">
          Showing page {page} of {pageCount} · {total.toLocaleString('en-IN')} records
        </p>
      ) : (
        <span />
      )}

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Go to previous page"
          className={cn(
            buttonClass,
            'text-ink-muted hover:bg-surface-muted hover:text-ink disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </button>

        {pages.map((entry, index) =>
          entry === 'gap' ? (
            <span key={`gap-${index}`} aria-hidden="true" className="px-1 text-sm text-ink-subtle">
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              onClick={() => onPageChange(entry)}
              aria-label={`Go to page ${entry}`}
              aria-current={entry === page ? 'page' : undefined}
              className={cn(
                buttonClass,
                entry === page
                  ? 'bg-brand-700 text-white'
                  : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
              )}
            >
              {entry}
            </button>
          ),
        )}

        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          aria-label="Go to next page"
          className={cn(
            buttonClass,
            'text-ink-muted hover:bg-surface-muted hover:text-ink disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      </div>
    </nav>
  )
}
