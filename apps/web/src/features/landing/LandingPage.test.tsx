import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { expectNoSeriousViolations } from '../../test/a11y.js'
import { LandingPage } from './LandingPage.js'

/** The landing page links to `/login` and `/register`, so it needs a router in tests. */
function renderLanding() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  )
}

describe('LandingPage', () => {
  it('presents the product name and the vendor', () => {
    renderLanding()

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(
      screen.getByText(/Infinigrow Softech\. Infini Health is a product of/i),
    ).toBeInTheDocument()
  })

  /**
   * The brand rule: **Infini** is infini-blue, **Health** is black.
   *
   * Asserted on the rendered classes rather than on a screenshot, because a screenshot
   * cannot be reviewed in this environment and would pass even if both halves were
   * accidentally the same colour. These two assertions are what make the split
   * intentional rather than incidental — the wordmark is rendered as two separate runs
   * precisely so they can be styled differently.
   */
  it('renders the wordmark as Infini in blue and Health in black', () => {
    renderLanding()

    // The wordmark appears in the header and again in the footer.
    const infini = screen.getAllByText('Infini')
    expect(infini.length).toBeGreaterThan(0)

    for (const run of infini) {
      expect(run.className).toMatch(/text-infini-\d+/)
    }

    const health = screen.getAllByText('Health')
    expect(health.length).toBeGreaterThan(0)

    for (const run of health) {
      expect(run.className).toMatch(/text-(ink-\d+|white)/)
      // Not blue: the two halves must not collapse into one colour.
      expect(run.className).not.toMatch(/text-infini-/)
    }
  })

  it('covers the product overview, features, security, pricing and FAQ', () => {
    renderLanding()

    for (const heading of [
      'One platform, from reception to accounts',
      'Everything a hospital needs, in one place',
      'Security is a property of the build, not a promise',
      'Pricing',
      'Frequently asked questions',
      'See it with your own data',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
    }
  })

  it('exposes landmarks and a skip link for keyboard users', () => {
    renderLanding()

    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument()
  })

  it('every in-page navigation link targets a section that exists', () => {
    const { container } = renderLanding()

    const anchors = Array.from(container.querySelectorAll('a[href^="#"]'))
    expect(anchors.length).toBeGreaterThan(0)

    for (const anchor of anchors) {
      const id = anchor.getAttribute('href')?.slice(1) ?? ''
      expect(id, `anchor "${anchor.textContent}" has no target`).not.toBe('')
      expect(
        container.querySelector(`#${CSS.escape(id)}`),
        `anchor "${anchor.textContent}" points at a missing section`,
      ).not.toBeNull()
    }
  })

  it('links only to routes that exist, so there are no dead controls', () => {
    renderLanding()

    // Every internal route the marketing page advertises must be a real one.
    const KNOWN_ROUTES = ['/', '/login', '/register']
    const links = screen.getAllByRole('link')
    const routes = links
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => href !== null && !href.startsWith('#'))

    for (const route of routes) {
      expect(KNOWN_ROUTES, `landing page links to an unimplemented route: ${route}`).toContain(
        route,
      )
    }
  })

  it('states what the security claims actually are, in engineering terms', () => {
    renderLanding()

    expect(screen.getByText(/isolation enforced three times over/i)).toBeInTheDocument()
    // Argon2id is named both in the security panel and in the hero statistics.
    expect(screen.getAllByText(/argon2id/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/append-only audit trail/i).length).toBeGreaterThan(0)
  })

  it('does not claim regulatory certification it does not hold', () => {
    renderLanding()

    // The FAQ answer must disclaim certification rather than assert it.
    expect(screen.getByText(/we do not claim certifications we do not hold/i)).toBeInTheDocument()
  })

  it('marks demo data as fictional', () => {
    renderLanding()
    expect(
      screen.getByText(/details shown anywhere in this product are fictional/i),
    ).toBeInTheDocument()
  })

  it('reaches sign-in and registration from the header', async () => {
    renderLanding()

    const banner = screen.getByRole('banner')
    expect(within(banner).getAllByRole('link', { name: /sign in/i }).length).toBeGreaterThan(0)
    expect(within(banner).getAllByRole('link', { name: /request a demo/i }).length).toBeGreaterThan(
      0,
    )
  })

  it('the FAQ answers are disclosed by real elements, not hidden divs', async () => {
    const user = userEvent.setup()
    renderLanding()

    const question = screen.getByText(/can one hospital see another hospital/i)
    const details = question.closest('details')
    expect(details).not.toBeNull()
    expect(details?.hasAttribute('open')).toBe(false)

    await user.click(question)

    expect(details?.hasAttribute('open')).toBe(true)
    expect(screen.getByText(/derives the tenant from the signed session/i)).toBeInTheDocument()
  })

  it('has no serious accessibility violations', async () => {
    const { container } = renderLanding()
    await expectNoSeriousViolations(container)
  })
})
