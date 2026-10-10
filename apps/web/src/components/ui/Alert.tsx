import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../../lib/cn.js'

/**
 * Inline alert.
 *
 * `role="alert"` for anything that reports a failure the person must notice, and
 * `role="status"` for neutral information, which is polite and does not interrupt. Using
 * `alert` for a success message makes screen readers interrupt whatever the user was
 * doing to announce something they did not need interrupting about.
 */
const alertVariants = cva('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', {
  variants: {
    tone: {
      info: 'border-[oklch(0.86_0.05_250)] bg-[var(--color-info-bg)] text-[oklch(0.32_0.08_245)]',
      success:
        'border-[oklch(0.85_0.06_155)] bg-[var(--color-success-bg)] text-[oklch(0.33_0.09_155)]',
      warning:
        'border-[oklch(0.87_0.07_85)] bg-[var(--color-warning-bg)] text-[oklch(0.36_0.1_75)]',
      danger: 'border-[oklch(0.88_0.05_25)] bg-[var(--color-danger-bg)] text-[oklch(0.35_0.14_25)]',
    },
  },
  defaultVariants: { tone: 'info' },
})

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
} as const

export interface AlertProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'title'>, VariantProps<typeof alertVariants> {
  title?: ReactNode
  /** Dismiss control, rendered as an accessible button. */
  onDismiss?: () => void
}

export function Alert({
  tone = 'info',
  title,
  onDismiss,
  className,
  children,
  ...props
}: AlertProps) {
  const Icon = ICONS[tone ?? 'info']
  const assertive = tone === 'danger' || tone === 'warning'

  return (
    <div
      role={assertive ? 'alert' : 'status'}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      <Icon aria-hidden="true" className="mt-px size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && 'mt-0.5')}>{children}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss this message"
          className="-m-1 shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 fill-current">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}
