import { describe, expect, it } from 'vitest'

import {
  applyBasisPoints,
  assertBasisPoints,
  assertMinorUnits,
  calculateLine,
  formatBasisPoints,
  formatMinorUnits,
  isSupportedCurrency,
  parseAmountToMinorUnits,
  sumLines,
  withBalance,
} from './money.js'

/**
 * Money.
 *
 * The properties tested here are the ones a billing system fails on silently: a total
 * that does not equal the sum of its own printed lines, a rounding rule that moves a paisa
 * between lines, and a float that survives into the database.
 */

describe('integer minor units', () => {
  it('refuses anything that is not a whole number', () => {
    expect(() => assertMinorUnits(10.5)).toThrow(/whole number/)
    expect(() => assertMinorUnits(Number.NaN)).toThrow(/finite/)
    expect(() => assertMinorUnits('100')).toThrow(/finite/)
    expect(() => assertMinorUnits(2 ** 53)).toThrow(/safe integer/)
    expect(assertMinorUnits(-250)).toBe(-250)
  })

  it('refuses a rate outside 0-10000 basis points', () => {
    expect(() => assertBasisPoints(-1)).toThrow(/between 0/)
    expect(() => assertBasisPoints(10_001)).toThrow(/between 0/)
    expect(() => assertBasisPoints(12.5)).toThrow(/whole number/)
    expect(assertBasisPoints(0)).toBe(0)
    expect(assertBasisPoints(10_000)).toBe(10_000)
  })

  it('refuses a currency whose minor-unit exponent is unknown', () => {
    // Guessing an exponent mis-prices every invoice, so this refuses rather than assuming.
    expect(isSupportedCurrency('JPY')).toBe(false)
    expect(isSupportedCurrency('inr')).toBe(true)
    expect(() => formatMinorUnits(100, 'JPY')).toThrow(/not supported/)
  })
})

describe('basis points', () => {
  it('applies a percentage without floating-point drift', () => {
    // 10% of 1000 is exactly 100.
    expect(applyBasisPoints(1000, 1000)).toBe(100)
    // The classic float trap: 0.1 + 0.2 as a percentage of a round number.
    expect(applyBasisPoints(30, 3333)).toBe(10)
    expect(applyBasisPoints(7, 5000)).toBe(4) // 3.5 rounds away from zero
  })

  it('rounds half away from zero in BOTH directions', () => {
    // Math.round(-3.5) is -3, which would make a refund round the "wrong" way relative
    // to the equivalent charge. Discounts and refunds must behave symmetrically.
    expect(applyBasisPoints(7, 5000)).toBe(4)
    expect(applyBasisPoints(-7, 5000)).toBe(-4)
  })

  it('is a no-op at zero', () => {
    expect(applyBasisPoints(1234, 0)).toBe(0)
    expect(applyBasisPoints(0, 5000)).toBe(0)
  })

  it('formats readably', () => {
    expect(formatBasisPoints(1000)).toBe('10%')
    expect(formatBasisPoints(1825)).toBe('18.25%')
  })
})

describe('line totals', () => {
  it('computes a simple line', () => {
    expect(
      calculateLine({ unitPriceMinor: 250_00, quantity: 2 }),
    ).toEqual({
      subtotalMinor: 500_00,
      discountMinor: 0,
      taxableMinor: 500_00,
      taxMinor: 0,
      totalMinor: 500_00,
    })
  })

  it('rejects a non-positive or fractional quantity', () => {
    expect(() => calculateLine({ unitPriceMinor: 100, quantity: 0 })).toThrow(/positive/)
    expect(() => calculateLine({ unitPriceMinor: 100, quantity: 1.5 })).toThrow(/positive/)
  })

  it('adds tax after a discount, not before', () => {
    // 1000, 10% off → 900 taxable, 18% tax → 162, total 1062.
    const line = calculateLine({ unitPriceMinor: 1000, quantity: 1, discountBps: 1000, taxBps: 1800 })

    expect(line.discountMinor).toBe(100)
    expect(line.taxableMinor).toBe(900)
    expect(line.taxMinor).toBe(162)
    expect(line.totalMinor).toBe(1062)
  })

  it('extracts rather than adds tax when prices are inclusive', () => {
    // A quoted 118 including 18% → 100 taxable, 18 tax, total stays 118.
    const line = calculateLine({ unitPriceMinor: 118, quantity: 1, taxBps: 1800, taxInclusive: true })

    expect(line.taxableMinor).toBe(100)
    expect(line.taxMinor).toBe(18)
    expect(line.totalMinor).toBe(118)
  })

  it('keeps an inclusive line equal to the quoted price', () => {
    // The customer must be charged the number on the price list. If the total ever drifts
    // from the quoted price, an inclusive price list is a lie.
    const line = calculateLine({ unitPriceMinor: 99_999, quantity: 3, taxBps: 500, taxInclusive: true })
    expect(line.totalMinor).toBe(99_999 * 3)
  })
})

describe('invoice totals', () => {
  it('sums lines so the printed invoice adds up', () => {
    const lines = [
      calculateLine({ unitPriceMinor: 333, quantity: 3 }),
      calculateLine({ unitPriceMinor: 101, quantity: 7 }),
      calculateLine({ unitPriceMinor: 5, quantity: 11 }),
    ]

    const totals = sumLines(lines)

    // The point of rounding at the line and summing afterwards: the total is exactly the
    // sum of what is printed on each line. Recomputing from unrounded figures would drift
    // and the invoice would not add up to itself.
    expect(totals.totalMinor).toBe(lines.reduce((sum, line) => sum + line.totalMinor, 0))
    expect(totals.totalMinor).toBe(999 + 707 + 55)
  })

  it('computes a balance from signed payments', () => {
    expect(withBalance(10_000, 4_000).balanceMinor).toBe(6_000)
    // A partial payment leaves an outstanding balance.
    expect(withBalance(10_000, 10_000).balanceMinor).toBe(0)
    // An overpayment is negative, not clamped: clamping hides the overpayment and makes
    // the next refund impossible to reconcile.
    expect(withBalance(10_000, 10_500).balanceMinor).toBe(-500)
    // A refund is a negative payment, so it reduces what has been settled.
    expect(withBalance(10_000, 10_000 - 1_500).balanceMinor).toBe(1_500)
  })

  it('returns zeroes for no lines', () => {
    expect(sumLines([])).toEqual({
      subtotalMinor: 0,
      discountMinor: 0,
      taxableMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
    })
  })
})

describe('human-readable amounts', () => {
  it('groups Indian currency the way it is read', () => {
    // 1,00,000.00 — not 100,000.00. An invoice that reads foreign to the person paying
    // it is an invoice that gets queried.
    expect(formatMinorUnits(10_000_000, 'INR')).toBe('₹ 1,00,000.00')
    expect(formatMinorUnits(123_456_789, 'INR')).toBe('₹ 12,34,567.89')
  })

  it('groups western currency the western way', () => {
    expect(formatMinorUnits(10_000_000, 'USD')).toBe('$100,000.00')
  })

  it('shows negatives with the sign outside the symbol', () => {
    expect(formatMinorUnits(-250_50, 'INR')).toBe('-₹ 250.50')
  })

  it('refuses an amount beyond exact integer arithmetic', () => {
    // One past Number.MAX_SAFE_INTEGER. A float would accept this silently and round it,
    // which is how an amount ends up stored as a different number than the one requested.
    const beyondSafe = Number.MAX_SAFE_INTEGER + 2
    expect(() => assertMinorUnits(beyondSafe)).toThrow(/safe integer/)
    expect(() => formatMinorUnits(beyondSafe, 'INR')).toThrow(/safe integer/)
  })

  it('formats the largest amount it will accept without drift', () => {
    // Exactly MAX_SAFE_INTEGER, which is the boundary the guard is there to hold.
    const max = Number.MAX_SAFE_INTEGER
    expect(formatMinorUnits(max, 'INR')).toBe('₹ 9,00,71,99,25,47,409.91')
    // And it parses back to the same number, so the display is lossless.
    expect(parseAmountToMinorUnits(formatMinorUnits(max, 'INR').replace('₹ ', ''), 'INR')).toBe(max)
  })
})

describe('parsing what a person typed', () => {
  it('accepts the shapes people actually type', () => {
    expect(parseAmountToMinorUnits('250')).toBe(25_000)
    expect(parseAmountToMinorUnits('250.50')).toBe(25_050)
    expect(parseAmountToMinorUnits('1,250.00')).toBe(125_000)
    expect(parseAmountToMinorUnits('₹ 1,250.00')).toBe(125_000)
    expect(parseAmountToMinorUnits('  99  ')).toBe(9_900)
  })

  it('refuses rather than guessing', () => {
    // parseFloat would read "1.2.3" as 1.2 and quietly bill the wrong amount.
    expect(parseAmountToMinorUnits('1.2.3')).toBeNull()
    expect(parseAmountToMinorUnits('abc')).toBeNull()
    expect(parseAmountToMinorUnits('')).toBeNull()
    expect(parseAmountToMinorUnits('-')).toBeNull()
    // More precision than the currency has. Truncating would change what was typed.
    expect(parseAmountToMinorUnits('10.005')).toBeNull()
  })

  it('round-trips through formatting', () => {
    for (const amount of [0, 1, 99, 12_345, 10_000_000]) {
      const rendered = formatMinorUnits(amount, 'INR').replace('₹ ', '')
      expect(parseAmountToMinorUnits(rendered, 'INR')).toBe(amount)
    }
  })

  it('handles negatives', () => {
    expect(parseAmountToMinorUnits('-250.50')).toBe(-25_050)
  })
})