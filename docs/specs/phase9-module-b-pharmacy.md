# Specification — Module B: Pharmacy

**Status: awaiting approval. No code written.**
Phase 9, Change 3 of 3. Shipped **after** subscriptions and module A.

Built in isolation, behind the `PHARMACY` entitlement added by the subscription change.

---

## 1. Requirements

| # | Requirement |
| --- | --- |
| P1 | A medicine catalogue with generic name, brand, strength, form and unit price. |
| P2 | Stock is tracked per **batch**, never as a single number per medicine. |
| P3 | **Expiry is enforced.** Expired stock cannot be dispensed. Near-expiry is visible. |
| P4 | Every movement in and out of stock is a recorded, reasoned, auditable event. |
| P5 | Purchases record supplier, invoice reference, cost and the batches received. |
| P6 | Dispensing is a **workflow** with role gates, not a delete. A dispensed record is corrected by **reversal**, never removed. |
| P7 | Stock can never go negative, enforced by the database as well as the service. |
| P8 | A pharmacist cannot see clinical notes; a doctor cannot dispense. |
| P9 | Every stock movement is attributed to a named person and time. |

### Non-goals

No purchase orders, supplier management, goods-received notes beyond purchase entry,
no barcode scanning, no drug-interaction checking, no controlled-substance register beyond
a flag and a reason, no expiry notifications (that is module A's job later).

---

## 2. Why stock is per batch, and never a single number

"Sell 10 paracetamol" against a single `stock: 500` cannot answer *which* 10, cannot find the
batch expiring next month, and cannot show a recall.

So stock is a set of **batches**, each with `quantity`, `expiryDate`, `purchasePriceMinor`
and a supplier. Available stock is derived, never stored as its own mutable counter.

**Expiry is a hard rule, not a warning.** Dispensing an expired batch is refused. Allowing it
with a yellow triangle is how a hospital ends up dispensing a medicine that has lost its
potency and nobody can reconstruct why.

---

## 3. Schema

### `Medicine` (tenant-scoped)
`{code, genericName, brandName, strength, form, unit, unitPriceMinor, taxBps, requiresPrescription: bool, isActive}`
Unique on `{hospitalId, code}`.

### `Batch`
`{hospitalId, medicineId, batchNumber, expiryDate, quantityReceived, quantityAvailable,
supplierName, purchasePriceMinor, purchaseId, receivedAt, receivedByUserId}`

Unique on `{hospitalId, medicineId, batchNumber}` — one row per batch, so a count query can
never double-count.

Indexes: `{hospitalId, expiryDate}`, `{hospitalId, medicineId, quantityAvailable}`.

### `StockMovement` — append-only
`{hospitalId, medicineId, batchId, kind: PURCHASE|DISPENSE|REVERSAL|ADJUSTMENT|WRITE_OFF,
quantity, reason, referenceType, referenceId, byUserId, at}`

**There is no `update` route on this collection.** Every quantity change is a movement row.
That is what makes the stock figure explainable: sum the movements and you get the current
number, with a reason attached to every delta.

### `Purchase`
`{hospitalId, supplierName, supplierInvoiceRef, invoiceDate, lines[{medicineId, batchNumber,
quantity, unitCostMinor, expiryDate}], totalMinor, status: DRAFT|RECEIVED|CANCELLED,
receivedAt, receivedByUserId}`

### `Dispense`
`{hospitalId, patientId, consultationId?, prescriptionId?, lines[{medicineId, batchId, quantity,
daysSupply}], dispensedByUserId, dispensedAt, reversedAt?, reversalReason?, status:
DISPENSED|REVERSED}`

Linking to a `prescriptionId` when one exists is the safety property: the medicine dispensed
can be compared against what was prescribed, and the two are reconciled.

---

## 4. API contract

### Catalogue

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/pharmacy/medicines` | `pharmacy:read` |
| `POST` | `/pharmacy/medicines` | `pharmacy:write` |
| `PATCH` | `/pharmacy/medicines/:id` | `pharmacy:write` |

### Stock

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/pharmacy/stock` | `pharmacy:read` — filter by `medicineId`, `expiringWithinDays` |
| `GET` | `/pharmacy/batches/:id` | `pharmacy:read` |
| `POST` | `/pharmacy/stock/adjustments` | `pharmacy:write` — **reason mandatory** |

### Purchasing

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/pharmacy/purchases` | `pharmacy:write` — draft |
| `POST` | `/pharmacy/purchases/:id/receive` | `pharmacy:write` — creates batches + movements |
| `GET` | `/pharmacy/purchases` | `pharmacy:read` |

### Dispensing

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/pharmacy/dispenses` | **`pharmacy:dispense`** |
| `POST` | `/pharmacy/dispenses/:id/reverse` | **`pharmacy:dispense`** — reason mandatory |
| `GET` | `/pharmacy/dispenses` | `pharmacy:read` |
| `GET` | `/pharmacy/dispenses/pending` | `pharmacy:read` — what is waiting to be given out |

Dispensing decrements stock through the same `StockMovement` table as everything else. There
is no second code path, because two code paths for "stock went down" is how the numbers stop
reconciling.

---

## 5. Permissions

| Permission | PHARMACIST | DOCTOR | RECEPTIONIST | HOSPITAL_ADMIN | ACCOUNTANT |
| --- | --- | --- | --- | --- | --- |
| `pharmacy:read` | ✅ | ✅ | ❌ | ✅ | ❌ |
| `pharmacy:write` | ✅ | ❌ | ❌ | ✅ | ❌ |
| `pharmacy:dispense` | ✅ | ❌ | ❌ | ✅ | ❌ |

New: **`pharmacy:read`**, **`pharmacy:write`**, **`pharmacy:dispense`** — kept separate
because they are genuinely different jobs.

**A doctor does not get `pharmacy:dispense`.** Prescribing and handing over the medicine are
different acts, and splitting them is a real control: the prescriber cannot also be the only
person who controls the shelf.

`PHARMACIST` deliberately does **not** gain `consultation:read`. Seeing a patient's medicines
is not the same as reading their notes.

---

## 6. Role-based workflow

| Step | Who | Why |
| --- | --- | --- |
| Prescribe | DOCTOR | clinical judgement |
| Dispense | PHARMACIST | custody and stock accuracy |
| Stock receipt | PHARMACIST | custody |
| Price change | HOSPITAL_ADMIN | commercial |

The prescriber and the dispenser are **different people by design**. Where the hospital is
too small to staff both, an administrator holds both — an explicit, visible decision rather
than a default.

---

## 7. Negative stock is prevented twice

1. **Service check** — clear error naming the medicine and the shortfall.
2. **Database** — `findOneAndUpdate` with `quantityAvailable: { $gte: qty }`. If nothing
   matches, nothing was dispensed.

Check-then-decrement has the same race window as check-then-insert: two pharmacists
dispensing the last strip simultaneously both read "1 available" and both dispense it. This is
the Phase 6 slot-grid lesson applied to stock.

---

## 8. UI

- **Catalogue** — search, price, prescription-required flag.
- **Stock** — per batch, with days-to-expiry colouring; expiring-soon and expired sections.
- **Purchase entry** — supplier, lines, batch numbers, expiry dates. Receiving creates batches.
- **Dispensing** — patient search, outstanding prescriptions, confirm and hand over.
- **Movement ledger** — every movement, filterable, read-only.

**Expiry colour is never the only signal.** Colour alone fails for colour-blind users and in
a printed report, so expiry state carries an icon and a text label too.

---

## 9. Tests (planned)

| Area | Cases |
| --- | --- |
| Stock | receipt creates batches; dispense decrements; **negative stock refused by service and by race** |
| Expiry | expired batch refused; expiring-within-30-days visible; expiry date validated |
| Batches | duplicate `batchNumber` for the same medicine refused |
| Workflow | doctor cannot dispense; pharmacist cannot prescribe; receptionist sees nothing |
| Reversal | reversal restores stock, keeps both records, reason mandatory |
| Adjustment | reason mandatory; a stock change with no movement row is impossible |
| Prescriptions | dispensing a `requiresPrescription` medicine without a linked prescription is refused |
| Isolation | cross-tenant medicine, batch and dispense all 404 |
| Audit | every movement attributed to a person and time |
| Entitlement | pharmacy routes refused when the plan excludes `PHARMACY` |

---

## 10. Decisions I want confirmed

1. **Is the prescriber-dispenser split right for an Indian multispecialty hospital?** Many will be one person. I have assumed an administrator can hold both, explicitly.
2. **Controlled substances** — do you need a separate register, or is a flag plus mandatory reason enough for the MVP? I have assumed the latter.
3. **Expiry window for "near expiry".** I have assumed 30 days for the warning, 0 for the block.
4. **Should a patient ever see their own medicines?** I have assumed **no** — no patient portal in this phase.
5. **Purchase prices and unit prices in the hospital's currency** per `docs/MONEY.md`? Both are integer minor units. A retail pharmacy price list is not the same thing as a hospital price list — worth deciding whether they are separate fields.