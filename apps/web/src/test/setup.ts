import '@testing-library/jest-dom/vitest'

/**
 * Global web test setup.
 *
 * jsdom does not implement layout, so matchMedia and scrollIntoView are stubbed for
 * components that query them. Keep this list minimal — stub what is genuinely needed.
 */

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}
