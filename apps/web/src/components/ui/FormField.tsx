import { useId, type ReactNode } from 'react'

import { cn } from '../../lib/cn.js'

/**
 * Form field wrapper: label, control, hint and error, wired together for assistive
 * technology.
 *
 * The wiring is the point. A red border alone tells a sighted user something is wrong;
 * a screen-reader user needs the message to be programmatically attached to the input.
 * Generating ids with `useId` and pointing `aria-describedby` at the hint *and* the
 * error means the control announces "Department, required, invalid entry, Choose the
 * owning department" — so the error is not only visible, it is perceivable.
 */
export interface FormFieldProps {
  label: string
  /** Validation message. Presence switches the field to its invalid styling. */
  error?: string | undefined
  /** Supplementary guidance, always announced. */
  hint?: ReactNode
  required?: boolean
  /** Receives the generated ids so the control can bind itself to them. */
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode
  className?: string
  /** Label laid out above (default) or beside the control. */
  layout?: 'stacked' | 'inline'
}

export function FormField({
  label,
  error,
  hint,
  required = false,
  children,
  className,
  layout = 'stacked',
}: FormFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`

  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined

  return (
    <div
      className={cn(
        layout === 'inline' ? 'sm:grid sm:grid-cols-3 sm:gap-4 sm:items-start' : '',
        className,
      )}
    >
      <div className={cn(layout === 'inline' ? 'sm:pt-2' : 'mb-1.5')}>
        <label htmlFor={id} className="block text-sm font-medium text-body">
          {label}
          {required ? (
            <>
              <span aria-hidden="true" className="ml-0.5 text-danger">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </>
          ) : null}
        </label>
        {hint ? (
          <p id={hintId} className="mt-1 text-xs text-body-subtle">
            {hint}
          </p>
        ) : null}
      </div>

      <div className={cn(layout === 'inline' && 'sm:col-span-2')}>
        {children({ id, describedBy, invalid: Boolean(error) })}

        {/* `role="alert"` so a validation failure is announced when it appears. */}
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="mt-1.5 flex items-start gap-1.5 text-xs text-danger"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="mt-px size-3.5 shrink-0 fill-current"
            >
              <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7.25 4.5h1.5v4.75h-1.5V4.5ZM8 11.75a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z" />
            </svg>
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
