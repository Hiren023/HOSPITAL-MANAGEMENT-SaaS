import { Route, Routes } from 'react-router-dom'

import { LandingPage } from './features/landing/LandingPage.js'
import { NotFoundPage } from './pages/NotFoundPage.js'

/**
 * Route table.
 *
 * Phase 0 ships the public landing page only. Authenticated modules arrive in Phase 1+
 * and will be registered here as they are implemented — no placeholder routes are
 * added, because a route that leads nowhere is a dead control
 * (docs/PROJECT_PROPOSAL.md rule 16).
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}