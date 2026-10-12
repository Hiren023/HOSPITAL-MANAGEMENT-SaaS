import type { Permission } from '@infinigrow/shared'
import {
  Bed,
  CalendarDays,
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
        // The Phase 3 "Consultations" placeholder, now a real screen: a clinician's own
        // day. ONE entry only — `Sidebar` keys on `to`, and two entries pointing at
        // `/queue` produce a duplicate React key, which React resolves by silently
        // dropping or duplicating a menu item.
        //
        // Gated on the plain `consultation:read`, which means "my own records", so this
        // can only ever show the signed-in clinician their own work.
        label: 'My queue',
        to: '/queue',
        icon: Stethoscope,
        requires: ['consultation:read'],
      },
      {
        // The real schedule, which replaces the `/appointments` placeholder from Phase 3.
        label: 'Appointments',
        to: '/schedule',
        icon: CalendarDays,
        requires: ['appointment:read'],
      },
      {
        // The real price list. `Sidebar` keys on `to`, so there must be exactly ONE entry
        // pointing at `/services` or React sees a duplicate key and may silently drop a
        // menu item.
        label: 'Service catalogue',
        to: '/services',
        icon: Receipt,
        requires: ['billing:read'],
      },
      { label: 'Departments', to: '/departments', icon: Bed, requires: ['department:read'] },
      { label: 'Doctors', to: '/doctors', icon: Stethoscope, requires: ['doctor:read'] },
    ],
  },
  {
    title: 'Finance',
    items: [
      { label: 'Invoices', to: '/invoices', icon: Receipt, requires: ['billing:read'] },
      {
        // Gated on `report:financial`, not `report:read`. A doctor holds the operational
        // permission and must not be able to derive a hospital's turnover from operational
        // data and arithmetic.
        label: 'Revenue',
        to: '/reports/revenue',
        icon: TrendingUp,
        requires: ['report:financial'],
      },
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
