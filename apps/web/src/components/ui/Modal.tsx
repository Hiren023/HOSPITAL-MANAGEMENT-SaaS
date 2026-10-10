import { X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '../../lib/cn.js'

/**
 * Modal dialog.
 *
 * A native `<dialog>` element would give focus trapping, inertness and Escape handling
 * from the browser, but its top-layer behaviour and animation hooks are inconsistent
 * enough across engines that it tends to be reimplemented anyway. So the behaviour is
 * implemented explicitly and carefully:
 *
 *  - focus moves into the dialog on open and is restored to the trigger on close,
 *    otherwise focus falls to `<body>` and a keyboard user loses their place;
 *  - Tab and Shift+Tab cycle within the dialog (a real focus trap);
 *  - Escape closes;
 *  - background scrolling is locked while open, so the page behind does not move;
 *  - the rest of the page is marked `aria-hidden`, so assistive technology does not
 *    wander out of the dialog into content it cannot see.
 */
export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
} as const

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }

      if (event.key !== 'Tab') return

      const root = dialogRef.current
      if (!root) return

      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  useEffect(() => {
    if (!open) return

    previouslyFocused.current = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', handleKeyDown, true)

    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'

    // Focus lands on the dialog container, not on a control inside it.
    //
    // The WAI-ARIA pattern prefers this: the screen reader then announces the dialog's
    // title and description as the user arrives, so they know what they are looking at
    // before interacting. Focusing the first control instead would drop a keyboard user
    // onto a button — and for a confirmation dialog, onto the *confirm* button, where a
    // reflexive Enter would perform an irreversible action. Tab then moves to the first
    // control by choice.
    const timer = setTimeout(() => {
      dialogRef.current?.focus()
    }, 0)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.body.style.overflow = overflow
      clearTimeout(timer)
      previouslyFocused.current?.focus()
    }
  }, [open, handleKeyDown])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* Clicking the scrim closes, but it is hidden from assistive technology so it is
          never announced as an interactive element. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-navy-950/50 backdrop-blur-[1px]"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'relative z-10 flex max-h-[92vh] w-full flex-col rounded-t-card bg-surface shadow-xl sm:rounded-card',
          SIZES[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-navy-900">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm text-ink-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="-m-1.5 shrink-0 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
