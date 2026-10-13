import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, CircleSlash, CreditCard } from 'lucide-react'
import { subscriptionStatusLabel, type ModuleKey } from '@infinigrow/shared'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { LoadingState } from '../../components/states/LoadingState.js'

import {
  accessNotice,
  daysUntil,
  fetchOwnSubscription,
  formatDate,
  type UsageEntry,
} from './subscription-api.js'

/**
 * "Your plan" — what this hospital bought, what it has used, and when it renews.
 *
 * ── What this screen deliberately does NOT do ──────────────────────────────────
 *
 * There is no "Upgrade", "Renew" or "Cancel" button. A hospital cannot buy a plan from
 * inside the product, so a button that offered to would be a button that failed. Every
 * state here is a fact the hospital is shown, and the only action offered anywhere is
 * "contact your account manager".
 *
 * ── The banner is a message, not an error ─────────────────────────────────────
 *
 * A suspended hospital still gets here, still reads its patients, and is told plainly
 * that nothing was deleted. Painting that as a red error would be both untrue (its data is
 * right there) and counterproductive (an alarm that cries wolf gets ignored).
 */

/** Human names for the module keys a plan can grant. */
const MODULE_LABELS: Record<ModuleKey, string> = {
  CLINICAL: 'Clinical records',
  BILLING: 'Billing and invoicing',
  ATTENDANCE: 'Staff attendance',
  PHARMACY: 'Pharmacy',
  LABORATORY: 'Laboratory',
  REPORTS: 'Reports',
}

/**
 * A usage bar.
 *
 * The number is always written out in text as well as a bar, because a bar alone is not
 * readable by a screen reader, is invisible in a printed page, and tells a colour-blind
 * reader nothing. `aria-hidden` on the decorative track makes that explicit rather than
 * leaving a meaningless graphic in the accessibility tree.
 */
function UsageBar({ label, entry }: { label: string; entry: UsageEntry | undefined }) {
  if (!entry) return null

  const limit = entry.limit
  const unlimited = limit === null
  const ratio = unlimited || limit === undefined ? 0 : Math.min(1, entry.used / Math.max(1, limit))
  const over = limit !== null && limit !== undefined && entry.used > limit

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-[var(--color-text-secondary)]">{label}</span>
        <span className={over ? 'font-medium text-[var(--color-danger)]' : 'font-medium'}>
          {entry.used} of {entry.displayLimit}
        </span>
      </div>
      <div
        aria-hidden="true"
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-border)]"
      >
        <div
          className={`h-full rounded-full ${over ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-primary)]'}`}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      {over ? (
        <p className="text-xs text-[var(--color-danger)]">
          Over the plan limit. Existing records are unaffected; new ones are refused until
          you upgrade.
        </p>
      ) : null}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  // Colour is never the only signal: the label always spells the state out, so this
  // works in monochrome and for a colour-blind reader.
  const tone =
    status === 'ACTIVE' || status === 'TRIAL'
      ? 'success'
      : status === 'PAST_DUE'
        ? 'warning'
        : 'danger'

  return <Badge tone={tone}>{subscriptionStatusLabel(status as never)}</Badge>
}

export function SubscriptionPage() {
  const query = useQuery({
    queryKey: ['subscription'],
    // Destructured so the query's AbortSignal is threaded through. Passing
    // `queryFn: fetchOwnSubscription` directly would hand React Query's *context object*
    // to a parameter typed `AbortSignal`, so a cancelled request would not actually
    // cancel — and the inferred return type would silently become `{}`.
    queryFn: ({ signal }) => fetchOwnSubscription(signal),
  })

  return (
    <AppShell title="Your plan">
      {query.isPending ? <LoadingState label="Loading your subscription" /> : null}

      {query.isError ? (
        <ErrorState
          title="Your subscription could not be loaded"
          message={
            query.error instanceof Error
              ? query.error.message
              : 'Something went wrong loading your plan.'
          }
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.data ? (
        <SubscriptionBody subscription={query.data} />
      ) : null}
    </AppShell>
  )
}

function SubscriptionBody({
  subscription,
}: {
  subscription: Awaited<ReturnType<typeof fetchOwnSubscription>>
}) {
  const notice = accessNotice(subscription)
  const renewalDays = daysUntil(subscription.currentPeriodEndsAt)

  return (
    <div className="space-y-6">
      {notice ? (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.body}
        </Alert>
      ) : null}

      {subscription.status === 'TRIAL' ? (
        <Alert tone="info" title="Trial in progress">
          Your trial ends on {formatDate(subscription.trialEndsAt)}. Nothing is charged until
          it ends, and no payment method is on file.
        </Alert>
      ) : null}

      {subscription.configured === false ? (
        <Alert tone="warning" title="No subscription is configured">
          This hospital has no subscription record. Access is refused until one is set up
          by your account manager. This is not a normal state.
        </Alert>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader title="Plan" />
          <CardBody>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-2xl font-semibold">{subscription.planLabel}</p>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                  {subscription.hospitalName ?? 'This hospital'}
                </p>
              </div>
              <StatusBadge status={subscription.status} />
            </div>

            <dl className="mt-6 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--color-text-secondary)]">Renews</dt>
                <dd className="text-right">
                  {formatDate(subscription.currentPeriodEndsAt)}
                  <span className="block text-xs text-[var(--color-text-secondary)]">
                    {renewalDays} day{renewalDays === 1 ? '' : 's'} from now
                  </span>
                </dd>
              </div>

              {subscription.trialEndsAt ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--color-text-secondary)]">Trial ends</dt>
                  <dd>{formatDate(subscription.trialEndsAt)}</dd>
                </div>
              ) : null}

              {subscription.gracePeriodEndsAt ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--color-text-secondary)]">Grace period ends</dt>
                  <dd>{formatDate(subscription.gracePeriodEndsAt)}</dd>
                </div>
              ) : null}

              <div className="flex justify-between gap-4">
                <dt className="text-[var(--color-text-secondary)]">Payment</dt>
                <dd className="inline-flex items-center gap-1.5">
                  {subscription.paymentState === 'VERIFIED' ? (
                    <CheckCircle2 aria-hidden="true" className="size-4 text-[var(--color-success)]" />
                  ) : (
                    <CircleSlash aria-hidden="true" className="size-4 text-[var(--color-text-secondary)]" />
                  )}
                  {humanPaymentState(subscription.paymentState)}
                </dd>
              </div>

              {subscription.cancelAtPeriodEnd ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--color-text-secondary)]">Ends at renewal</dt>
                  <dd className="inline-flex items-center gap-1.5">
                    <AlertTriangle
                      aria-hidden="true"
                      className="size-4 text-[var(--color-warning)]"
                    />
                    Yes
                  </dd>
                </div>
              ) : null}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Usage" />
          <CardBody className="space-y-5">
            <UsageBar label="Staff seats" entry={subscription.usage.seats} />
            <UsageBar label="Departments" entry={subscription.usage.departments} />

            <p className="text-xs text-[var(--color-text-secondary)]">
              Reaching a limit does not delete anything. The limit is enforced by the API,
              so a new record is refused with an explanation rather than silently lost.
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="What this plan includes" />
        <CardBody>
          <ul className="grid gap-2 sm:grid-cols-2">
            {Object.entries(MODULE_LABELS).map(([key, label]) => {
              const granted = subscription.entitlements.includes(key as ModuleKey)
              return (
                <li
                  key={key}
                  className={`flex items-center gap-2 text-sm ${granted ? '' : 'text-[var(--color-text-secondary)] line-through'}`}
                >
                  {granted ? (
                    <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-[var(--color-success)]" />
                  ) : (
                    <CircleSlash aria-hidden="true" className="size-4 shrink-0" />
                  )}
                  <span>
                    {label}
                    <span className="sr-only">{granted ? ' — included' : ' — not included'}</span>
                  </span>
                </li>
              )
            })}
          </ul>

          <p className="mt-5 flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
            <CreditCard aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            To change your plan, contact your account manager. There is no self-service
            purchase in this product.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}

/**
 * Payment state in plain words.
 *
 * "None", "Pending" and "Failed" mean different things to a hospital administrator, and
 * "UNVERIFIED" means nothing at all to one. The distinction that matters — nobody has
 * confirmed money arrived — is stated rather than implied.
 */
function humanPaymentState(state: string): string {
  switch (state) {
    case 'VERIFIED':
      return 'Confirmed received'
    case 'PENDING':
      return 'Awaiting confirmation'
    case 'FAILED':
      return 'Last attempt failed'
    default:
      return 'No payment recorded'
  }
}