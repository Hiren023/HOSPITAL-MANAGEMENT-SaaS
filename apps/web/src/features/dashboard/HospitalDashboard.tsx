import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Bed,
  CalendarDays,
  ClipboardList,
  CreditCard,
  Lock,
  Receipt,
  Settings,
  Stethoscope,
  Timer,
  TrendingUp,
  UserCog,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import type { Permission } from '@infinigrow/shared'

import { useAuth } from '../../auth/auth-context.js'
import { hasAnyPermission, hasPermission } from '../../auth/session.js'
import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge, RoleBadge, roleLabel } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { EmptyState } from '../../components/states/EmptyState.js'

interface ModuleCard {
  to: string
  label: string
  description: string
  icon: LucideIcon
  permission?: Permission
  permissions?: Permission[]
}

/**
 * The full clinical surface, each entry gated on a permission.
 *
 * A module appears for a role only if the API would actually let that role use it. This
 * matters more than tidiness: a receptionist who is shown "Consultations" will reasonably
 * conclude the product lets them read clinical notes. It does not — `consultation:read`
 * is absent from the receptionist and accountant roles on purpose
 * (docs/SECURITY.md R9).
 */
const MODULES: ModuleCard[] = [
  {
    to: '/patients',
    label: 'Patients',
    description: 'Registration, demographics and history.',
    icon: Users,
    permission: 'patient:read',
  },
  {
    to: '/appointments',
    label: 'Appointments',
    description: 'Schedule, reschedule and confirm visits.',
    icon: CalendarDays,
    permission: 'appointment:read',
  },
  {
    to: '/consultations',
    label: 'Consultations',
    description: 'Clinical encounters and notes.',
    icon: Stethoscope,
    permissions: ['consultation:read'],
  },
  {
    to: '/prescriptions',
    label: 'Prescriptions',
    description: 'Issue and review medication orders.',
    icon: ClipboardList,
    permissions: ['prescription:read'],
  },
  {
    to: '/departments',
    label: 'Departments',
    description: 'Clinical departments and their leads.',
    icon: Bed,
    permission: 'department:read',
  },
  {
    to: '/billing',
    label: 'Billing',
    description: 'Invoices and outstanding balances.',
    icon: Receipt,
    permission: 'billing:read',
  },
  {
    to: '/payments',
    label: 'Payments',
    description: 'Record and reconcile collections.',
    icon: Wallet,
    permission: 'payment:read',
  },
  {
    to: '/reports',
    label: 'Reports',
    description: 'Operational and financial reporting.',
    icon: TrendingUp,
    permission: 'report:read',
  },
  {
    to: '/attendance',
    label: 'Attendance',
    description: 'Shift and attendance records.',
    icon: Timer,
    permission: 'attendance:read',
  },
  {
    to: '/users',
    label: 'Staff & users',
    description: 'Accounts, roles and permissions.',
    icon: UserCog,
    permission: 'user:read',
  },
  {
    to: '/settings/hospital',
    label: 'Hospital settings',
    description: 'Profile, registration and configuration.',
    icon: Settings,
    permission: 'hospital:settings:manage',
  },
]

/**
 * Hospital dashboard.
 *
 * Everything on this screen comes from the session the server issued — role, hospital,
 * permission set — rather than from a role-name switch in the frontend. The module cards
 * below are therefore the same list the API will enforce, not a parallel guess.
 *
 * Clinical modules ship in later phases. Those cards are shown as clearly-labelled
 * placeholders rather than filled with invented figures: sample patient counts would look
 * real, could be mistaken for a live count during a drill, and would hide the fact that
 * the underlying endpoints do not exist yet.
 */
export function HospitalDashboard() {
  const { user } = useAuth()

  const available = useMemo(() => {
    if (!user) return []
    return MODULES.filter((module) => {
      if (module.permission) return hasPermission(user, module.permission)
      if (module.permissions) return hasAnyPermission(user, module.permissions)
      return true
    })
  }, [user])

  const withheld = useMemo(() => {
    if (!user) return []
    return MODULES.filter((module) => {
      if (module.permission) return !hasPermission(user, module.permission)
      if (module.permissions) return !hasAnyPermission(user, module.permissions)
      return false
    })
  }, [user])

  const isClinical = user?.role === 'DOCTOR'

  return (
    <AppShell title={`Welcome, ${user?.firstName ?? ''}`} breadcrumbs={[{ label: 'Dashboard' }]}>
      <div className="space-y-5">
        {/* First sign-in notice: an unverified address is a real risk, not decoration. */}
        {user && !user.emailVerified ? (
          <Alert tone="warning" title="Email address not yet verified">
            Some features stay unavailable until {user.email} is verified. Contact your hospital
            administrator if you are not receiving the verification message.
          </Alert>
        ) : null}

        <Card>
          <CardBody>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Hospital
                </p>
                <p className="mt-1 text-lg font-semibold text-navy-900">
                  {user?.hospitalName ?? '—'}
                </p>
                <p className="mt-0.5 font-mono text-xs text-ink-subtle">{user?.hospitalId}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <RoleBadge role={user?.role ?? ''} />
                <Badge tone="neutral">{user?.permissions.length ?? 0} permissions</Badge>
              </div>
            </div>
          </CardBody>
        </Card>

        {isClinical ? (
          <Alert tone="info" title="Clinical module">
            Consultation and prescription entries are part of the clinical phase and will be
            connected to live endpoints before use.
          </Alert>
        ) : null}

        <Card>
          <CardHeader
            title="Your modules"
            description={`Everything your ${roleLabel(user?.role ?? '').toLowerCase()} role can open in this hospital.`}
          />
          <CardBody>
            {available.length === 0 ? (
              <EmptyState
                title="No modules available"
                description="Your account does not yet hold any permissions in this hospital. Ask an administrator to assign a role."
              />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {available.map((module) => (
                  <li key={module.to}>
                    <ModuleTile module={module} />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {withheld.length > 0 ? (
          <Card>
            <CardHeader
              title="Not available to your role"
              description="These modules exist in the platform but are not part of your permissions."
            />
            <CardBody>
              <ul className="flex flex-wrap gap-2">
                {withheld.map((module) => (
                  <li key={module.to}>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-1 text-xs text-ink-subtle ring-1 ring-line">
                      <Lock aria-hidden="true" className="size-3" />
                      {module.label}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-subtle">
                The API refuses these requests independently of the interface, so hiding them here
                is presentation only.
              </p>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Your access" description="Granted by your hospital administrator." />
          <CardBody>
            <ul className="flex flex-wrap gap-1.5">
              {(user?.permissions ?? []).map((permission) => (
                <li key={permission}>
                  <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-ink-muted">
                    {permission}
                  </code>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </AppShell>
  )
}

function ModuleTile({ module }: { module: ModuleCard }) {
  return (
    <div className="flex h-full flex-col rounded-card border border-line bg-surface p-4 transition-shadow hover:shadow-xs">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"
        >
          <module.icon className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-navy-900">{module.label}</p>
          <p className="mt-0.5 text-xs text-ink-muted">{module.description}</p>
        </div>
      </div>

      <div className="mt-4 pt-1">
        <Link
          to={module.to}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 underline-offset-4 hover:underline"
        >
          Open
          <ArrowRight aria-hidden="true" className="size-3" />
        </Link>
      </div>
    </div>
  )
}

/**
 * Placeholder for a clinical module that has not been connected to a backend yet.
 *
 * Every module route in Phase 3 resolves here rather than to a blank screen or a stubbed
 * table. Saying plainly that the module is not yet available is honest; rendering fake
 * patients would not be (docs/PROJECT_PROPOSAL.md rule 16).
 */
export function ModulePlaceholder({
  title,
  permission,
}: {
  title: string
  permission?: Permission
}) {
  const { user } = useAuth()
  const permitted = user && permission ? hasPermission(user, permission) : true

  return (
    <AppShell title={title} breadcrumbs={[{ label: 'Dashboard' }, { label: title }]}>
      <EmptyState
        icon={
          permitted ? (
            <CreditCard aria-hidden="true" className="size-10" />
          ) : (
            <Lock aria-hidden="true" className="size-10" />
          )
        }
        title={
          permitted ? `${title} is not available yet` : 'You do not have access to this module'
        }
        description={
          permitted
            ? `${title} is being built and will be connected to its live API before release. No data is shown here because none has been implemented.`
            : 'Your role does not include this module. Ask a hospital administrator if you believe this is an error.'
        }
        action={
          permitted ? (
            <Link to="/dashboard">
              <Button variant="secondary">Back to dashboard</Button>
            </Link>
          ) : undefined
        }
      />
    </AppShell>
  )
}
