import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '../ui/Button.js'
import { cn } from '../../lib/cn.js'

/**
 * Failure state.
 *
 * Errors are surfaced with a retry action rather than a dead end. Internal error
 * details are never displayed — the server only returns safe, user-facing messages
 * (docs/SECURITY.md R8).
 */
export interface ErrorStateProps {
  title?: string
  message?: string
  /** Show a retry control. Supply `onRetry` for it to do anything. */
  onRetry?: () => void
  retrying?: boolean
  children?: ReactNode
  className?: string
}

export function ErrorState({
  title = 'Something went wrong',
  message = 'We could not complete that request. Please try again.',
  onRetry,
  retrying = false,
  children,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-card border border-status-danger/30',
        'bg-status-danger/5 px-6 py-12 text-center',
        className,
      )}
    >
      <AlertTriangle aria-hidden="true" className="size-7 text-status-danger" />

      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="max-w-prose text-sm text-slate-700">{message}</p>

      {children}

      {onRetry ? (
        <div className="mt-2">
          <Button
            variant="secondary"
            onClick={onRetry}
            busy={retrying}
            busyLabel="Retrying…"
            leadingIcon={<RefreshCw aria-hidden="true" className="size-4" />}
          >
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  )
}