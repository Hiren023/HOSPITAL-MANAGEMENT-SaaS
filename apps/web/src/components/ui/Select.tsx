import { forwardRef, type SelectHTMLAttributes } from 'react'

import { cn } from '../../lib/cn.js'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

/**
 * Native `<select>`.
 *
 * Deliberately native rather than a custom listbox: on a phone a native picker is
 * faster and more accessible than any custom menu, and on desktop it inherits correct
 * keyboard behaviour for free. Styling the wrapper keeps it visually on-brand without
 * replacing the control that people already know how to use.
 */
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean
  options: SelectOption[]
  /** Renders a disabled first option as the prompt, e.g. "Select a department". */
  placeholder?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, options, placeholder, className, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'w-full appearance-none rounded-lg border bg-white py-2 pl-3 pr-9 text-sm text-body ' +
            'transition-colors focus:border-infini-600 disabled:cursor-not-allowed ' +
            'disabled:bg-surface-muted disabled:text-body-subtle',
          invalid
            ? 'border-danger focus:border-danger'
            : 'border-line-strong focus:border-infini-600',
          className,
        )}
        {...props}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 fill-none stroke-body-subtle stroke-2"
      >
        <path d="m6 8 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
})
