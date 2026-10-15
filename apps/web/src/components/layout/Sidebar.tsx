import { NavLink } from 'react-router-dom'

import { useAuth } from '../../auth/auth-context.js'
import { isPlatformUser, type SessionUser } from '../../auth/session.js'
import { navigationFor, type NavSection } from '../../navigation/navigation.js'
import { cn } from '../../lib/cn.js'
import { BrandMark } from './BrandMark.js'

/**
 * Primary navigation.
 *
 * Links the identity's granted permissions cannot reach are never rendered at all. The
 * API would reject them regardless — the sidebar is not a security control — but
 * presenting a menu item that always fails is a defect, and an accountant being offered
 * "Consultations" implies the product believes they may read clinical notes. They may
 * not: `consultation:read` is absent from the accountant role by design
 * (docs/SECURITY.md R9).
 *
 * `NavLink` carries the active state via `aria-current="page"`, so the current location
 * is announced rather than only tinted.
 */
export function Sidebar({
  sections,
  onNavigate,
  className,
}: {
  sections?: NavSection[]
  /** Called after a link is chosen, so the mobile drawer can close itself. */
  onNavigate?: () => void
  className?: string
}) {
  const { user } = useAuth()
  if (!user) return null

  const resolved = sections ?? navigationFor(user)

  return (
    <div className={cn('flex h-full flex-col bg-ink-900', className)}>
      <div className="flex h-16 shrink-0 items-center border-b border-white/10 px-5">
        <BrandMark tone="light" />
      </div>

      <nav aria-label="Main navigation" className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {resolved.map((section) => (
          <div key={section.title} className="mb-5 last:mb-0">
            <h2 className="mb-1.5 px-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-ink-400">
              {section.title}
            </h2>
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    onClick={onNavigate}
                    end={item.to.split('/').length <= 2}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                        isActive
                          ? 'bg-infini-600/20 font-medium text-white'
                          : 'text-ink-200 hover:bg-white/10 hover:text-white',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {/*
                         * A left-edge rail instead of a filled block.
                         *
                         * A full-width fill changed the width of every label in the rail
                         * when the active item changed, which made the sidebar jitter on
                         * each navigation. The rail is absolutely positioned, so the labels
                         * never move, and it is 2px of solid brand against 8% white — high
                         * contrast for a 2px target, which a 20%-opacity fill was not.
                         */}
                        <span
                          aria-hidden="true"
                          className={cn(
                            'absolute inset-y-1.5 left-0 w-0.5 rounded-full transition-colors',
                            isActive ? 'bg-infini-400' : 'bg-transparent',
                          )}
                        />
                        <item.icon
                          aria-hidden="true"
                          className={cn(
                            'size-4 shrink-0',
                            isActive ? 'text-infini-300' : 'text-ink-400',
                          )}
                        />
                        <span className="truncate">{item.label}</span>
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <ScopeFooter user={user} />
    </div>
  )
}

/**
 * Scope reminder pinned to the bottom of the sidebar.
 *
 * Showing which hospital — or that there is no hospital — is a deliberate safety feature.
 * A user with access to more than one facility should never have to guess which one the
 * screen in front of them belongs to before typing a patient's name.
 */
function ScopeFooter({ user }: { user: SessionUser }) {
  const platform = isPlatformUser(user)

  return (
    <div className="shrink-0 border-t border-white/10 px-5 py-3">
      <p className="truncate text-xs font-medium text-white">
        {user.hospitalName ?? 'Infini Health'}
      </p>
      <p className="mt-0.5 truncate text-xs text-ink-300">
        {platform ? 'All hospitals — platform scope' : `${user.email}`}
      </p>
    </div>
  )
}
