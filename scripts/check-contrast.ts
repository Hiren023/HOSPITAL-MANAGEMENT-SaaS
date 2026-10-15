/**
 * Checks the contrast of every foreground/background pairing the design system actually
 * uses, against WCAG 2.1 AA.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────
 *
 * The token file claims "every text pairing below is checked for WCAG AA". A comment is
 * not a check. This script is the check, and it reads `index.css` so it cannot drift
 * from the values it is validating — retune a ramp and the verdict changes with it.
 *
 *   npx tsx scripts/check-contrast.ts
 *
 * AA thresholds:
 *   4.5:1  normal text
 *   3.0:1  large text (>= 24px, or >= 18.66px when bold) and non-text UI boundaries
 *
 * Pairs are listed with where they are used, because "this fails" is only actionable
 * alongside "this is the sidebar's inactive link colour".
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CSS = readFileSync(join(ROOT, 'apps/web/src/index.css'), 'utf8')

/** Read a `--color-*` custom property written as an `oklch()` literal. */
function token(name: string): [number, number, number] {
  const match = CSS.match(new RegExp(`--color-${name}:\\s*oklch\\(([^)]+)\\)`))
  if (!match) throw new Error(`token --color-${name} is not an oklch() literal in index.css`)

  const parts = match[1]
    .trim()
    .split('/')
    .at(0)!
    .trim()
    .split(/\s+/)
    .map(Number)

  return [parts[0], parts[1], parts[2]]
}

/** Literal oklch(L C H) to sRGB 0-1. */
function oklchToRgb(L: number, C: number, Hdeg: number): [number, number, number] {
  const h = (Hdeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

  return [r, g, bl].map((v) => {
    // Gamma-encode an sRGB linear value, then clamp. Unclamped out-of-gamut values make
    // the contrast number look better than the colour actually renders.
    const encoded = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055
    return Math.min(1, Math.max(0, encoded))
  }) as [number, number, number]
}

/** WCAG relative luminance. */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4),
  ) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(fg: [number, number, number], bg: [number, number, number]): number {
  const a = luminance(fg)
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

interface Pair {
  /** Where this pairing appears, so a failure is actionable. */
  where: string
  fg: string
  bg: string
  kind: 'normal' | 'large'
}

const PAIRS: Pair[] = [
  // ── Light surfaces ──────────────────────────────────────────────────────────
  { where: 'body copy on a panel', fg: 'body', bg: 'surface', kind: 'normal' },
  { where: 'secondary text on a panel', fg: 'body-muted', bg: 'surface', kind: 'normal' },
  { where: 'uppercase field label on a panel', fg: 'body-subtle', bg: 'surface', kind: 'normal' },
  { where: 'body copy on the page canvas', fg: 'body', bg: 'canvas', kind: 'normal' },
  { where: 'secondary text on a muted surface', fg: 'body-muted', bg: 'surface-muted', kind: 'normal' },
  { where: 'panel heading on a panel', fg: 'ink-900', bg: 'surface', kind: 'normal' },
  { where: 'link text on a panel', fg: 'infini-700', bg: 'surface', kind: 'normal' },
  { where: 'focus ring against a panel', fg: 'infini-600', bg: 'surface', kind: 'large' },
  { where: 'outline-button label', fg: 'infini-700', bg: 'infini-50', kind: 'normal' },
  { where: 'stat tile icon on its chip', fg: 'infini-700', bg: 'infini-50', kind: 'normal' },

  // ── White on a solid fill ──────────────────────────────────────────────────
  { where: 'primary button label', fg: 'white', bg: 'infini-700', kind: 'normal' },
  { where: 'primary button label, hover', fg: 'white', bg: 'infini-800', kind: 'normal' },
  { where: 'primary button label, pressed', fg: 'infini-900', bg: 'white', kind: 'normal' },

  /*
   * Gradient buttons.
   *
   * A vertical face gradient is judged on its LIGHTEST stop, because that is where the
   * top of the label sits. Testing only the `to` stop passes a button whose upper half is
   * unreadable — the label has a single colour and it meets the face at its faintest
   * point, so the faintest point is what sets the real ratio.
   *
   * `--color-infini-600` is the top of the primary face and the bottom of the pressed
   * face, so it has to hold white text at AA in both directions' worst case.
   */
  { where: 'primary button gradient, lightest stop', fg: 'white', bg: 'infini-600', kind: 'normal' },
  { where: 'danger button gradient, lightest stop', fg: 'white', bg: 'danger', kind: 'normal' },
  { where: 'secondary button gradient, darkest stop', fg: 'ink-800', bg: 'line', kind: 'normal' },

  { where: 'danger button label', fg: 'white', bg: 'danger', kind: 'normal' },
  { where: 'success badge', fg: 'white', bg: 'success', kind: 'normal' },
  { where: 'warning badge', fg: 'white', bg: 'warning', kind: 'normal' },
  { where: 'secondary button label', fg: 'ink-800', bg: 'white', kind: 'normal' },

  // ── The dark shell ─────────────────────────────────────────────────────────
  { where: 'sidebar inactive link', fg: 'ink-200', bg: 'ink-900', kind: 'normal' },
  { where: 'sidebar active link', fg: 'white', bg: 'ink-900', kind: 'normal' },
  { where: 'sidebar section label', fg: 'ink-400', bg: 'ink-900', kind: 'normal' },
  { where: 'sidebar footer scope', fg: 'ink-300', bg: 'ink-900', kind: 'normal' },
  { where: 'sidebar active icon', fg: 'infini-300', bg: 'ink-900', kind: 'normal' },
  { where: 'sidebar inactive icon', fg: 'ink-400', bg: 'ink-900', kind: 'large' },
  { where: 'wordmark "Infini" on the dark shell', fg: 'infini-400', bg: 'ink-900', kind: 'normal' },
  { where: 'wordmark "Health" on the dark shell', fg: 'white', bg: 'ink-900', kind: 'normal' },
  { where: 'wordmark subtitle on the dark shell', fg: 'ink-300', bg: 'ink-900', kind: 'normal' },
  { where: 'footer link on the dark panel', fg: 'ink-200', bg: 'ink-900', kind: 'normal' },
  { where: 'footer small print on the dark panel', fg: 'ink-400', bg: 'ink-900', kind: 'normal' },
  { where: 'sign-in page body copy on the dark panel', fg: 'ink-200', bg: 'ink-900', kind: 'normal' },
  { where: 'sign-in page term labels', fg: 'ink-300', bg: 'ink-900', kind: 'normal' },
]

let failures = 0

for (const pair of PAIRS) {
  // white is a Tailwind built-in rather than a token in index.css, so it is resolved
  // here. Only this one literal is special-cased; everything else must come from the file
  // so that retuning a ramp cannot leave the checker agreeing with a stale value.
  const resolve = (name: string): [number, number, number] =>
    name === 'white' ? [1, 1, 1] : oklchToRgb(...token(name))
  const fg = resolve(pair.fg)
  const bg = resolve(pair.bg)
  const value = ratio(fg, bg)
  const required = pair.kind === 'normal' ? 4.5 : 3.0
  const passed = value >= required

  if (!passed) failures += 1

  console.log(
    `  ${passed ? 'PASS' : 'FAIL'}  ${value.toFixed(2).padStart(5)}:1  ` +
      `(needs ${required})  ${pair.where}  [${pair.fg} on ${pair.bg}]`,
  )
}

console.log(`\n${PAIRS.length - failures}/${PAIRS.length} pairings meet WCAG AA.`)

if (failures > 0) {
  console.log(
    '\nA design system whose own comment claims AA while its tokens fail AA is worse ' +
      'than one that never claimed it: the claim is what people rely on when they are ' +
      'shipping, not the numbers.',
  )
  process.exit(1)
}