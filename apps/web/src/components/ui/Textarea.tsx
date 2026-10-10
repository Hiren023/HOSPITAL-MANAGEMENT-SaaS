import { forwardRef, type TextareaHTMLAttributes } from 'react'

import { cn } from '../../lib/cn.js'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, rows = 4, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full rounded-lg border bg-white px-3 py-2 text-sm text-ink ' +
          'placeholder:text-ink-subtle transition-colors focus:border-brand-600 ' +
          'disabled:cursor-not-allowed disabled:bg-surface-muted',
        invalid ? 'border-danger focus:border-danger' : 'border-line-strong focus:border-brand-600',
        className,
      )}
      {...props}
    />
  )
})
