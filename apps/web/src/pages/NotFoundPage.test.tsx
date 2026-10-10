import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { expectNoSeriousViolations } from '../test/a11y.js'
import { NotFoundPage } from './NotFoundPage.js'

describe('NotFoundPage', () => {
  it('explains that the page was not found', () => {
    render(<NotFoundPage />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'We could not find that page',
    )
    expect(screen.getByText(/Error 404/)).toBeInTheDocument()
  })

  it('offers a working way back to the home page', () => {
    const assign = vi.fn()
    vi.stubGlobal('window', { ...window, location: { ...window.location, assign } })

    render(<NotFoundPage />)
    const button = screen.getByRole('button', { name: /back to home/i })

    expect(button).toBeInTheDocument()
    button.click()
    expect(assign).toHaveBeenCalledWith('/')

    vi.unstubAllGlobals()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<NotFoundPage />)
    await expectNoSeriousViolations(container)
  })
})
