import { cn } from '../../lib/cn.js'

/**
 * Wordmark.
 *
 * A CSS-drawn glyph rather than an image file: it inherits `currentColor`, stays crisp at
 * every density, needs no network request, and cannot be a broken image. The shape is a
 * cross formed by two rounded bars — a nod to medical signage without resorting to a red
 * cross, which is a protected emblem under the Geneva Conventions and would be a poor
 * choice for commercial software.
 */
export function BrandMark({
  tone = 'dark',
  showWordmark = true,
  className,
}: {
  tone?: 'dark' | 'light'
  showWordmark?: boolean
  className?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg',
          tone === 'light' ? 'bg-brand-500' : 'bg-brand-700',
        )}
      >
        <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-white" strokeWidth={2.5}>
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
      </span>
      {showWordmark ? (
        <span className="min-w-0 leading-tight">
          <span
            className={cn(
              'block truncate text-sm font-semibold tracking-tight',
              tone === 'light' ? 'text-white' : 'text-navy-900',
            )}
          >
            Infinigrow
          </span>
          <span
            className={cn(
              'block truncate text-[0.625rem] font-medium uppercase tracking-wider',
              tone === 'light' ? 'text-navy-300' : 'text-ink-subtle',
            )}
          >
            Hospital Cloud
          </span>
        </span>
      ) : null}
    </span>
  )
}
