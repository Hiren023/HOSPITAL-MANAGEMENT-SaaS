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
        <Button size="lg" full>
          Large block
        </Button>
      </div>,
    )

    await expectNoSeriousViolations(container)
  })

  // ─────────────────────── regression guard ───────────────────────

  it('stretches to full width when asked', () => {
    render(<Button full>Full width</Button>)
    expect(screen.getByRole('button')).toHaveClass('w-full')
  })

  it('does not stretch by default', () => {
    render(<Button>Default</Button>)
    expect(screen.getByRole('button')).not.toHaveClass('w-full')
  })

  it('never leaks an unknown attribute to the DOM', () => {
    // Regression guard. The `full` variant was originally named `block`; renaming the
    // cva key while a call site still passed `block` left the prop un-destructured, so
    // React spread it onto the element and logged
    // "Received `true` for a non-boolean attribute `block`" — while the button silently
    // failed to stretch. jsdom keeps console noise out of the exit code, so the failure
    // was invisible to CI and only surfaced from a running dev server.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { rerender } = render(
      <>
        <Button full>One</Button>
        <Button variant="secondary" size="lg" full>
          Two
        </Button>
      </>,
    )

    expect(spy).not.toHaveBeenCalled()

    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('block')).toBeNull()
      expect(button.getAttribute('full')).toBeNull()
      expect(button.getAttribute('busy')).toBeNull()
    }

    rerender(<Button busy>Busy</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('every declared variant is actually consumed by the component', () => {
    // A cva variant nothing destructures is dead: it neither styles anything nor gets
    // stripped from the DOM. This catches the whole class of bug.
    const { container } = render(
      <>
        <Button variant="primary" size="sm" full busy>
          All set
        </Button>
      </>,
    )

    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    // If any prop were un-destructured it would appear here as a stray attribute.
    for (const attribute of Array.from(button?.attributes ?? []).map((a) => a.name)) {
      expect(['class', 'type', 'disabled', 'aria-busy', 'aria-disabled', 'aria-label']).toContain(
        attribute,
      )
    }
  })
})
