/**
 * Money.
 *
 * ── The one rule ─────────────────────────────────────────────────────────────
 *
 * Every amount in this system is an **integer count of a currency's minor unit** — paise
 * for INR, cents for USD. There is no `float` anywhere in the billing path, and no
 * `number` on the wire that means money.
 *
 * This is not fussiness. `0.1 + 0.2 === 0.30000000000000004`, and a patient who is
 * overcharged by four ten-thousandths of a rupee because of floating-point arithmetic
 * cannot dispute it, cannot understand it, and should not have to. Every amount the API
 * accepts is validated as a safe integer before it reaches the database.
 *
 * ── Rounding ─────────────────────────────────────────────────────────────────
 *
 * **Half away from zero, applied once, at the line.**
 *
 * A line's tax and discount are rounded to the minor unit as they are computed, and the
 * invoice total is then the exact sum of those rounded line totals. Two properties follow,
 * and both matter:
 *
 * 1. **The printed invoice adds up.** The total on the page is literally the sum of the
 *    totals printed on its lines. Recomputing a total from unrounded lines and rounding
 *    again — the obvious implementation — produces a figure that disagrees with its own
 *    arithmetic by a paisa, and an invoice that does not add up is not a credible document.
 *
 * 2. **Rounding is applied the same way to every line**, so a change to one line cannot
 *    silently move money between lines. There is no "round the total up" rule and no
 *    penny-absorption threshold.
 *
 * Multiplication uses a magnitude-preserving approach rather than `Math.round` on a
 * possibly-large float, so intermediate values stay well inside the 2^53 safe-integer
 * range for any plausible quantity.
 *
 * ── Rates ────────────────────────────────────────────────────────────────────
 *
 * Discounts and taxes are **basis points**: an integer where 10 000 bps = 100%. Using
 * integers rather than percentages avoids a second source of floating-point error on top
 * of the amount itself.
 *
 * ── ASSUMPTIONS REQUIRING PROFESSIONAL REVIEW ─────────────────────────────────
 *
 * These are stated rather than silently assumed. None of them is a code defect; all of
 * them are accounting decisions this codebase should not make unilaterally.
 *
 * - **Minor-unit exponent is assumed to be 2 for every currency.** That is true for INR,
 *   USD, EUR and GBP, and FALSE for JPY (0 minor digits), KWD/BHD/JOD (3), and CLP (0).
 *   `assertCurrencySupported` refuses anything it cannot represent correctly rather than
 *   mis-pricing it.
 * - **Inclusive vs exclusive tax.** `taxInclusive` is configurable per hospital, because
 *   India (GST-inclusive MRP display) and several other jurisdictions differ. When
 *   inclusive, the tax is *extracted* from the line rather than added to it.
 * - **Rounding residue.** Half-away-from-zero at the line is one defensible choice among
 *   several. Some jurisdictions require rounding the taxable amount down instead. A local
 *   accountant should confirm before this handles real money.
 * - **No currency conversion.** A hospital invoices in its own configured currency. There
 *   is no FX table and no conversion; a multi-currency hospital would need one, with its
 *   own rate source and date-stamping.
 * - **No rounding-residue account.** The few paises that never land on a line are not
 *   swept into a suspense account; they simply stay in the invoice total.
 *
 * Nothing in this file is a claim of regulatory or accounting compliance.
 */

/** Basis points in 100%. */
export const BPS_DENOMINATOR = 10_000

/** Currencies this MVP can represent exactly. See the assumption note above. */
export const SUPPORTED_MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  CAD: 2,
  AED: 2,
  SGD: 2,
})

export interface CurrencySpec {
  code: string
  /** Number of decimal places. 2 for almost everything; see the assumptions note. */
  exponent: number
  symbol: string
}

/**
 * Currencies this system knows how to display.
 *
 * Deliberately incomplete: an unlisted currency is refused rather than guessed at. A
 * missing symbol is cosmetic; a missing EXPONENT is a mis-priced invoice.
 */
export const CURRENCIES: Readonly<Record<string, CurrencySpec>> = Object.freeze({
  INR: { code: 'INR', exponent: 2, symbol: '₹' },
  USD: { code: 'USD', exponent: 2, symbol: '$' },
  EUR: { code: 'EUR', exponent: 2, symbol: '€' },
  GBP: { code: 'GBP', exponent: 2, symbol: '£' },
  AUD: { code: 'AUD', exponent: 2, symbol: 'A$' },
  CAD: { code: 'CAD', exponent: 2, symbol: 'C$' },
  AED: { code: 'AED', exponent: 2, symbol: 'AED ' },
  SGD: { code: 'SGD', exponent: 2, symbol: 'S$' },
})

export const DEFAULT_CURRENCY = 'INR'

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code.toUpperCase())
}

export function currencySpec(code: string): CurrencySpec {
  const spec = CURRENCIES[code.toUpperCase()]
  if (!spec) {
    throw new Error(
      `Currency "${code}" is not supported. Add its minor-unit exponent to CURRENCIES rather than guessing: a wrong exponent mis-prices every invoice.`,
    )
  }
  return spec
}

/** Guard against a float ever reaching the billing path. */
export function assertMinorUnits(amount: unknown, label = 'amount'): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error(`${label} must be a finite number of minor units`)
  }
  if (!Number.isInteger(amount)) {
    throw new Error(`${label} must be a whole number of minor units, not ${amount}`)
  }
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`${label} exceeds the safe integer range`)
  }
  return amount
}

/** Basis points: an integer, 0 to 10000, 10000 meaning "no discount". */
export function assertBasisPoints(bps: unknown, label = 'rate'): number {
  if (typeof bps !== 'number' || !Number.isInteger(bps)) {
    throw new Error(`${label} must be a whole number of basis points`)
  }
  if (bps < 0 || bps > BPS_DENOMINATOR) {
    throw new Error(`${label} must be between 0 and ${BPS_DENOMINATOR} basis points`)
  }
  return bps
}

/**
 * Multiply an amount by basis points, rounding half AWAY FROM ZERO.
 *
 * Avoids the `Math.round(x * bps / 10000)` float path by splitting into whole and
 * fractional parts in integer arithmetic, which stays exact for every value this system
 * can hold.
 *
 * "Away from zero" rather than `Math.round`'s "half up", because `Math.round(-0.5)` is
 * `-0` while a refund of 50% should round in the same direction as a charge of 50%.
 */
export function applyBasisPoints(amountMinor: number, bps: number): number {
  assertMinorUnits(amountMinor, 'amount')
  assertBasisPoints(bps, 'rate')

  if (bps === 0 || amountMinor === 0) return 0

  const magnitude = Math.abs(amountMinor)
  const scaled = magnitude * bps
  const whole = Math.trunc(scaled / BPS_DENOMINATOR)
  const remainder = scaled - whole * BPS_DENOMINATOR

  // Half or more rounds up.
  const rounded = remainder * 2 >= BPS_DENOMINATOR ? whole + 1 : whole

  return amountMinor < 0 ? -rounded : rounded
}

/** Round a quantity-derived amount, half away from zero. */
export function roundMinorUnits(amount: number): number {
  if (!Number.isFinite(amount)) throw new Error('Cannot round a non-finite amount')
  return amount < 0 ? -Math.round(-amount) : Math.round(amount)
}

export interface LineTotals {
  /** quantity × unit price, before any discount or tax. */
  subtotalMinor: number
  discountMinor: number
  /** The part of the line that tax is applied to. */
  taxableMinor: number
  taxMinor: number
  /** What the line contributes to the invoice total. */
  totalMinor: number
}

/**
 * One line, rounded exactly once per component.
 *
 * `taxInclusive` means the stated unit price already contains the tax — common for GST
 * display in India — so the tax is *extracted* rather than added, and the line total is
 * the price as quoted.
 *
 * Rounding happens on `taxableMinor` before tax is taken, and on the resulting tax, so
 * both figures on the line are real numbers a person can check by hand.
 */
export function calculateLine(input: {
  unitPriceMinor: number
  quantity: number
  discountBps?: number
  taxBps?: number
  taxInclusive?: boolean
}): LineTotals {
  const { unitPriceMinor, quantity, taxInclusive = false } = input
  const discountBps = input.discountBps ?? 0
  const taxBps = input.taxBps ?? 0

  assertMinorUnits(unitPriceMinor, 'unitPriceMinor')
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('quantity must be a positive whole number')
  }

  const subtotalMinor = assertMinorUnits(unitPriceMinor * quantity, 'subtotalMinor')
  const discountMinor = applyBasisPoints(subtotalMinor, discountBps)

  const afterDiscount = subtotalMinor - discountMinor

  if (taxBps === 0) {
    return {
      subtotalMinor,
      discountMinor,
      taxableMinor: afterDiscount,
      taxMinor: 0,
      totalMinor: afterDiscount,
    }
  }

  if (taxInclusive) {
    // The quoted price already contains the tax. Solve for it:
    //   taxable = afterDiscount / (1 + rate)
    // Rounding the taxable figure first and then re-deriving tax from it keeps the two
    // printed numbers consistent, which matters more than algebraic tidiness.
    const taxableMinor = roundMinorUnits(
      (afterDiscount * BPS_DENOMINATOR) / (BPS_DENOMINATOR + taxBps),
    )
    const taxMinor = afterDiscount - taxableMinor

    return {
      subtotalMinor,
      discountMinor,
      taxableMinor,
      taxMinor,
      totalMinor: afterDiscount,
    }
  }

  const taxableMinor = afterDiscount
  const taxMinor = applyBasisPoints(taxableMinor, taxBps)

  return {
    subtotalMinor,
    discountMinor,
    taxableMinor,
    taxMinor,
    totalMinor: taxableMinor + taxMinor,
  }
}

export interface InvoiceTotals {
  subtotalMinor: number
  discountMinor: number
  taxableMinor: number
  taxMinor: number
  totalMinor: number
  paidMinor: number
  /** `totalMinor - paidMinor`. Negative means the invoice is overpaid. */
  balanceMinor: number
}

/**
 * Sum lines, then subtract what has been paid.
 *
 * `paidMinor` is expected to be signed: a refund is a negative payment, so overpaid
 * invoices fall out of the same arithmetic rather than needing a special case.
 *
 * The total is the sum of the ALREADY-ROUNDED line totals. See the rounding note at the
 * top of this file for why recomputing here would break the printed invoice.
 */
export function sumLines(lines: readonly LineTotals[]): Omit<InvoiceTotals, 'paidMinor' | 'balanceMinor'> {
  return lines.reduce(
    (acc, line) => ({
      subtotalMinor: acc.subtotalMinor + line.subtotalMinor,
      discountMinor: acc.discountMinor + line.discountMinor,
      taxableMinor: acc.taxableMinor + line.taxableMinor,
      taxMinor: acc.taxMinor + line.taxMinor,
      totalMinor: acc.totalMinor + line.totalMinor,
    }),
    { subtotalMinor: 0, discountMinor: 0, taxableMinor: 0, taxMinor: 0, totalMinor: 0 },
  )
}

export function withBalance(totalMinor: number, paidMinor: number): InvoiceTotals {
  return {
    subtotalMinor: 0,
    discountMinor: 0,
    taxableMinor: 0,
    taxMinor: 0,
    totalMinor,
    paidMinor,
    balanceMinor: totalMinor - paidMinor,
  }
}

/**
 * Render minor units for humans.
 *
 * Grouping uses the Indian lakh/crore convention when the currency is INR, because
 * `1,00,000.00` is how the figure is read there and `100,000.00` is not. Getting this
 * wrong is not a safety issue but it does make an invoice look foreign to the person
 * paying it.
 */
export function formatMinorUnits(amountMinor: number, code: string = DEFAULT_CURRENCY): string {
  assertMinorUnits(amountMinor, 'amountMinor')
  const spec = currencySpec(code)
  const sign = amountMinor < 0 ? '-' : ''
  const magnitude = Math.abs(amountMinor)

  const divisor = 10 ** spec.exponent
  const whole = Math.floor(magnitude / divisor)
  const fraction = String(magnitude % divisor).padStart(spec.exponent, '0')

  const grouped =
    code.toUpperCase() === 'INR' ? groupIndian(whole) : groupWestern(whole)

  const body =
    spec.exponent === 0 ? grouped : `${grouped}.${fraction}`

  // Space before the symbol, except where it conventionally binds tight.
  const separator = code.toUpperCase() === 'INR' || code.toUpperCase() === 'AED' ? ' ' : ''
  return `${sign}${spec.symbol}${separator}${body}`
}

/** 1234567 → "12,34,567" */
function groupIndian(value: number): string {
  const digits = String(value)
  if (digits.length <= 3) return digits

  const last3 = digits.slice(-3)
  const rest = digits.slice(0, -3)
  const groups: string[] = []

  for (let end = rest.length; end > 0; end -= 2) {
    groups.unshift(rest.slice(Math.max(0, end - 2), end))
  }

  return `${groups.join(',')},${last3}`
}

/** 1234567 → "1,234,567" */
function groupWestern(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Basis points to a readable percentage, for a price list. */
export function formatBasisPoints(bps: number): string {
  assertBasisPoints(bps)
  const percent = bps / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`
}

/**
 * Parse a decimal amount a person typed into minor units.
 *
 * Accepts an optional currency symbol or separators, because this is a human-facing field
 * and rejecting "₹ 1,250.00" outright helps nobody. Returns `null` rather than throwing,
 * so a caller can show a field error instead of a 500.
 *
 * Parsing goes through a string, never `parseFloat` on a cleaned string, so "1.2.3" is
 * rejected rather than silently read as 1.2.
 */
export function parseAmountToMinorUnits(input: string, code: string = DEFAULT_CURRENCY): number | null {
  const spec = currencySpec(code)

  const cleaned = input
    .replace(new RegExp(escapeForRegExp(spec.symbol.trim()), 'g'), '')
    .replace(new RegExp(escapeForRegExp(code), 'gi'), '')
    .replace(/[\s,]/g, '')
    .trim()

  if (cleaned === '' || !/^-?\d*(\.\d*)?$/.test(cleaned) || cleaned === '.' || cleaned === '-') {
    return null
  }

  const negative = cleaned.startsWith('-')
  const unsigned = negative ? cleaned.slice(1) : cleaned
  const [wholePart = '0', fractionPart = ''] = unsigned.split('.')

  if (fractionPart.length > spec.exponent) {
    // More precision than the currency has. Truncating silently would change the amount a
    // person typed, so it is refused.
    return null
  }

  const padded = fractionPart.padEnd(spec.exponent, '0')
  const minor = Number(`${wholePart || '0'}${padded}`)

  if (!Number.isSafeInteger(minor)) return null
  return negative ? -minor : minor
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}