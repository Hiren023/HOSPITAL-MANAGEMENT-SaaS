import { cn } from '../../lib/cn.js'

/**
 * Loading state.
 *
 * A skeleton communicates the shape of the content being loaded, which is less jarring
 * than a spinner and avoids layout shift when the data arrives.
 */
export interface LoadingStateProps {
  /** Number of placeholder rows. */
  rows?: number
  /** Accessible announcement; visible to screen readers only. */
  label?: string
  className?: string
}

export function LoadingState({ rows = 3, label = 'Loading…', className }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn('rounded-card border border-border-subtle bg-white p-6', className)}
    >
      <span className="sr-only">{label}</span>

      <div aria-hidden="true" className="space-y-3">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <div className="size-9 shrink-0 animate-pulse rounded-full bg-slate-200" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-2/5 animate-pulse rounded bg-slate-200" />
              <div className="h-3 w-3/5 animate-pulse rounded bg-slate-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}