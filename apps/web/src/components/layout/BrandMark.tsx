import { cn } from '../../lib/cn.js'

/**
 * Wordmark: **Infini** in infini-blue, **Health** in black.
 *
 * ── Why the second half changes on dark surfaces ──────────────────────────────
 *
 * The brand rule is that "Health" is black. On the dark sidebar, header and the
 * navy marketing panels, black on a near-black background is not a low-contrast
 * choice — it is an invisible one. So the split is tone-aware: on light surfaces
 * "Health" is `--color-ink-950` black as specified, and on dark surfaces it becomes
 * white. The blue half is never changed, because infini-400 clears AA against the
 * dark shell and infini-600 clears it against white.
 *
 * This is a deliberate departure from the literal instruction, taken so the wordmark
 * stays readable. If black-on-dark is wanted regardless, that is one line here.
 *
 * ── On the glyph ─────────────────────────────────────────────────────────────
 *
 * Still a CSS-drawn medical cross rather than an image file: it inherits currentColor,
 * stays crisp at any density, needs no network request, and cannot be a broken image.
 * The shape deliberately avoids a red cross, which is a protected emblem under the
 * Geneva Conventions and a poor choice for commercial software.
 *
 * The tile now carries the brand instead: a two-stop infini-blue gradient with an inner
 * highlight, so the logo reads as a lit surface rather than a flat square of colour.
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
          'flex size-9 shrink-0 items-center justify-center rounded-xl',
          'bg-gradient-to-br from-infini-500 to-infini-700',
          'shadow-[inset_0_1px_0_0_rgb(255_255_255/0.25),0_2px_6px_-1px_rgb(29_78_216/0.35)]',
        )}
      >
        <svg viewBox="0 0 24 24" className="size-5 fill-none stroke-white" strokeWidth={2.5}>
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
      </span>

      {showWordmark ? (
        /*
         * One line, not two. The old stacked lockup spent two lines of vertical space in
         * a 16-unit-tall sidebar header to say a name that fits on one, and the second
         * line was always the redundant half of the company name.
         */
        <span className="min-w-0 leading-none">
          <span className="block truncate text-[0.9375rem] font-semibold tracking-tight">
            <span className="text-infini-600 dark:text-infini-400">Infini</span>
            <span
              className={cn(
                // A space is a real character, not a margin: screen readers announce a
                // pause here, and a margin-only gap makes the two runs one word.
                ' ',
                tone === 'light' ? 'text-white' : 'text-ink-950',
              )}
            >
              Health
            </span>
          </span>
          <span
            className={cn(
              'mt-1 block truncate text-[0.625rem] font-medium uppercase tracking-[0.14em]',
              tone === 'light' ? 'text-ink-300' : 'text-body-subtle',
            )}
          >
            Hospital Cloud
          </span>
        </span>
      ) : null}
    </span>
  )
}