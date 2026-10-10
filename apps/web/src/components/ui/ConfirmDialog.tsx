import type { ReactNode } from 'react'

import { Button } from './Button.js'
import { Modal } from './Modal.js'

/**
 * Confirmation dialog for irreversible or disruptive actions.
 *
 * The destructive action is styled and labelled as destructive, and the confirm button
 * keeps the action name ("Suspend hospital") rather than a bare "Confirm" — "Confirm"
 * leaves someone unsure what they are agreeing to, which is how accidents happen when a
 * dialog appears over an unexpected row.
 *
 * Focus safety: the modal focuses its container rather than the confirm button, so a
 * stray Enter while reading the description cannot perform a destructive action. The
 * user must move focus deliberately to the confirm button.
 *
 * Repeat submission is prevented by the `busy` flag while the request is in flight, not
 * by a local "acknowledged" flag — a second click during flight is disabled at the
 * button, and a second click afterwards is simply a fresh intent.
 */
export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** Destructive styling for irreversible actions. */
  destructive?: boolean
  /** True while the action is in flight; locks the dialog against a double submit. */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={destructive ? 'This action cannot be undone.' : undefined}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            busy={busy}
            busyLabel={`${confirmLabel}, please wait`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink-muted">{description}</div>
    </Modal>
  )
}
