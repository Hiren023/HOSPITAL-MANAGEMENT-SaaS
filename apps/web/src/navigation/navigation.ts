import type { Permission } from '@infinigrow/shared'
import {
  Bed,
  CalendarDays,
  ClipboardList,
  FileText,
  LayoutDashboard,
  Receipt,
  ScrollText,
  Settings,
  ShieldCheck,
  Stethoscope,
  Timer,
  TrendingUp,
  UserCog,
  Users,
  Wallet,
  Building2,
  type LucideIcon,
} from 'lucide-react'

import { hasAnyPermission, hasPermission, type SessionUser } from '../auth/session.js'

/**
 * Navigation is derived from PERMISSIONS, not from the role name.
 *
 * A membership may be granted a custom subset of its role's ceiling, so keying the menu
 * off `user.role` would show a receptionist billing screens on one account and hide them
 * on another with identical permissions. Keying off the granted permission set means the
 * menu always matches what the API will actually allow
 * (docs/ARCHITECTURE.md section 6.4 — the server is the authority; this only avoids
 * offering controls that would fail).
 */
export interface NavItem {
  label: string
  to: string
  icon: LucideIcon
  /** Shown when the identity holds ALL of these. */
  requires?: Permission[]
  /** Shown when the identity holds ANY of these. */
  requiresAny?: Permission[]
  /** Rendered as a non-navigating heading. */
  section?: string
}

export interface NavSection {
  title: string
  items: NavItem[]
}

const PLATFORM_NAV: NavSection[] = [
  {
    title: 'Platform',
    items: [
      {
        label: 'Overview',
        to: '/platform',
        icon: LayoutDashboard,
        requiresAny: ['platform:hospital:read'],
      },
      {
        label: 'Hospitals',
        to: '/platform/hospitals',
        icon: Building2,
        requires: ['platform:hospital:read'],
      },
      {
        label: 'Reports',
        to: '/platform/reports',
        icon: TrendingUp,
        requires: ['platform:report:read'],
      },
      {
        label: 'Audit trail',
        to: '/platform/audit',
        icon: ScrollText,
        requires: ['platform:audit:read'],
      },
    ],
  },
]

const HOSPITAL_NAV: NavSection[] = [
  {
    title: 'Overview',
    items: [{ label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Clinical',
    items: [
      { label: 'Patients', to: '/patients', icon: Users, requires: ['patient:read'] },
      {
        label: 'Appointments',
        to: '/appointments',
        icon: CalendarDays,
        requires: ['appointment:read'],
      },
      {
        label: 'Consultations',
        to: '/consultations',
        icon: Stethoscope,
        requiresAny: ['consultation:read'],
      },
      {
        label: 'Prescriptions',
        to: '/prescriptions',
        icon: ClipboardList,
        requiresAny: ['prescription:read'],
      },
      { label: 'Departments', to: '/departments', icon: Bed, requires: ['department:read'] },
      { label: 'Doctors', to: '/doctors', icon: Stethoscope, requires: ['doctor:read'] },
    ],
  },
  {
    title: 'Finance',
    items: [
      { label: 'Billing', to: '/billing', icon: Receipt, requires: ['billing:read'] },
      { label: 'Payments', to: '/payments', icon: Wallet, requires: ['payment:read'] },
      { label: 'Reports', to: '/reports', icon: TrendingUp, requires: ['report:read'] },
    ],
  },
  {
    title: 'Operations',
    items: [
      { label: 'Staff & users', to: '/users', icon: UserCog, requires: ['user:read'] },
      { label: 'Attendance', to: '/attendance', icon: Timer, requires: ['attendance:read'] },
      {
        label: 'Hospital',
        to: '/hospital',
        icon: Settings,
        requires: ['hospital:read'],
      },
      { label: 'Audit trail', to: '/audit', icon: ScrollText, requires: ['audit:read'] },
    ],
  },
]

/**
 * Resolves the sidebar for an identity.
 *
 * A platform administrator sees only platform navigation. A hospital user sees only
 * hospital navigation. There is no combined view, because the two scopes are genuinely
 * different data domains and mixing them in one menu would be misleading.
 */
export function navigationFor(user: SessionUser): NavSection[] {
  const source =
    user.role === 'SUPER_ADMIN' ? PLATFORM_NAV : user.hospitalId === null ? [] : HOSPITAL_NAV

  return source
    .map((section) => ({
      title: section.title,
      items: section.items.filter((item) => isVisibleTo(user, item)),
    }))
    .filter((section) => section.items.length > 0)
}

export function isVisibleTo(user: SessionUser, item: NavItem): boolean {
  if (item.requires && !item.requires.every((p) => hasPermission(user, p))) return false
  if (item.requiresAny && !hasAnyPermission(user, item.requiresAny)) return false
  return true
}

/** Icons used elsewhere; exported so the header can reuse the same visual language. */
export const NAV_ICONS = {
  ShieldCheck,
  FileText,
} as const
