import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderApp } from '../../test/harness.js'
import { LoginPage } from '../auth/LoginPage.js'

/**
 * The sign-in page, asserted at the level the defect actually lived.
 *
 * ── Why this test exists when Input.test.tsx already covers it ─────────────────
 *
 * `Input.test.tsx` proves the *component* carries its styling. This proves the *page the
 * user actually reaches first* renders styled fields, which is a different claim.
 *
 * The difference matters because a component test passes if the component is right and
 * the page does something unusual — and the sign-in page is the one page every single
 * user sees before anything else. If it renders unstyled, the first impression of the
 * product is a 1995 browser form, and no amount of correctness elsewhere repairs that.
 *
 * It also pins the password field specifically: that field is the only one on the page
 * with a `leading` adornment, so it is the only one where the icon-over-text overlap
 * could occur, and the only one a user would immediately describe as "broken".
 */
describe('sign-in page', () => {
  it('renders both fields with their own styling', () => {
    renderApp(<LoginPage />, { route: '/' })

    for (const field of [
      screen.getByLabelText(/email address/i),
      screen.getByLabelText(/^password/i),
    ]) {
      const classes = field.className.split(/\s+/)

      // Width, padding, background and text colour are the four that were missing. A bare
      // `<input>` has none of them, which is why every field looked wrong and not merely
      // plain.
      for (const token of ['w-full', 'px-3', 'py-2', 'bg-white', 'text-body']) {
        expect(classes, `${field.getAttribute('type')} is missing "${token}"`).toContain(token)
      }

      expect(classes).toContain('rounded-lg')
      expect(classes).toContain('border')
    }
  })

  it('reserves room for the password icon instead of drawing it over the text', () => {
    renderApp(<LoginPage />, { route: '/' })

    const password = screen.getByLabelText(/^password/i)
    expect(password.className).toContain('pl-9')

    // The email field has no adornment and so must NOT carry the reserved padding —
    // otherwise the text starts with a gap for an icon that is not there.
    expect(screen.getByLabelText(/email address/i).className).not.toContain('pl-9')
  })

  it('keeps both fields in the tab order and typed to the right type', () => {
    renderApp(<LoginPage />, { route: '/' })

    const email = screen.getByLabelText(/email address/i)
    const password = screen.getByLabelText(/^password/i)

    expect(email).toHaveAttribute('type', 'email')
    expect(password).toHaveAttribute('type', 'password')
    // Browser autofill must work, or every user retypes a password nobody can reset.
    expect(email).toHaveAttribute('autocomplete', 'username')
    expect(password).toHaveAttribute('autocomplete', 'current-password')
  })
})