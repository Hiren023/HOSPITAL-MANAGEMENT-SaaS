import type { ReactNode } from 'react'

import { cn } from '../../lib/cn.js'

/**
 * Data table.
 *
 * Accessibility decisions that are easy to get wrong:
 *  - a `<caption>` naming the table, which is the first thing a screen reader reads and
 *    the only way a sighted user with a caption visible understands the same thing;
 *  - `scope="col"` on headers so navigation announces "Appointments, column 3 of 6";
 *  - a scroll container that is keyboard-reachable, because a table clipped by a phone
 *    viewport is otherwise content nobody can reach at all.
 *
 * The caption is visually hidden by default but can be shown; clinical lists often need
 * the visible form and it is one prop away.
 */
export interface Column<TItem> {
  key: string
  header: ReactNode
  /** Renders the cell. */
  cell: (item: TItem) => ReactNode
  /** Right-align numeric and money columns. */
  numeric?: boolean
  /** Hidden below `md` on narrow screens — secondary detail, not lost. */
  secondary?: boolean
  className?: string
}

export interface DataTableProps<TItem> {
  caption: string
  showCaption?: boolean
  columns: Column<TItem>[]
  items: readonly TItem[]
  rowKey: (item: TItem) => string
  onRowClick?: (item: TItem) => void
  empty?: ReactNode
  /** Describes the sort currently applied, for screen readers. */
  sortLabel?: string
  className?: string
}

export function DataTable<TItem>({
  caption,
  showCaption = false,
  columns,
  items,
  rowKey,
  onRowClick,
  empty,
  className,
}: DataTableProps<TItem>) {
  return (
    <div
      className={cn('overflow-x-auto', className)}
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table className="w-full min-w-max border-collapse text-sm">
        <caption
          className={cn(
            'text-left text-sm font-medium text-body',
            showCaption ? 'px-5 pb-2' : 'sr-only',
          )}
        >
          {caption}
        </caption>
        <thead>
          <tr className="border-b border-line">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-body-subtle',
                  column.numeric ? 'text-right' : 'text-left',
                  column.secondary && 'hidden md:table-cell',
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-12 text-center">
                {empty ?? <span className="text-sm text-body-muted">No records found.</span>}
              </td>
            </tr>
          ) : (
            items.map((item) => (
              <tr
                key={rowKey(item)}
                onClick={onRowClick ? () => onRowClick(item) : undefined}
                className={cn(
                  'border-b border-line last:border-0',
                  onRowClick &&
                    'cursor-pointer transition-colors hover:bg-surface-muted focus-within:bg-surface-muted',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      'px-3 py-2.5 align-middle text-body',
                      column.numeric ? 'text-right tabular-nums' : 'text-left',
                      column.secondary && 'hidden md:table-cell',
                    )}
                  >
                    {column.cell(item)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Placeholder rows shown while data loads, so the table does not jump when it arrives.
 *
 * It carries the same `region` role and the same accessible name as the populated table.
 * That continuity matters: a screen-reader user navigating by landmark finds the same
 * region before, during and after loading, instead of a region that appears from nowhere
 * once data arrives.
 */
export function TableSkeleton({
  rows = 5,
  columns,
  caption = 'Table',
}: {
  rows?: number
  columns: number
  caption?: string
}) {
  return (
    <div role="region" aria-label={caption} aria-busy="true" className="p-4">
      <p role="status" aria-live="polite" className="sr-only">
        Loading {caption}…
      </p>
      <div className="space-y-2.5" aria-hidden="true">
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div key={rowIndex} className="flex gap-4">
            {Array.from({ length: columns }, (_, columnIndex) => (
              <div
                key={columnIndex}
                className="h-4 flex-1 animate-pulse rounded bg-surface-muted"
                style={{ animationDelay: `${(rowIndex * columns + columnIndex) * 25}ms` }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
