import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { Input, inputBaseClasses } from './Input.js'
import { Select } from './Select.js'
import { Textarea } from './Textarea.js'
import { FormField } from './FormField.js'

/**
 * Field rendering — the regression tests for the unstyled-input defect.
 *
 * ── Why these assertions look at class names ──────────────────────────────────
 *
 * The bug this file exists for was not a behavioural one. The input accepted keystrokes,
 * echoed the value, announced itself correctly to a screen reader, and passed every
 * behavioural test in the suite. What it did not do was *look* like an input: it rendered
 * as a bare browser control at default width with default padding and default font, on
 * every screen in the product, because `inputBaseClasses` was exported from `Input.tsx` and
 * then never applied to the element.
 *
 * jsdom does not apply Tailwind, so no amount of behavioural testing could have caught it.
 * Only a human looking at a rendered page could. Since no browser was attached to this
 * project for most of its life, the defect sat there through eight phases.
 *
 * So these tests assert on the class list. That is normally a smell, and it would be one
 * here — except the property under test is precisely "does the element carry its own
 * styling", which is a question about the class list and about nothing else.
 *
 * The behavioural assertions are kept alongside deliberately, because a styled input that
 * no longer echoes what you type is not a fix.
 */

describe('Input styling', () => {
  it('applies its own base classes', () => {
    render(<Input />)
    const input = screen.getByRole('textbox')

    // The defect in one assertion: this used to be the full class list, meaning
    // "border-line-strong" and nothing else.
    for (const token of ['w-full', 'rounded-lg', 'border', 'bg-white', 'px-3', 'py-2', 'text-ink']) {
      expect(input.className.split(/\s+/)).toContain(token)
    }
  })

  it('applies the base classes in every state it can be in', () => {
    // A base class list that only lands in the default state is a base class list that is
    // one edit away from landing in none of them. Four states, checked against the tokens
    // that must survive all of them.
    //
    // The tokens deliberately excluded are the ones a state is *supposed* to replace:
    // `focus:border-brand-600` yields to `focus:border-danger`, `px-3` yields to `pl-9`
    // / `pr-10` when an adornment needs room, and `w-full` yields to a caller's `w-48`.
    // Asserting they survived would be asserting the override does not work. Each
    // override is asserted on its own below.
    const always = inputBaseClasses
      .split(/\s+/)
      .filter(
        (token) => !['px-3', 'focus:border-brand-600'].includes(token),
      )

    const { rerender } = render(<Input invalid />)
    for (const token of always) {
      expect(screen.getByRole('textbox').className.split(/\s+/)).toContain(token)
    }

    rerender(<Input disabled />)
    for (const token of always) {
      expect(screen.getByRole('textbox').className.split(/\s+/)).toContain(token)
    }

    rerender(<Input leading={<span>L</span>} trailing={<span>T</span>} />)
    for (const token of always) {
      expect(screen.getByRole('textbox').className.split(/\s+/)).toContain(token)
    }

    rerender(<Input className="w-48" />)
    for (const token of always.filter((t) => t !== 'w-full')) {
      expect(screen.getByRole('textbox').className.split(/\s+/)).toContain(token)
    }
  })

  it('replaces the focus border when invalid, rather than keeping both', () => {
    // `tailwind-merge` resolves by utility, so only one `focus:border-*` survives.
    // Emitting both would leave the winner decided by stylesheet order.
    render(<Input invalid />)
    const classes = screen.getByRole('textbox').className.split(/\s+/)

    expect(classes).toContain('focus:border-danger')
    expect(classes).not.toContain('focus:border-brand-600')
  })

  it('lets a caller override the width without losing the base styling', () => {
    render(<Input className="w-48" />)
    const classes = screen.getByRole('textbox').className.split(/\s+/)

    // `tailwind-merge` resolves by utility, so `w-48` genuinely replaces `w-full`
    // rather than both being emitted and the winner decided by stylesheet order.
    expect(classes).toContain('w-48')
    expect(classes).not.toContain('w-full')
    expect(classes).toContain('text-ink')
  })

  it('keeps the invalid border and does not also keep the valid one', () => {
    render(<Input invalid />)
    const classes = screen.getByRole('textbox').className.split(/\s+/)

    expect(classes).toContain('border-danger')
    expect(classes).not.toContain('border-line-strong')
  })

  it('marks padding for a leading adornment so the icon cannot cover the text', () => {
    render(<Input leading={<svg />} />)
    const classes = screen.getByRole('textbox').className.split(/\s+/)

    // The icon is absolutely positioned at `left-3`. Without extra padding it is drawn
    // over whatever is typed — on a password field, a padlock across the password.
    expect(classes).toContain('pl-9')
    expect(classes).not.toContain('pl-3')
  })

  it('marks padding for a trailing adornment', () => {
    render(<Input trailing={<button type="button" />} />)
    expect(screen.getByRole('textbox').className.split(/\s+/)).toContain('pr-10')
  })

  it('adds no adornment padding when there is no adornment', () => {
    render(<Input />)
    const classes = screen.getByRole('textbox').className.split(/\s+/)

    expect(classes).toContain('px-3')
    expect(classes).not.toContain('pl-9')
    expect(classes).not.toContain('pr-10')
  })

  it('hides a decorative leading adornment but keeps a trailing control reachable', () => {
    // The leading icon is decoration: announcing a padlock on every password field in the
    // product is noise. A trailing "show password" button is not decoration, so it stays
    // out of `aria-hidden` and stays focusable.
    render(<Input leading={<svg data-testid="lead" />} trailing={<span data-testid="trail" />} />)

    expect(screen.getByTestId('lead').parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByTestId('trail').getAttribute('aria-hidden')).toBeNull()
  })
})

describe('fields share one visual language', () => {
  /**
   * The three controls were styled by three different means: `Select` and `Textarea`
   * inlined their classes, `Input` exported a constant it did not use. This test makes the
   * shared part of the appearance explicit, so the next control added picks it up by
   * reading a neighbouring file rather than by copying whatever was there.
   */
  const sharedTokens = ['w-full', 'rounded-lg', 'border', 'bg-white', 'text-sm', 'text-ink']

  it('Select carries the shared appearance', () => {
    render(
      <Select
        aria-label="Department"
        value=""
        onChange={() => {}}
        options={[{ value: '', label: 'Choose a department' }]}
      />,
    )

    const classes = screen.getByLabelText('Department').className.split(/\s+/)
    for (const token of sharedTokens) expect(classes).toContain(token)
  })

  it('Textarea carries the shared appearance', () => {
    render(<Textarea aria-label="Notes" />)

    const classes = screen.getByLabelText('Notes').className.split(/\s+/)
    for (const token of sharedTokens) expect(classes).toContain(token)
  })
})

describe('Input still behaves', () => {
  /**
   * The styling fix must not have broken the thing the old tests actually verified: that a
   * controlled input echoes what is typed. An input that looks right and swallows
   * keystrokes is a different defect, not an absence of one.
   */
  function Controlled() {
    const [value, setValue] = useState('')
    return (
      <FormField label="Email address" required>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            invalid={invalid}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </FormField>
    )
  }

  it('shows what the user typed', async () => {
    const user = userEvent.setup()
    render(<Controlled />)

    const input = screen.getByLabelText(/email address/i)
    await user.type(input, 'meera.nair@example.test')

    expect(input).toHaveValue('meera.nair@example.test')
  })

  it('shows a password being typed, with the icon out of the way', async () => {
    function ControlledPassword() {
      const [value, setValue] = useState('')
      return (
        <FormField label="Password" required>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              aria-describedby={describedBy}
              invalid={invalid}
              leading={<svg data-testid="padlock" />}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </FormField>
      )
    }

    const user = userEvent.setup()
    render(<ControlledPassword />)

    const input = screen.getByLabelText(/password/i)
    await user.type(input, 'correct-horse-battery-staple')

    expect(input).toHaveValue('correct-horse-battery-staple')
    // Masked in the UI, complete in the value. A "type=password" that lost characters
    // would pass every screenshot check.
    expect(input).toHaveAttribute('type', 'password')
    expect(input.className).toContain('pl-9')
  })
})