import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { expectNoSeriousViolations } from '../../test/a11y.js'
import { Button } from '../ui/Button.js'
import { EmptyState } from './EmptyState.js'
import { ErrorState } from './ErrorState.js'
import { LoadingState } from './LoadingState.js'

/**
 * Every data view in this product must render loading, empty and error states
 * (docs/PROJECT_PROPOSAL.md rule 8). These tests pin that contract.
 */

describe('LoadingState', () => {
  it('announces a busy, polite status region', () => {
    render(<LoadingState />)

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('accepts a custom label and row count', () => {
    const { container } = render(<LoadingState rows={5} label="Loading patients…" />)

    expect(screen.getByText('Loading patients…')).toBeInTheDocument()
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(5)
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<LoadingState />)
    await expectNoSeriousViolations(container)
  })
})

describe('EmptyState', () => {
  it('shows a title and description', () => {
    render(
      <EmptyState title="No patients yet" description="Register your first patient to begin." />,
    )

    expect(screen.getByRole('heading', { name: 'No patients yet' })).toBeInTheDocument()
    expect(screen.getByText('Register your first patient to begin.')).toBeInTheDocument()
  })

  it('offers a working action when one is supplied', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()

    render(
      <EmptyState
        title="No patients yet"
        action={<Button onClick={onClick}>Register patient</Button>}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Register patient' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders an icon when provided', () => {
    const { container } = render(<EmptyState title="Nothing" icon={<svg aria-hidden="true" />} />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<EmptyState title="No patients yet" description="Start here." />)
    await expectNoSeriousViolations(container)
  })
})

describe('ErrorState', () => {
  it('is announced as an alert so assistive technology interrupts', () => {
    render(<ErrorState />)

    const alert = screen.getByRole('alert')
    expect(alert).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
  })

  it('uses a custom title and message', () => {
    render(
      <ErrorState title="Could not load patients" message="The hospital server did not respond." />,
    )

    expect(screen.getByRole('heading', { name: 'Could not load patients' })).toBeInTheDocument()
    expect(screen.getByText('The hospital server did not respond.')).toBeInTheDocument()
  })

  it('retries when a retry handler is supplied', async () => {
    const onRetry = vi.fn()
    const user = userEvent.setup()

    render(<ErrorState onRetry={onRetry} />)

    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows a pending state while retrying and blocks repeat clicks', async () => {
    const onRetry = vi.fn()
    const user = userEvent.setup()

    render(<ErrorState onRetry={onRetry} retrying />)

    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')

    await user.click(button)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('omits the retry control entirely when no handler is given (no dead buttons)', () => {
    render(<ErrorState />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders additional detail provided by the caller', () => {
    render(
      <ErrorState>
        <p>Reference: req-abc12345</p>
      </ErrorState>,
    )

    expect(screen.getByText('Reference: req-abc12345')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<ErrorState onRetry={() => undefined} />)
    await expectNoSeriousViolations(container)
  })
})
