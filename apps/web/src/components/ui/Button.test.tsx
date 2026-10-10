import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { expectNoSeriousViolations } from '../../test/a11y.js'
import { Button } from './Button.js'

describe('Button', () => {
  it('renders its label and fires the click handler', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()

    render(<Button onClick={onClick}>Register hospital</Button>)

    await user.click(screen.getByRole('button', { name: 'Register hospital' }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('defaults to type="button" so it cannot accidentally submit a form', () => {
    render(<Button>Save</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
  })

  it('can submit a form when explicitly asked', () => {
    render(<Button type="submit">Sign in</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit')
  })

  it('does not fire the handler while busy', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()

    render(
      <Button onClick={onClick} busy busyLabel="Saving…">
        Save
      </Button>,
    )

    const button = screen.getByRole('button')
    await user.click(button)

    expect(onClick).not.toHaveBeenCalled()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('announces the pending state to assistive technology', () => {
    render(
      <Button busy busyLabel="Saving…">
        Save
      </Button>,
    )

    expect(screen.getByText('Saving…')).toBeInTheDocument()
    // The label stays visible so the control never loses its accessible name.
    expect(screen.getByRole('button', { name: /Save/ })).toBeInTheDocument()
  })

  it('respects the disabled prop', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()

    render(
      <Button onClick={onClick} disabled>
        Save
      </Button>,
    )

    await user.click(screen.getByRole('button'))

    expect(onClick).not.toHaveBeenCalled()
    expect(screen.getByRole('button')).toHaveAttribute('aria-disabled', 'true')
  })

  it('has no accessibility violations in any variant', async () => {
    const { container } = render(
      <div className="flex gap-2">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger" busy>
          Danger
        </Button>
        <Button size="lg" block>
          Large block
        </Button>
      </div>,
    )

    await expectNoSeriousViolations(container)
  })
})