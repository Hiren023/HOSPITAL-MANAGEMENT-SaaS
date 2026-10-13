# Specification — Subscription management

**Status: IMPLEMENTED.** Phase 9, Change 1 of 3. 46 tests in
`apps/api/src/tests/phase9-subscriptions.test.ts`, 14 in
`apps/web/src/features/hospital/subscription.test.tsx`.

Modules A (Notifications) and B (Pharmacy) follow as separate changes.

**Decisions confirmed and implemented:** plan limits **refuse** rather than report overage;
suspension **allows reads** and refuses writes; 14-day trial on Starter and Hospital, none
on Enterprise. The commercial question in §9.1 — whether per-module gating is realistic — is
noted below rather than assumed away.

The sections below are the **specification as written before coding**. Where
implementation corrected a claim, the correction is recorded in place rather than edited
out; see §1.

---

## 1. What exists today

Phase 4 added **plan assignment only**: `PUT /platform/hospitals/:id/plan` writes `plan` and
`planChangedAt` to the hospital document, and `PLAN_DEFINITIONS` in
`packages/shared/src/types/plan.ts` carries a seat limit and a department limit per plan.

**Not enforced today:** `seatLimit` **or** `departmentLimit`. Both were carried in
`PLAN_DEFINITIONS` from Phase 4 and both were only ever *displayed* — the plan card said
"3 seats" while nothing stopped a fourth invitation, and "2 departments" while nothing
stopped a third. Nothing in the codebase counted either. Both gaps close in this change.

> **Correction.** An earlier draft of this document claimed `seatLimit` was "enforced today,
> on staff assignment". That was wrong. A grep for `seatLimit` across `apps/api/src` found
> it only in three response builders and one test assertion, and no check anywhere on a
> write path. The number was a decoration. It is recorded here rather than quietly
> corrected because the same wrong claim is easy to make twice.

**Not present:** feature entitlements, subscription status, trial, renewal, grace periods,
suspension-on-non-payment, usage, or any payment-provider integration.

This change extends that foundation rather than replacing it. `PLANS` and
`PLAN_DEFINITIONS` stay where they are, so the client and server cannot disagree about what
"on the Starter plan" means.

---

## 2. Requirements

| # | Requirement |
| --- | --- |
| S1 | A subscription has a plan, a status, a trial window, a renewal date and a history of changes. |
| S2 | **Feature entitlements are enforced on the backend.** A tenant on a plan without pharmacy gets `403` from the API — not a hidden button. |
| S3 | Plan limits are enforced server-side, including `seatLimit` and `departmentLimit`, neither of which is enforced today. |
| S4 | Trial: a period during which a tenant has full access, with an explicit end. Expiry is visible and does not silently destroy data. |
| S5 | Suspension on non-payment is a **rule**, not an action someone must remember: past `gracePeriodDays`, the subscription becomes `SUSPENDED` and access is refused. |
| S6 | Suspension **never deletes data.** A suspended tenant's records remain, readable on reactivation. |
| S7 | A payment-provider adapter exists as an interface, and the default implementation **cannot report success**. |
| S8 | A hospital administrator can see their plan, entitlements, usage and renewal date. |
| S9 | Every subscription change is audited, with before and after. |
| S10 | An unknown or expired entitlement fails **closed** — never open. |

### Non-goals, stated so nobody assumes otherwise

No proration. No invoicing. No dunning emails. No automatic refunds. No tax handling. No
real payment provider is wired up. A provider integration requires a separate security
review (`docs/SECURITY.md` R16).

---

## 3. Schema

### 3.1 `plans` (reference data — stays in shared, extended)

```ts
PlanDefinition {
  plan: Plan
  label: string
  seatLimit: number | null          // null = unlimited
  departmentLimit: number | null
  /** NEW — the whole point of this change. */
  entitlements: readonly ModuleKey[]
  trialDays: number
  monthlyPriceMinor: number         // integer minor units, per docs/MONEY.md
}
```

`ModuleKey = 'CLINICAL' | 'BILLING' | 'ATTENDANCE' | 'PHARMACY' | 'LABORATORY' | 'REPORTS'`

Entitlements are **additive from the plan**, never client-supplied. A request cannot widen
them.

### 3.2 `Subscription` (new, tenant-scoped)

| Field | Type | Notes |
| --- | --- | --- |
| `hospitalId` | ObjectId | unique |
| `plan` | enum | mirrors `Hospital.plan` for read-back |
| `status` | `TRIAL \| ACTIVE \| PAST_DUE \| SUSPENDED \| EXPIRED \| CANCELLED` | |
| `trialEndsAt` | Date | absent for a plan with no trial |
| `currentPeriodStartsAt` / `currentPeriodEndsAt` | Date | renewal is `currentPeriodEndsAt` |
| `gracePeriodEndsAt` | Date | set when payment fails |
| `suspendedAt` | Date | |
| `cancelAtPeriodEnd` | Boolean | downgrade-at-renewal, not an immediate cancel |
| `provider` | String \| null | which adapter, when one exists |
| `providerSubscriptionId` | String \| null | the provider's own reference |
| `paymentState` | `NONE \| PENDING \| VERIFIED \| FAILED` | mirrors Phase 8 |
| `history` | `[]` | append-only: plan, status, reason, actor, at |

Indexes: `{hospitalId}` unique, `{status}`, `{currentPeriodEndsAt}`.

### 3.3 Usage

**As originally specified:** a `UsageCounter` collection, `{hospitalId, moduleKey, used,
limit, periodStart, periodEnd}`, unique on `{hospitalId, moduleKey}`.

**As implemented: removed.** A stored counter has to be updated on *every* path that changes
what it counts — new staff, deleted staff, a deactivated membership, a role change, a
reactivation. Miss one and the cache disagrees with reality, and the screen says "3 of 3
seats" while four people hold seats. Two indexed `countDocuments` calls on one screen is not
a performance problem; a usage figure that can be wrong is worse than a slightly slow one,
because it is presented with the same confidence either way.

Usage is now counted live and keyed by the resource being limited (`seats`, `departments`)
rather than by module, so the client renders a label it already has instead of looking up
which module happens to own the seat count. `docs/ARCHITECTURE.md` §3.22 has the full
reasoning, and a test asserts that deactivating a membership moves the figure.

### 3.4 `PaymentProvider` (interface only)

```ts
interface PaymentProvider {
  readonly name: string
  createCheckout(input): Promise<{ checkoutUrl: string; providerRef: string }>
  /** Returns PENDING. Cannot return VERIFIED — see §7. */
  confirmCheckout(providerRef: string): Promise<ProviderConfirmation>
  cancelSubscription(providerRef: string): Promise<void>
}
```

---

## 4. API contract

### Platform (SUPER_ADMIN, `platform:plan:manage`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/platform/plans` | Catalogue with entitlements and limits |
| `POST` | `/platform/hospitals/:id/subscription` | Create with plan + trial |
| `PATCH` | `/platform/hospitals/:id/subscription` | Change plan, cancel, grace period |
| `GET` | `/platform/hospitals/:id/subscription` | Full state including history |
| `POST` | `/platform/hospitals/:id/subscription/evaluate` | Run the status rules now (idempotent) |

### Tenant (hospital admin, `hospital:read`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/hospital/subscription` | Plan, status, entitlements, usage, renewal |
| `GET` | `/hospital/entitlements` | Just the module keys — for the shell to hide nav |

### Enforcement (every tenant route)

A middleware reads the subscription and attaches
`{ plan, status, entitlements, suspended }`. Services call
`requireEntitlement(ctx, 'PHARMACY')`, which throws `403 ENTITLEMENT_REQUIRED` with the
plans that do include it.

**As implemented, slightly differently and for a better reason:** the gate is applied by
`createTenantRouter({ module })` — a property of the *router*, not a line repeated on each
route. Listing `requireModule('BILLING')` on 30 billing routes would work right up until
somebody added a 31st and forgot, and the failure is silent because a missing gate looks
exactly like a working route until a tenant on the Starter plan reaches it. See
`docs/ARCHITECTURE.md` §3.18.

The refusal message names the plan and the fix rather than just closing the door:

> The Starter plan does not include billing. Upgrade to enable it.

---

## 5. Permissions

| Permission | Holder | Why |
| --- | --- | --- |
| `platform:plan:manage` | SUPER_ADMIN | already exists |
| `subscription:read` | HOSPITAL_ADMIN, ACCOUNTANT | view own plan and usage |
| `notification:*` (module A) | see module A | |

**No new permission for self-suspension.** A tenant cannot suspend itself; only the platform
operator or an automatic rule can.

Entitlements are **not** permissions. A permission says *who you are*; an entitlement says
*what your hospital bought*. Conflating them would let someone grant clinical access by
buying a plan, or lose billing access by changing roles.

---

## 6. UI

- **Platform:** plan editor, subscription state, trial/renewal, history, "run rules now".
- **Hospital admin:** a "Your plan" card — plan, status, renewal date, days to renewal,
  usage bars (seats / departments / modules), and a clear banner when `PAST_DUE` or
  `SUSPENDED`.

**A suspended tenant sees a full-page banner, not a broken app.** Records are still readable;
writes are refused with an explanation. Suspending must never look like data loss.

---

## 7. The payment adapter, and why it cannot fake success

The default adapter is `NullPaymentProvider`: it creates no checkout, reports `NONE`, and
every state derived from it is `PENDING` or `FAILED`.

**`VERIFIED` is only ever set by an explicit reconciliation call that names a person**, exactly
as Phase 8 does for gateway payments. This mirrors the billing rule deliberately: money that
nobody confirmed is not money.

The interface has **no method that returns `VERIFIED`**. A future adapter that wants to set
it must go through the same reconciliation path a human uses. A provider saying "paid" is a
claim, not a fact — Phase 8 already learned that lesson and it applies identically here.

---

## 8. Tests (planned)

| Area | Cases |
| --- | --- |
| Entitlements | each module refused on a plan without it; granted on one with it; **unknown module fails closed** |
| Limits | `departmentLimit` enforced (today it is not); `seatLimit` enforced (today it is not); seats at the boundary; unlimited plans unaffected |
| Trial | active during trial; expiry status; **trial expiry never deletes data** |
| Suspension | `PAST_DUE` → grace → `SUSPENDED`; reads still work, writes refused |
| Upgrade/downgrade | immediate change; `cancelAtPeriodEnd` takes effect at renewal |
| Provider | `NullPaymentProvider` reports `PENDING`; **`VERIFIED` unreachable via any adapter method** |
| Isolation | subscription read across tenants returns 404 |
| Audit | every plan and status change carries before/after |
| UI | banner states, usage rendering, nav hidden per entitlement |

---

## 9. Decisions I want confirmed before coding

1. **Module gating granularity** — is "billing off on Starter" a realistic commercial rule, or would that be a support problem? I have assumed per-module gating and would rather know now.
2. **`departmentLimit` enforcement** — should exceeding it refuse creation, or allow it and report overage? I have assumed **refuse**, which is the stricter reading.
3. **Trial length per plan** — I have assumed 14 days on Starter, none on Enterprise. Purely a commercial number.
4. **Does suspension block reads?** I have assumed **no** — writes refused, reads allowed. Alternative: block everything, which is a bigger hammer and worse for a hospital that needs to read its own records.
5. **Currency** — `monthlyPriceMinor` assumes the hospital's configured currency and 2-digit minor units, per `docs/MONEY.md`. A zero-decimal currency would break that assumption.

---

## 10. Sequencing

This change adds no notification or pharmacy code. It adds a module gate that modules A and
B will later sit behind. Each of the three changes can ship, revert and be tested
independently.