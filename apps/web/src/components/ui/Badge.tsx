import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'

import { cn } from '../../lib/cn.js'

/**
 * Status indicator.
 *
 * Colour alone is never the signal — every badge carries its own text, and the semantic
 * variants are reserved for state. A red badge always means "needs attention", so it
 * never becomes decoration. Roughly one in twelve men has a red–green colour vision
 * deficiency, which is exactly the demographic most likely to be reading a triage board.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-muted text-body-muted ring-1 ring-line',
        brand: 'bg-infini-50 text-infini-800 ring-1 ring-infini-200',
        success:
          'bg-[var(--color-success-bg)] text-[oklch(0.36_0.11_155)] ring-1 ring-[oklch(0.85_0.06_155)]',
        warning:
          'bg-[var(--color-warning-bg)] text-[oklch(0.42_0.11_75)] ring-1 ring-[oklch(0.87_0.07_85)]',
        danger:
          'bg-[var(--color-danger-bg)] text-[oklch(0.4_0.15_25)] ring-1 ring-[oklch(0.88_0.05_25)]',
        info: 'bg-[var(--color-info-bg)] text-[oklch(0.4_0.1_245)] ring-1 ring-[oklch(0.86_0.05_250)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Adds a leading dot — decorative only; the text still carries the meaning. */
  dot?: boolean
}

export function Badge({ tone, dot, className, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  )
}

/** Hospital and account lifecycle states, mapped to a single visual language. */
const HOSPITAL_STATUS: Record<string, { label: string; tone: BadgeProps['tone'] }> = {
  PENDING: { label: 'Pending approval', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  SUSPENDED: { label: 'Suspended', tone: 'danger' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  ARCHIVED: { label: 'Archived', tone: 'neutral' },
}

const USER_STATUS: Record<string, { label: string; tone: BadgeProps['tone'] }> = {
  INVITED: { label: 'Invited', tone: 'info' },
  PENDING_VERIFICATION: { label: 'Awaiting verification', tone: 'warning' },
  ACTIVE: { label: 'Active', tone: 'success' },
  SUSPENDED: { label: 'Suspended', tone: 'danger' },
  DISABLED: { label: 'Disabled', tone: 'neutral' },
}

export function HospitalStatusBadge({ status }: { status: string }) {
  const config = HOSPITAL_STATUS[status] ?? { label: status, tone: 'neutral' as const }
  return (
    <Badge tone={config.tone} dot>
      {config.label}
    </Badge>
  )
}

export function UserStatusBadge({ status }: { status: string }) {
  const config = USER_STATUS[status] ?? { label: status, tone: 'neutral' as const }
  return (
    <Badge tone={config.tone} dot>
      {config.label}
    </Badge>
  )
}

/** Human label for a role, since the wire format is SCREAMING_SNAKE_CASE. */
const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Platform administrator',
  HOSPITAL_ADMIN: 'Hospital administrator',
  DOCTOR: 'Doctor',
  RECEPTIONIST: 'Receptionist',
  STAFF: 'Staff',
  PHARMACIST: 'Pharmacist',
  ACCOUNTANT: 'Accountant',
  PATIENT: 'Patient',
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}

export function RoleBadge({ role }: { role: string }) {
  return <Badge tone={role === 'SUPER_ADMIN' ? 'brand' : 'neutral'}>{roleLabel(role)}</Badge>
}
