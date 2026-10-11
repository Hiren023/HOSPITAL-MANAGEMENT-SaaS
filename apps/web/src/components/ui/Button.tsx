import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { forwardRef } from 'react'

import { cn } from '../../lib/cn.js'

/**
 * Button — the base interactive control for the whole product.
 *
 * Accessibility notes:
 *  - a real `<button>` element, so keyboard activation and focus work natively;
 *  - `disabled` is reflected via `aria-disabled` and the `disabled` attribute;
 *  - `busy` announces a pending state without removing the label, which would
 *    otherwise confuse screen-reader users mid-action.
 */

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ' +
    'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-brand-700 text-white hover:bg-brand-800 active:bg-brand-900',
        secondary:
          'bg-white text-navy-800 ring-1 ring-line-strong hover:bg-surface-muted active:bg-[var(--color-canvas)]',
        ghost: 'text-ink-muted hover:bg-surface-muted hover:text-ink',
        danger: 'bg-danger text-white hover:brightness-95 active:brightness-90',
        outline:
          'bg-transparent text-brand-700 ring-1 ring-brand-300 hover:bg-brand-50 active:bg-brand-100',
        link: 'text-brand-700 underline underline-offset-4 hover:text-brand-800',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
      },
      full: {
        true: 'w-full',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a pending state and prevents repeat submission. */
  busy?: boolean
  /** Accessible announcement of the pending state. */
  busyLabel?: string
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
}

export const Button = forwardRef(function Button(
  {
    variant,
    size,
    full,
    busy = false,
    busyLabel = 'Working…',
    leadingIcon,
    trailingIcon,
    disabled,
    className,
    children,
    type = 'button',
    ...props
  }: ButtonProps,
  ref: Ref<HTMLButtonElement>,
) {
  const isDisabled = disabled === true || busy

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={busy || undefined}
      aria-disabled={isDisabled || undefined}
      className={cn(buttonVariants({ variant, size, full }), className)}
      {...props}
    >
      {busy ? (
        <>
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          <span className="sr-only">{busyLabel}</span>
        </>
      ) : (
        leadingIcon
      )}
      <span className={cn(busy && 'opacity-70')}>{children}</span>
      {!busy && trailingIcon}
    </button>
  )
})
