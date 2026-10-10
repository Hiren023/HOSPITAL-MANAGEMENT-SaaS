import type { ReactNode } from 'react'

import { cn } from '../../lib/cn.js'

/**
 * Empty state.
 *
 * Every list view in this product must offer a real next action, or explain why there
 * is nothing to show. A blank screen is never acceptable
 * (docs/PROJECT_PROPOSAL.md rule 8).
 */
export interface EmptyStateProps {
  title: string
  description?: string
  icon?: ReactNode
  /** A genuine, wired-up action. Omit only when no action makes sense. */
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-card border border-line',
        'bg-surface px-6 py-14 text-center',
        className,
      )}
    >
      {icon ? <div className="text-ink-subtle">{icon}</div> : null}

      <h3 className="text-base font-semibold text-navy-900">{title}</h3>

      {description ? <p className="max-w-prose text-sm text-ink-muted">{description}</p> : null}

      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
