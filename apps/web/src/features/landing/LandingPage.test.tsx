import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { expectNoSeriousViolations } from '../../test/a11y.js'
import { LandingPage } from './LandingPage.js'

describe('LandingPage', () => {
  it('presents the product name and tagline', () => {
    render(<LandingPage />)

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    // The tagline and vendor appear in both the header and the footer.
    expect(screen.getAllByText('Infinigrow Hospital Cloud').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Ideas grow without limits/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Infinigrow Softech/i).length).toBeGreaterThan(0)
  })

  it('exposes landmarks and a skip link for keyboard users', () => {
    render(<LandingPage />)

    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Page sections' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument()
  })

  it('every navigation link targets a section that exists on the page', () => {
    const { container } = render(<LandingPage />)

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

  it('contains no links to unimplemented routes (no dead controls)', () => {
    const { container } = render(<LandingPage />)

    const internalLinks = Array.from(container.querySelectorAll('a[href]')).filter(
      (anchor) => !anchor.getAttribute('href')?.startsWith('#'),
    )

    expect(internalLinks).toHaveLength(0)
  })

  it('labels each module with a real delivery status', () => {
    render(<LandingPage />)

    expect(screen.getAllByText('Available now').length).toBeGreaterThan(0)
    expect(screen.getAllByText('In development').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Planned').length).toBeGreaterThan(0)
  })

  it('states plainly that sign-in is not yet delivered', () => {
    render(<LandingPage />)
    expect(screen.getByText(/foundation phase/i)).toBeInTheDocument()
  })

  it('does not claim regulatory compliance', () => {
    render(<LandingPage />)
    expect(screen.getByText(/requires qualified legal review/i)).toBeInTheDocument()
  })

  it('has no serious accessibility violations', async () => {
    const { container } = render(<LandingPage />)
    await expectNoSeriousViolations(container)
  })
})