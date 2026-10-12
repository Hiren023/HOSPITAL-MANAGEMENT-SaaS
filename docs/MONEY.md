# Money, currency and rounding

How this system represents money, what it refuses to do with it, and which decisions need
somebody qualified to make them.

This document exists because money is the one domain where "close enough" is a defect, and
because several of the choices below are genuinely judgement calls that code should not make
on its own.

---

## 1. The one rule

**Every amount is an integer count of a currency's minor unit.** 500 rupees is `50000`. There
is no `float` anywhere in the billing path, and no `number` on the wire that means money.

This is not fussiness. `0.1 + 0.2 === 0.30000000000000004`. A patient overcharged by four
ten-thousandths of a rupee cannot dispute it, cannot understand it, and should not have to.
Every amount is validated as a safe integer before it reaches the database — `assertMinorUnits`
rejects a float, a string, a non-finite number, and anything above `Number.MAX_SAFE_INTEGER`.

The API names every monetary field `*Minor`. There is no field named `amount`, `total` or
`price` that means money, so there is nothing to misread.

## 2. Rounding

**Half away from zero, applied once per component, per line. Totals are then the exact sum of
the already-rounded lines.**

Two properties follow, and both matter:

1. **The printed invoice adds up.** The total on the page is literally the sum of the totals
   printed on its lines. Recomputing a total from unrounded lines and rounding again — the
   obvious implementation — produces a figure that disagrees with its own arithmetic by a
   paisa, and an invoice that does not add up to itself is not a credible document.

2. **Rounding is identical for every line**, so changing one line cannot silently move money
   between lines. There is no "round the total up" rule and no penny-absorption threshold.

`applyBasisPoints` does not use `Math.round(amount * bps / 10000)`. It splits the product into
whole and fractional parts in integer arithmetic, so intermediate values stay exact well past
2^53 for any plausible quantity. It also rounds **away from zero in both directions**:
`Math.round(-3.5)` is `-3`, which would make a refund round differently from the equivalent
charge.

### What is rounded, and when

| Step | Rounded? |
| --- | --- |
| line subtotal = unit price × quantity | No — quantity is an integer, so this is exact |
| discount | Yes, to the minor unit |
| taxable base | No — a subtraction of already-rounded integers |
| tax | Yes, to the minor unit |
| line total | Exact sum of the above |
| invoice total | Exact sum of line totals |
| balance | Exact subtraction |

## 3. Rates

Discounts and taxes are **basis points**: an integer where `10000 = 100%`. Using integers
rather than percentages removes a second layer of floating-point error on top of the amount
itself. Every rate is bounded `0 ≤ bps ≤ 10000`.

## 4. Inclusive vs exclusive tax

`taxInclusive` is configurable, because jurisdictions genuinely differ — India displays
GST-inclusive MRP, many others add tax at the till.

- **Exclusive** — tax is *added*: `taxable × rate`, rounded once.
- **Inclusive** — the quoted price *contains* the tax, so it is *extracted*:
  `taxable = price / (1 + rate)`, rounded, and `tax = price − taxable`.

The extracted form has a property worth stating: **the line total always equals the quoted
price**. A price list that reads "₹118 incl. 18%" must charge ₹118.00, and if the arithmetic
ever drifted from that, the price list would be a lie. A test asserts this directly.

## 5. The server computes every total

A request carries **line items and nothing else**.

There is no field in which a client's arithmetic could arrive. `createInvoiceSchema` has no
`totalMinor`, no `taxMinor`, no `subtotalMinor`. `.strict()` refuses them, so a client sending
a total gets a `422` rather than a silent success.

This is deliberate and stronger than the obvious alternative. A schema that *accepted* a
client total and then overwrote it would invite someone, later, to "fix" a discrepancy by
using the client's value — and the discrepancy would be the client being wrong.

## 6. No payment credentials are stored

There is **no field** for a card number, CVV, expiry, PAN or account number anywhere in the
billing module. `recordPaymentSchema` is `.strict()`, so sending one is refused rather than
quietly dropped.

What is stored instead: `method` (an enum), `reference` (a receipt number, UPI reference,
cheque number or provider transaction id, capped at 200 characters), and — for gateway
payments — a settlement reference added when someone reconciles.

Storing card data would turn a data breach into a PCI-DSS scope problem, and nothing this
system needs requires it: reconciliation wants a reference, not a credential.

## 7. Manual money is not verified money

Every payment carries two independent facts:

- **`source`** — `MANUAL` (a person asserted it) or `GATEWAY` (a provider claimed it).
- **`verification`** — `UNVERIFIED`, `PENDING` or `VERIFIED`.

They are constrained: a `MANUAL` payment is **always** `UNVERIFIED`, because no system
confirmed it and calling it anything else would be dishonest. A `GATEWAY` payment starts
`PENDING` and only becomes `VERIFIED` through an explicit `POST /payments/:id/verify` that
names who did it. Verification is a **verb**, not a field on the create call, so "verified" is
always an event somebody performed.

**Revenue reports do not return a single total.** They return the amount by verification
status, because these are three different facts:

| Figure | Means |
| --- | --- |
| `manualTotalMinor` | Somebody said cash changed hands. Real, but asserted. |
| `verifiedGatewayTotalMinor` | A provider settlement a named person reconciled. Money in hand. |
| `pendingGatewayTotalMinor` | A provider claim nobody has checked. Not revenue in any sense a treasurer would accept. |
| `settledTotalMinor` | manual + verified − refunds. Named for what it is rather than called "revenue". |

Summing all three would present an unreconciled claim as cash, and a receivables report built
on that number would be wrong in the direction that **hides money**. The CSV export preserves
the split for the same reason.

## 8. Idempotency

`POST /payments` accepts an `Idempotency-Key` header, backed by a **unique index** on
`{hospitalId, idempotencyKey}`.

- First request → `201`, `replayed: false`.
- Repeat with the **same payload** → `200`, `replayed: true`, the original payment returned.
- Repeat with a **different payload** → `409`. Silently replaying would tell a receptionist
  "recorded" about money that was never taken.

The unique index is what makes it safe under concurrency: two simultaneous retries both pass
the pre-check, one insert wins the index, and the loser comes back as a replay. A
check-then-insert has no such guarantee — and "two reception desks press the button at the
same moment" is the real case, not a theoretical one.

Without a key, a repeat charges twice. That is deliberate: the key is the client's assertion
that this is a retry, and inventing one server-side would break two genuinely separate
payments.

## 9. Documents are private

An invoice PDF is stored under an opaque key and served by
`GET /invoices/:id/document`, which re-checks permission at the moment of download and responds
`Cache-Control: private, no-store` with `nosniff` and `Content-Disposition: attachment`.

No URL or storage key appears on the wire. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3.9 for
why a public URL, an "unguessable" path and a signed URL are all rejected.

## 10. Void, never delete

An issued invoice cannot be edited. A mistake is corrected by voiding — which **keeps the
record**, with a mandatory reason — and raising a new invoice.

Voiding is refused while any payment is recorded against the invoice, because voiding would
leave that payment pointing at nothing. Refund it first.

A voided invoice stays in the ledger. The money may already have been reported on, and
deleting the document would make a previously-true report false retroactively.

## 11. Refunds are new records

A refund is a **new payment** with `kind: REFUND`, a positive `amountMinor`, and a
`refundsPaymentId` naming what it reverses. It is never a mutation of the original, and it
cannot exceed what was actually taken.

Amounts are always positive; direction comes from `kind`. Encoding a refund as a negative
number would make every report that sums the field wrong unless it also remembered to
special-case refunds — and at least one of them would forget.

An overpaid invoice shows a **negative** balance rather than a clamped zero. Clamping hides the
overpayment and makes the refund that should follow it impossible to reconcile.

---

# ASSUMPTIONS REQUIRING PROFESSIONAL REVIEW

Everything above is a defensible engineering decision. **Everything below is an accounting
judgement call.** None of it is a code defect, and none of it should be treated as reviewed.
A qualified accountant or tax practitioner should confirm all of it before this handles real
money.

### Currency

- **The minor-unit exponent is assumed to be `2` for every supported currency.** True for
  INR, USD, EUR, GBP, AUD, CAD, AED and SGD. **False** for JPY (0 minor digits), KWD, BHD and
  JOD (3), and CLP (0). Unsupported currencies are **refused** rather than guessed at — a
  wrong exponent mis-prices every invoice on the system, and a missing currency *symbol* is
  merely cosmetic while a missing exponent is catastrophic.
- **No currency conversion exists.** A hospital invoices in its own configured currency. There
  is no FX table, no rate source and no rate date. A genuinely multi-currency hospital needs
  all three, and the question of which rate applies to which invoice (spot at issue, or the
  month-end rate) is an accounting policy decision, not a code default.
- **No rounding-residue or suspense account.** The few minor units that never land on a line
  simply remain in the invoice total. Some jurisdictions require residue to be swept to a
  separate account; that is not implemented.

### Tax

- **Inclusive vs exclusive is configurable per service**, with the hospital's own preference
  applied by default. Which is correct for a given line item depends on how that item is
  advertised, which is a commercial and legal question.
- **Tax is computed per line and rounded per line.** Some jurisdictions require the taxable
  amount to be rounded DOWN before tax is applied, or require tax to be computed on an
  inclusive base differently. **This implementation rounds half away from zero, per line.**
  That choice is not universally correct.
- **No tax categories, no exemptions, no reverse charge, no tax-inclusive price displays
  beyond a per-line flag.** Real GST/VAT handling needs registration thresholds, HSN/SAC
  codes, place-of-supply rules and exemption certificates. None of that exists here.
- **No e-invoicing, no tax invoice numbering per statute, no statutory format.** The invoice
  number (`INV-000001`, per hospital) is a local sequence, not a tax authority's.

### Invoicing and accounting

- **An issued invoice is never edited**; corrections are void-and-reissue. Some jurisdictions
  require a credit note or a debit note rather than a voided original. Those document types
  do not exist here.
- **No fiscal-year or period locking.** An invoice can be issued for a date in a closed period.
  Whether past periods should be lockable is a policy question.
- **`issuedAt` is a timestamp; `issueDate` is a local calendar date.** An invoice carries both,
  and the invoice is attributed to `issueDate`. Whether revenue should be recognised on issue
  date, payment date, or service date is an accounting policy — **this system recognises on
  the payment's `occurredAt`, which may not be what a given business requires.**
- **Hours and staffing are reported for information only.** Nothing here is a payroll input,
  and the attendance report rounds hours per person for display.

### What is deliberately not implemented

Payment gateways, refunds to a gateway, chargebacks, card tokenisation, split payments,
credit notes, discounts that are themselves taxable, deposit/provisional billing, and
insurance claim handling. Each is a significant feature with its own accounting treatment,
and none should be assumed present.

---

**Nothing in this document is a claim of regulatory, tax or accounting compliance.** It is a
description of what the software does and the judgements embedded in it, so that somebody
qualified can review those judgements.

Related: [`API.md`](./API.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) ·
[`SECURITY.md`](./SECURITY.md) · [`TIMEZONE.md`](./TIMEZONE.md)