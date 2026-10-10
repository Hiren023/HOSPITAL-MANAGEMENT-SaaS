import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'

import { cn } from '../../lib/cn.js'

/**
 * Text input.
 *
 * The control itself carries no label logic — `FormField` owns labelling and passes the
 * generated id in. Keeping that in one place is what stops the classic accessibility bug
 * where a placeholder is used as the only label and disappears the moment someone types.
 */
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  /** Optional adornment rendered inside the field, e.g. a "show password" toggle. */
  trailing?: ReactNode
  leading?: ReactNode
}

export const inputBaseClasses =
  'w-full rounded-lg border bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-subtle ' +
  'transition-colors focus:border-brand-600 disabled:cursor-not-allowed disabled:bg-surface-muted ' +
  'disabled:text-ink-subtle'

const stateClasses = (invalid: boolean | undefined, className: string | undefined) =>
  cn(
    className,
    invalid ? 'border-danger focus:border-danger' : 'border-line-strong focus:border-brand-600',
  )

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, trailing, leading, ...props },
  ref,
) {
  const field = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={stateClasses(invalid, className)}
      {...props}
    />
  )

  if (!leading && !trailing) return field

  return (
    <div className="relative flex items-center">
      {leading ? (
        <span aria-hidden="true" className="pointer-events-none absolute left-3 text-ink-subtle">
          {leading}
        </span>
      ) : null}
      {field}
      {trailing ? <span className="absolute right-2 flex items-center">{trailing}</span> : null}
    </div>
  )
})
