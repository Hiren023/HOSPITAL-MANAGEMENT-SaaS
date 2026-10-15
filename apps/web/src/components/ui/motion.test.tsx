import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Button } from './Button.js'
import { Card, StatTile } from './Card.js'

/**
 * Read the stylesheet as source. jsdom never applies it, so a source read is the only way
 * to assert on a rule. Kept in one place so every assertion below reads as a behaviour
 * rather than as file plumbing.
 *
 * `import.meta.dirname`, not `import.meta.url`: vitest runs with a jsdom environment, so
 * `import.meta.url` is an http URL and `new URL(relative, ...)` throws "The URL must be
 * of scheme file".
 */
const STYLESHEET = readFileSync(
  resolve(import.meta.dirname, '../../index.css'),
  'utf8',
)

/**
 * These assertions are on class output, not on appearance.
 *
 * jsdom does not apply Tailwind, so there is no way here to assert that a button looks
 * pressed. What *can* be asserted is that each control carries the classes the 3D system
 * keys off, and that the accessibility-critical rules survive in the stylesheet. Those
 * are the parts that regress silently: a renamed class, an edge colour that no longer
 * matches its face, or a reduced-motion override quietly deleted during a refactor all
 * still render "fine" in a passing test suite.
 */
describe('3D and motion system', () => {
  it('gives every solid variant the 3D treatment', () => {
    const { container } = render(
      <>
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="danger">Danger</Button>
      </>,
    )

    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveClass('btn-3d')
    }

    // A flat variant must NOT get it. An edge under a borderless ghost button is a
    // visible slab of colour with nothing to sit on.
    const { container: ghostHost } = render(<Button variant="ghost">Ghost</Button>)
    expect(ghostHost.querySelector('button')).not.toHaveClass('btn-3d')
    expect(container).toBeTruthy()
  })

  it('pairs each 3D face with an edge of its own colour', () => {
    // The single most common way a 3D button looks wrong: a blue face on a grey base,
    // pressed at the same time. Each edge must be a token, not a literal, so a retune of
    // the ramp moves face and edge together.
    const cases = [
      { variant: 'primary' as const, edge: '--color-infini-900' },
      { variant: 'secondary' as const, edge: '--color-line' },
      { variant: 'danger' as const, edge: '--color-danger' },
    ]

    for (const { variant, edge } of cases) {
      const { container, unmount } = render(<Button variant={variant}>x</Button>)
      const className = container.querySelector('button')?.className ?? ''
      expect(className).toContain('--btn-edge')
      expect(className).toContain(edge)
      unmount()
    }
  })

  it('keeps keyboard focus visible on a 3D button', () => {
    // The focus ring is raised to 3px with a 3px offset because the default 2px ring sits
    // inside the 4px edge band, where two near-identical blues read as a smudge.
    const stylesheet = STYLESHEET

    expect(stylesheet).toMatch(/\.btn-3d:focus-visible\s*\{[^}]*outline:/)
    const focusRule = stylesheet.match(/\.btn-3d:focus-visible\s*\{[^}]*\}/)?.[0] ?? ''
    expect(focusRule).toMatch(/outline:\s*3px/)
    expect(focusRule).toMatch(/outline-offset:\s*3px/)
  })

  it('never lifts or depresses a disabled button', () => {
    // A disabled control that moves on hover invites a click that does nothing, which is
    // worse than an ugly one. The `:not(:disabled)` guards are in the stylesheet.
    const stylesheet = STYLESHEET

    expect(stylesheet).toMatch(/\.btn-3d:hover:not\(:disabled\)/)
    expect(stylesheet).toMatch(/\.btn-3d:active:not\(:disabled\)/)
    expect(stylesheet).not.toMatch(/\.btn-3d:hover\s*\{/)
    expect(stylesheet).not.toMatch(/\.btn-3d:active\s*\{/)
  })

  it('neutralises every transform it introduces under reduced motion', () => {
    /*
     * The subtle one, and the reason this test exists.
     *
     * The global reduced-motion block zeroes durations but deliberately does not reset
     * `transform`, because a blanket reset would break the `top-1/2 -translate-y-1/2`
     * trick that positions every dropdown chevron — those elements would sit half a line
     * too low. Transforms are therefore neutralised individually, and nothing else will
     * catch it if one is forgotten.
     *
     * A 3D button pressed with no movement sits 3px below its own edge, which reads as a
     * rendering fault rather than as a press.
     */
    const stylesheet = STYLESHEET

    /*
     * Extracted by slicing, not by matching braces.
     *
     * A `@media (prefers-reduced-motion: reduce) { ... }` regex cannot be balanced here:
     * the block contains nested rules, so a non-greedy `[\s\S]*?\}` stops at the first
     * inner `}` — the universal selector — and silently returns a fragment that does not
     * include the rules being asserted. The slice runs to the next at-rule, which is a
     * real boundary and cannot be confused by nesting.
     */
    const start = stylesheet.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(start).toBeGreaterThan(-1)

    const rest = stylesheet.slice(start + 1)
    const end = rest.search(/\n@(?:layer|media|keyframes)/)
    const reduced = end === -1 ? rest : rest.slice(0, end)

    expect(reduced).toMatch(/\.btn-3d/)
    expect(reduced).toMatch(/transform:\s*none\s*!important/)

    // Every transform the design system introduces must be covered by that reset.
    for (const selector of ['.btn-3d:hover', '.btn-3d:active', '.panel-lift:hover']) {
      expect(reduced).toContain(selector)
    }

    // And the travelling sheen is removed outright rather than left to run invisibly.
    expect(reduced).toMatch(/\.btn-sheen::after\s*\{\s*display:\s*none/)

    /*
     * The blanket reset this deliberately avoids.
     *
     * `transform: none !important` applied to `*` would break every element positioned
     * with translate — including each dropdown chevron's `top-1/2 -translate-y-1/2` —
     * leaving them sitting half a line too low. Asserted absent so that "simplify the
     * motion code" cannot reintroduce it.
     */
    expect(reduced).not.toMatch(/^\s*\*\s*,\s*\*::before[\s\S]{0,80}transform:\s*none/m)
  })

  it('does not animate layout properties', () => {
    // Only `transform`, `box-shadow`, `opacity` and colour may be transitioned. Animating
    // width, height, top or margin forces layout on every frame, which on a dashboard of
    // large panels is the difference between 60fps and a stuttering page.
    const stylesheet = STYLESHEET

    for (const property of ['width', 'height', 'top:', 'left:', 'margin', 'padding']) {
      const transition = stylesheet.match(/transition:\s*([^;}]+)/g) ?? []
      for (const declaration of transition) {
        expect(declaration).not.toMatch(new RegExp(`(^|\\s)${property}`))
      }
    }
  })

  it('fills the entry animation backwards so a stagger cannot flash', () => {
    // `animation-fill-mode: both` is not decoration. Without it a panel holds its `from`
    // state during its stagger delay, appearing at zero opacity and then popping in.
    const stylesheet = STYLESHEET
    const enter = stylesheet.match(/\.panel-enter\s*\{[^}]*\}/)?.[0] ?? ''

    expect(enter).toMatch(/panel-enter/)
    expect(enter).toMatch(/both/)
  })

  it('staggers panels through a custom property rather than per-element delays', () => {
    render(<StatTile label="Patients" value={10} stagger={3} />)
    const tile = screen.getByText('Patients').closest('[style]')

    expect(tile).not.toBeNull()
    expect(tile?.getAttribute('style')).toContain('--stagger')
  })

  it('lifts on hover only when the panel is genuinely interactive', () => {
    // A panel of records is a container, not a control. Lifting on hover implies it can
    // be clicked, which is a lie on most of them, so the lift is opt-in.
    const { container: plain } = render(
      <Card>
        <p>Records</p>
      </Card>,
    )
    expect(plain.querySelector('.panel-lift')).toBeNull()

    const { container: clickable } = render(
      <Card interactive>
        <p>Records</p>
      </Card>,
    )
    expect(clickable.querySelector('.panel-lift')).not.toBeNull()
  })

  it('does not lift stat tiles, because a read-out is not a control', () => {
    const { container } = render(<StatTile label="Revenue" value="₹1,20,000" />)
    expect(container.querySelector('.panel-lift')).toBeNull()
  })

  it('grows a focus ring on fields without reflowing the form', () => {
    /*
     * A `box-shadow` spread ring rather than an outline or a border change. An outline
     * cannot be transitioned, and growing a border reflows the box and nudges every
     * adjacent field by a pixel, so the whole form jitters as the user tabs through it.
     */
    const stylesheet = STYLESHEET
    const rule = stylesheet.match(/\.field-focus:focus-visible\s*\{[^}]*\}/)?.[0] ?? ''

    expect(rule).toMatch(/box-shadow:/)
    expect(rule).not.toMatch(/outline-width|border-width/)
  })
})
