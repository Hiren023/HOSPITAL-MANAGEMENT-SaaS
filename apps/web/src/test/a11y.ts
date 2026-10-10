import axe, { type AxeResults, type RunOptions } from 'axe-core'

/**
 * Accessibility assertions.
 *
 * `axe-core` is used directly rather than a wrapper, so the check is not tied to a
 * third-party test runner's peer versions.
 *
 * Note: the `color-contrast` rule is disabled because jsdom performs no layout and
 * therefore cannot compute rendered colours. Contrast is verified by design-token
 * review and by manual/automated checks in a real browser during Phase 8.
 */

export async function runAxe(container: Element, options: RunOptions = {}): Promise<AxeResults> {
  return axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
    ...options,
  })
}

/** Fails the test with a readable summary if any serious or critical violation exists. */
export async function expectNoSeriousViolations(container: Element): Promise<AxeResults> {
  const results = await runAxe(container)

  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  )

  if (blocking.length > 0) {
    const summary = blocking
      .map((violation) => `- ${violation.id} (${violation.impact}): ${violation.help}`)
      .join('\n')
    throw new Error(`Accessibility violations detected:\n${summary}`)
  }

  return results
}
