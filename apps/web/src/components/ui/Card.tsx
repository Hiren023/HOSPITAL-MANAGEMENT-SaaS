import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../../lib/cn.js'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-card border border-line bg-surface shadow-xs', className)}
      {...props}
    />
  )
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-navy-900">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center gap-2 border-t border-line px-5 py-3', className)}
      {...props}
    />
  )
}

/**
 * Statistic tile.
 *
 * Numbers come first in the DOM, then the label: the label is context for the figure,
 * and reading "42 appointments" out of context is meaningless to a screen reader.
 */
export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = 'default',
}: {
  label: string
  value: string | number
  hint?: string
  icon?: ReactNode
  tone?: 'default' | 'brand' | 'warning' | 'success'
}) {
  const toneClass = {
    default: 'text-navy-900',
    brand: 'text-brand-700',
    warning: 'text-warning',
    success: 'text-success',
  }[tone]

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</p>
          <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
          {hint ? <p className="mt-1 text-xs text-ink-muted">{hint}</p> : null}
        </div>
        {icon ? (
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"
          >
            {icon}
          </span>
        ) : null}
      </div>
    </Card>
  )
}
