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

/**
 * The base appearance of a text field.
 *
 * Shared with `Select` and `Textarea`, which inline the equivalent list — they cannot use
 * this directly because their own padding differs (`pl-3 pr-9` for a select, so the
 * chevron does not sit on top of the option text).
 *
 * **This must be applied by the component, not by the caller.**
 *
 * It previously was exported and then never used — the element rendered with only a
 * border colour, so every text input in the product was a bare browser control at default
 * width with default padding and default font. The constant sat there looking correct and
 * no test failed, because jsdom does not apply Tailwind and an unstyled input still accepts
 * and echoes a value. Only a human looking at a rendered page could see it.
 */
export const inputBaseClasses =
  'w-full rounded-lg border bg-white px-3 py-2 text-sm text-body placeholder:text-body-subtle ' +
  'transition-colors focus:border-infini-600 disabled:cursor-not-allowed disabled:bg-surface-muted ' +
  'disabled:text-body-subtle'

/**
 * Padding that makes room for an adornment.
 *
 * Without this the absolutely-positioned icon is drawn **on top of the typed value**, which
 * on a password field means a padlock sitting across the characters someone is entering.
 * Adornment padding is applied here rather than by each caller so a new field with an icon
 * cannot forget it.
 */
const leadingClasses = 'pl-9'
const trailingClasses = 'pr-10'

const stateClasses = (invalid: boolean | undefined) =>
  invalid ? 'border-danger focus:border-danger' : 'border-line-strong focus:border-infini-600'

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, trailing, leading, type = 'text', ...props },
  ref,
) {
  const field = (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        inputBaseClasses,
        // `type` is destructured above only so it can sit in a stable position; the browser
        // default is already `text`, and restating it keeps the rendered markup honest when
        // a caller omits it.
        leading ? leadingClasses : null,
        trailing ? trailingClasses : null,
        stateClasses(invalid),
        // Last, so a caller can override anything above. `cn` uses `tailwind-merge`, which
        // resolves conflicts by utility rather than by the order they happen to appear in
        // the stylesheet — so `px-2` here genuinely beats the base `px-3`.
        className,
      )}
      {...props}
    />
  )

  if (!leading && !trailing) return field

  return (
    <div className="relative flex items-center">
      {leading ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 flex items-center text-body-subtle"
        >
          {leading}
        </span>
      ) : null}
      {field}
      {trailing ? (
        <span className="absolute right-2 flex items-center text-body-subtle">{trailing}</span>
      ) : null}
    </div>
  )
})