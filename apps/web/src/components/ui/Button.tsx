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
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-infini-600 ' +
    'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        /*
         * Every solid variant is 3D and carries its own `--btn-edge`, which MUST be the
         * pressed shade of that same variant. An edge borrowed from another colour is
         * what makes a 3D button read as two unrelated shapes stacked rather than as one
         * object: a blue face over a grey base, pressed at the same time.
         *
         * The face gradient runs light at the top to dark at the bottom, on the
         * assumption of a light source above. A flat face cannot produce this effect at
         * all, because there is nothing for the highlight to sit on.
         */
        primary:
          'btn-3d btn-sheen bg-gradient-to-b from-infini-600 to-infini-700 text-white ' +
          'hover:from-infini-600 hover:to-infini-800 active:from-infini-700 active:to-infini-900',
        secondary:
          'btn-3d bg-gradient-to-b from-white to-surface-muted text-ink-800 ring-1 ring-line-strong ' +
          'hover:from-white hover:to-line',
        danger:
          'btn-3d bg-gradient-to-b from-danger to-[color-mix(in_oklab,var(--color-danger)_88%,black)] text-white',
        ghost:
          'text-body-muted hover:bg-surface-muted hover:text-body',
        outline:
          'bg-transparent text-infini-700 ring-1 ring-infini-300 hover:bg-infini-50 active:bg-infini-100',
        link: 'text-infini-700 underline underline-offset-4 hover:text-infini-800',
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

/**
 * The hard edge beneath each 3D face.
 *
 * Declared here rather than baked into `buttonVariants` because it is a custom property
 * and Tailwind has no utility for setting one. Each value is the variant's own darkest
 * stop, so pressing a button always consumes an edge of its own colour.
 */
const EDGE: Partial<Record<NonNullable<ButtonVariant>, string>> = {
  primary: '[--btn-edge:var(--color-infini-900)]',
  secondary: '[--btn-edge:var(--color-line)]',
  danger: '[--btn-edge:var(--color-danger)]',
}

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a pending state and prevents repeat submission. */
  busy?: boolean
  /** Accessible announcement of the pending state. */
  busyLabel?: string
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
}

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>

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
      /*
       * `motion-reduce:transform-none` on the host as well as inside the media query,
       * because the media query targets the hover/active states and a press starts from
       * the base transform. Without this, the first frame of a keyboard press still
       * displaces the button.
       *
       * The custom property is applied last so a caller's `className` cannot accidentally
       * override the edge colour with a mismatched one.
       */
      className={cn(
        buttonVariants({ variant, size, full }),
        variant ? EDGE[variant] : undefined,
        'motion-reduce:transform-none',
        className,
      )}
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
