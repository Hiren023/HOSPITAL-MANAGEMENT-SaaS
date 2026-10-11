import { Navigate, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'

import { AuthProvider, useAuth } from './auth/auth-context.js'
import {
  RequireAuth,
  RequirePermission,
  RequirePlatform,
  RequireTenantScope,
  UnauthorizedState,
} from './auth/guards.js'
import { LandingPage } from './features/landing/LandingPage.js'
import { LoginPage } from './features/auth/LoginPage.js'
import { RegisterHospitalPage } from './features/auth/RegisterHospitalPage.js'
import { SuperAdminDashboard } from './features/platform/SuperAdminDashboard.js'
import { PlatformOverviewPage } from './features/platform/PlatformOverviewPage.js'
import { PlatformHospitalsPage } from './features/platform/PlatformHospitalsPage.js'
import { PlatformHospitalDetailPage } from './features/platform/PlatformHospitalDetailPage.js'
import { PlatformAuditPage } from './features/platform/PlatformAuditPage.js'
import { PlatformReportsPage } from './features/platform/PlatformReportsPage.js'
import { HospitalDashboard, ModulePlaceholder } from './features/dashboard/HospitalDashboard.js'
import { NotFoundPage } from './pages/NotFoundPage.js'
import type { Permission } from '@infinigrow/shared'

/** Platform screen wrapper: SUPER_ADMIN, plus the exact permission the API requires. */
function PlatformOnly({ permission, children }: { permission: Permission; children: ReactNode }) {
  return <RequirePermission permission={permission}>{children}</RequirePermission>
}

/**
 * Route table.
 *
 * Every authenticated route is wrapped in a guard, and the guard is chosen from the
 * permission the underlying API requires — not from the role name. The API independently
 * re-checks each permission on every request, so these guards are usability and
 * defence in depth, never the boundary (docs/SECURITY.md R11).
 *
 * Clinical modules resolve to `ModulePlaceholder` in this phase. They are routed rather
 * than 404ing, and the placeholder says plainly that no backend exists yet — a menu item
 * that leads to a blank screen, or worse to invented patient records, would be a worse
 * outcome than an honest "not yet".
 */
function AuthenticatedRoutes() {
  const { status } = useAuth()

  // While the refresh cookie is being exchanged, hold every authenticated route so a
  // signed-in user reloading the page is not bounced to the login form.
  if (status === 'restoring') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-screen items-center justify-center"
      >
        <p className="text-sm text-ink-muted">Restoring your session…</p>
      </div>
    )
  }

  return (
    <Routes>
      {/* Platform administration — SUPER_ADMIN only, no hospital scope. */}
      <Route
        path="/platform"
        element={
          <RequireAuth>
            <RequirePlatform>
              <SuperAdminDashboard />
            </RequirePlatform>
          </RequireAuth>
        }
      />

      {/*
        Platform console. Each screen is wrapped by both `RequirePlatform` and the guard
        for the specific permission the underlying API demands, so the interface and the
        server cannot disagree about who may open what.
      */}
      <Route
        path="/platform"
        element={
          <RequireAuth>
            <RequirePlatform>
              <PlatformOnly permission="platform:hospital:read">
                <PlatformOverviewPage />
              </PlatformOnly>
            </RequirePlatform>
          </RequireAuth>
        }
      />
      <Route
        path="/platform/hospitals"
        element={
          <RequireAuth>
            <RequirePlatform>
              <PlatformOnly permission="platform:hospital:read">
                <PlatformHospitalsPage />
              </PlatformOnly>
            </RequirePlatform>
          </RequireAuth>
        }
      />
      <Route
        path="/platform/hospitals/:hospitalId"
        element={
          <RequireAuth>
            <RequirePlatform>
              <PlatformOnly permission="platform:hospital:read">
                <PlatformHospitalDetailPage />
              </PlatformOnly>
            </RequirePlatform>
          </RequireAuth>
        }
      />
      <Route
        path="/platform/audit"
        element={
          <RequireAuth>
            <RequirePlatform>
              <PlatformOnly permission="platform:audit:read">
                <PlatformAuditPage />
              </PlatformOnly>
            </RequirePlatform>
          </RequireAuth>
        }
      />
      <Route
        path="/platform/reports"
        element={
          <RequireAuth>
            <RequirePlatform>
              <PlatformOnly permission="platform:report:read">
                <PlatformReportsPage />
              </PlatformOnly>
            </RequirePlatform>
          </RequireAuth>
        }
      />
      <Route
        path="/platform/*"
        element={
          <RequireAuth>
            <RequirePlatform>
              <ModulePlaceholder title="Platform" />
            </RequirePlatform>
          </RequireAuth>
        }
      />

      {/* Hospital dashboard — any signed-in user with a hospital membership. */}
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <RequireTenantScope>
              <HospitalDashboard />
            </RequireTenantScope>
          </RequireAuth>
        }
      />

      {/*
        Clinical and administrative modules. Each entry names the permission the API will
        demand, so the guard and the server cannot disagree about who may open what.
      */}
      {(
        [
          ['/patients', 'Patients', 'patient:read'],
          ['/appointments', 'Appointments', 'appointment:read'],
          ['/consultations', 'Consultations', 'consultation:read'],
          ['/prescriptions', 'Prescriptions', 'prescription:read'],
          ['/departments', 'Departments', 'department:read'],
          ['/billing', 'Billing', 'billing:read'],
          ['/payments', 'Payments', 'payment:read'],
          ['/reports', 'Reports', 'report:read'],
          ['/attendance', 'Attendance', 'attendance:read'],
          ['/users', 'Staff and users', 'user:read'],
          ['/audit', 'Audit trail', 'audit:read'],
          ['/settings/hospital', 'Hospital settings', 'hospital:settings:manage'],
        ] as const satisfies readonly (readonly [string, string, Permission])[]
      ).map(([path, title, permission]) => (
        <Route
          key={path}
          path={path}
          element={
            <RequireAuth>
              <RequireTenantScope>
                <RequirePermission permission={permission}>
                  <ModulePlaceholder title={title} permission={permission} />
                </RequirePermission>
              </RequireTenantScope>
            </RequireAuth>
          }
        />
      ))}

      {/* Signed-in users have no business on the marketing site. */}
      <Route
        path="/login"
        element={status === 'authenticated' ? <Navigate to="/dashboard" replace /> : <LoginPage />}
      />
      <Route
        path="/register"
        element={
          status === 'authenticated' ? (
            <Navigate to="/dashboard" replace />
          ) : (
            <RegisterHospitalPage />
          )
        }
      />

      <Route path="/" element={<LandingPage />} />

      <Route
        path="/unauthorized"
        element={
          <div className="min-h-screen bg-canvas">
            <UnauthorizedState />
          </div>
        }
      />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}

export function App() {
  return (
    <AuthProvider>
      <AuthenticatedRoutes />
    </AuthProvider>
  )
}
