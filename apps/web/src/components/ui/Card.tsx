import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'

import { cn } from '../../lib/cn.js'

/**
 * Panel — the base surface for every grouped block of content.
 *
 * Previously `shadow-xs` on a hairline border, which made every panel on the page read
 * as the same flat rectangle: a stat tile, a table and a settings block were visually
 * interchangeable. Now depth is deliberate, and the panel responds to the pointer.
 *
 * The border is kept. A shadow alone does not define an edge on a near-white canvas,
 * and dropping the border is what produces the "floating card" look that quietly costs
 * legibility on a dense clinical screen.
 *
 * `interactive` adds the hover lift. It is opt-in rather than automatic because a panel
 * full of records is a container, not a control — lifting on hover suggests it can be
 * clicked, which is a lie on most of them. Turn it on only where the whole panel really
 * is the target.
 */
export function Card({
  /** Removes the resting elevation — for a panel nested inside another panel. */
  flat = false,
  /** Adds the hover lift. Only for panels that are themselves clickable. */
  interactive = false,
  /** Index within a staggered group. 0 is the default. */
  stagger = 0,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  flat?: boolean
  interactive?: boolean
  stagger?: number
}) {
  return (
    <div
      style={stagger ? ({ '--stagger': stagger } as CSSProperties) : undefined}
      className={cn(
        'rounded-card border border-line bg-surface',
        flat ? 'bg-surface-muted/40' : 'shadow-panel',
        interactive && 'panel-lift cursor-pointer motion-reduce:transform-none',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Panel header.
 *
 * The title is `text-sm` because it is a label for a region, not the page's subject —
 * the `h1` above it already carries that. Bumping it larger competes with the page
 * heading, which is what made every card feel like it was shouting.
 */
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
        'flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-ink-900">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-body-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />
}

/**
 * Panel footer.
 *
 * Tinted rather than white so it reads as belonging to the panel. On a white footer a
 * horizontal rule was the only thing separating it from the body, and the footer read as
 * an empty strip rather than as the panel's closing edge.
 */
export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-b-card border-t border-line bg-surface-muted/60 px-5 py-3',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Statistic tile.
 *
 * Numbers come first in the DOM, then the label: the label is context for the figure,
 * and reading "42 appointments" out of context is meaningless to a screen reader.
 *
 * The leading accent rule is the one decorative element in the design system. It gives
 * the row of tiles a consistent left edge so the eye can scan the figures on one axis,
 * and it carries the tone so a warning figure is identifiable before the label is read.
 */
export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = 'default',
  stagger = 0,
}: {
  label: string
  value: string | number
  hint?: string
  icon?: ReactNode
  tone?: 'default' | 'brand' | 'warning' | 'success' | 'danger'
  /** Index within a staggered row, so a set of tiles arrives in sequence. */
  stagger?: number
}) {
  const toneClass = {
    default: 'text-ink-900',
    brand: 'text-infini-700',
    warning: 'text-warning',
    success: 'text-success',
    danger: 'text-danger',
  }[tone]

  const accentClass = {
    default: 'bg-line-strong',
    brand: 'bg-infini-500',
    warning: 'bg-warning',
    success: 'bg-success',
    danger: 'bg-danger',
  }[tone]

  return (
    <Card
      /*
       * Tiles enter, but they do not lift on hover. A stat tile is a read-out, and a
       * read-out that reacts to the pointer implies it is a link to somewhere. The
       * entry animation is the only motion here, which is enough to make a dashboard
       * feel assembled rather than dumped.
       */
      stagger={stagger}
      className="panel-enter overflow-hidden motion-reduce:transform-none"
    >
      <div className={cn('h-1 w-full', accentClass)} aria-hidden="true" />
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-body-subtle">
              {label}
            </p>
            <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
            {hint ? <p className="mt-1 text-xs text-body-muted">{hint}</p> : null}
          </div>
          {icon ? (
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-infini-50 text-infini-700"
            >
              {icon}
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  )
}
