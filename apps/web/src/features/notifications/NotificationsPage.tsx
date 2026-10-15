import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Mail, MessageSquare, RefreshCw, ShieldCheck } from 'lucide-react'
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  checkPreview,
  notificationStatusLabel,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationStatus,
} from '@infinigrow/shared'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { LoadingState } from '../../components/states/LoadingState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'

import {
  fetchMyPreferences,
  fetchNotifications,
  fetchTemplates,
  formatTimestamp,
  retryNotification,
  suppressionLabel,
  updateMyPreference,
  type NotificationRow,
} from './api.js'

/**
 * Notifications — the delivery log, the templates, and my own preferences.
 *
 * ── Nothing here claims a message was delivered ────────────────────────────────
 *
 * The status column renders `notificationStatusLabel`, so "SENT" reads as "Handed to
 * provider" rather than "Delivered". A delivery log that quietly implies delivery is worse
 * than no log, because it looks like evidence — and most SMS gateways genuinely cannot tell
 * the difference between "accepted" and "received".
 *
 * ── A suppressed message is shown, not hidden ──────────────────────────────────
 *
 * Rows with `SUPPRESSED` are part of the log, with the reason spelled out. "We did not
 * contact this patient" has to be answerable after an incident, and a log that only lists
 * what went out cannot answer it.
 *
 * ── The template screen runs the real validator ───────────────────────────────
 *
 * `checkPreview` is imported from the shared package and is the same function the API
 * enforces. Showing the user a check the server does not also run would be a UI that can
 * reassure and still be refused.
 */

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  APPOINTMENT: 'Appointments',
  CLINICAL: 'Clinical',
  BILLING: 'Billing',
  ADMINISTRATIVE: 'Administrative',
}

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  EMAIL: 'Email',
  SMS: 'SMS',
}

function statusTone(status: NotificationStatus): 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'SENT':
      return 'success'
    case 'DELIVERED':
      return 'success'
    case 'PENDING':
      return 'info'
    case 'FAILED':
    case 'BOUNCED':
      return 'danger'
    case 'SUPPRESSED':
      return 'warning'
  }
}

// ─────────────────────────── delivery log ───────────────────────────

function DeliveryLog({ canSend }: { canSend: boolean }) {
  const [status, setStatus] = useState<'' | NotificationStatus>('')
  const queryClient = useQueryClient()
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['notifications', status],
    queryFn: ({ signal }) =>
      fetchNotifications({ status: status || undefined, pageSize: 50 }, signal),
  })

  const retry = useMutation({
    mutationFn: retryNotification,
    onSuccess: () => {
      setActionError(null)
      setNotice('The message was queued for another attempt.')
      void queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
    onError: (cause) => {
      setNotice(null)
      setActionError(
        cause instanceof ApiClientError ? cause.message : 'The retry could not be started.',
      )
    },
  })

  const columns: Column<NotificationRow>[] = [
    {
      key: 'createdAt',
      header: 'Queued',
      cell: (row) => formatTimestamp(row.createdAt),
    },
    {
      key: 'templateKey',
      header: 'Template',
      cell: (row) => (
        <div>
          <span className="font-medium">{row.templateKey}</span>
          <span className="ml-2 text-xs text-[var(--color-body-subtle)]">
            {CHANNEL_LABELS[row.channel]} · {CATEGORY_LABELS[row.category]}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <div className="flex flex-col items-start gap-1">
          <Badge tone={statusTone(row.status)}>{notificationStatusLabel(row.status)}</Badge>
          {row.suppressionReason ? (
            <span className="text-xs text-[var(--color-body-subtle)]">
              {suppressionLabel(row.suppressionReason)}
            </span>
          ) : null}
          {row.failureReason && row.suppressionReason === null ? (
            <span className="text-xs text-[var(--color-danger)]">{row.failureReason}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'attempts',
      header: 'Attempts',
      cell: (row) => `${row.attempts} of ${row.maxAttempts}`,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (row) =>
        canSend && row.status === 'FAILED' ? (
          <Button
            size="sm"
            variant="secondary"
            busy={retry.isPending}
            onClick={() => retry.mutate(row.id)}
          >
            Retry
          </Button>
        ) : null,
    },
  ]

  return (
    <Card>
      <CardHeader
        title="Delivery log"
        // "Log" not "sent messages": the table contains messages that were refused, which
        // is the point of keeping them.
        description="Every message the system attempted, including the ones it refused to send."
        actions={
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="notification-status">
              Filter by status
            </label>
            <select
              id="notification-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as '' | NotificationStatus)}
              className="rounded-lg border border-line-strong bg-white px-3 py-1.5 text-sm text-body"
            >
              <option value="">All statuses</option>
              {NOTIFICATION_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {notificationStatusLabel(value)}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void query.refetch()}
              busy={query.isFetching}
              aria-label="Refresh the delivery log"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
            </Button>
          </div>
        }
      />
      <CardBody>
        {notice ? (
          <Alert tone="success" title="Queued" className="mb-4">
            {notice}
          </Alert>
        ) : null}
        {actionError ? (
          <Alert tone="danger" title="That did not work" className="mb-4">
            {actionError}
          </Alert>
        ) : null}

        {query.isPending ? <TableSkeleton columns={5} rows={5} caption="Delivery log" /> : null}

        {query.isError ? (
          <ErrorState
            title="The delivery log could not be loaded"
            message={query.error instanceof Error ? query.error.message : 'Something went wrong.'}
            onRetry={() => void query.refetch()}
          />
        ) : null}

        {query.data && query.data.items.length === 0 ? (
          <EmptyState
            icon={<Bell aria-hidden="true" className="size-6" />}
            title="Nothing has been queued yet"
            description="When a reminder is queued it will appear here with its delivery status."
          />
        ) : null}

        {query.data && query.data.items.length > 0 ? (
          <>
            <DataTable
              caption="Messages this hospital queued, with their delivery status"
              columns={columns}
              items={query.data.items}
              rowKey={(row) => row.id}
            />
            <p className="mt-3 text-xs text-[var(--color-body-subtle)]">
              {query.data.meta.total} message{query.data.meta.total === 1 ? '' : 's'} recorded.
              &apos;Handed to provider&apos; means a provider accepted it for delivery. It is
              not a statement that anybody received it.
            </p>
          </>
        ) : null}
      </CardBody>
    </Card>
  )
}

// ─────────────────────────── templates ───────────────────────────

/**
 * Template preview.
 *
 * The safety verdict shown here comes from `checkPreview` — the shared function the API
 * calls when it renders. Same input, same answer, so the badge cannot lie.
 */
function TemplateList() {
  const query = useQuery({
    queryKey: ['notification-templates'],
    queryFn: ({ signal }) => fetchTemplates(signal),
  })

  return (
    <Card>
      <CardHeader
        title="Templates"
        description="Every message the system can send. There is no way to compose your own."
      />
      <CardBody>
        {query.isPending ? <LoadingState label="Loading templates" /> : null}

        {query.isError ? (
          <ErrorState
            title="Templates could not be loaded"
            message={query.error instanceof Error ? query.error.message : 'Something went wrong.'}
            onRetry={() => void query.refetch()}
          />
        ) : null}

        {query.data && query.data.length === 0 ? (
          <EmptyState title="No templates" description="None are available on this plan." />
        ) : null}

        <ul className="space-y-4">
          {query.data?.map((template) => {
            const verdict = checkPreview(template.body)
            const subjectVerdict = template.subject === null ? null : checkPreview(template.subject)
            const safe = verdict.safe && (subjectVerdict?.safe ?? true)

            return (
              <li key={template.key} className="rounded-lg border border-line p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{template.key}</p>
                    <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">
                      {template.description}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="info">
                      {template.channel === 'SMS' ? (
                        <MessageSquare aria-hidden="true" className="mr-1 size-3" />
                      ) : (
                        <Mail aria-hidden="true" className="mr-1 size-3" />
                      )}
                      {CHANNEL_LABELS[template.channel]}
                    </Badge>
                    {safe ? (
                      <Badge tone="success">Safe to send</Badge>
                    ) : (
                      // A built-in template failing this is a build-time failure, since the
                      // assertion also runs at import. Showing it red rather than hiding it
                      // means a bad edit is visible the moment it lands.
                      <Badge tone="danger">Blocked</Badge>
                    )}
                  </div>
                </div>

                {template.subject === null ? null : (
                  <p className="mt-3 text-sm">
                    <span className="text-[var(--color-body-subtle)]">Subject: </span>
                    {template.subject}
                  </p>
                )}

                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-surface-muted p-3 text-sm text-body">
                  {template.body}
                </pre>

                {!safe ? (
                  <p className="mt-2 text-sm text-[var(--color-danger)]">
                    {verdict.safe ? subjectVerdict?.reason : verdict.reason}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>

        <Alert tone="info" title="What a message may contain" className="mt-5">
          A name, a date, a time, a department or a location — and a generic instruction.
          Never a diagnosis, a test result, a medicine or a consultation note. The rule is
          enforced on the server as well as shown here.
        </Alert>
      </CardBody>
    </Card>
  )
}

// ─────────────────────────── preferences ───────────────────────────

function MyPreferences() {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: ({ signal }) => fetchMyPreferences(signal),
  })

  const toggle = useMutation({
    mutationFn: updateMyPreference,
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['notification-preferences'] })
    },
    onError: (cause) => {
      setError(cause instanceof ApiClientError ? cause.message : 'That could not be saved.')
    },
  })

  // A row is enabled unless it was explicitly switched off. Absence is not consent to be
  // ignored, so the default is "on" rather than the table being the source of truth.
  const isEnabled = (channel: NotificationChannel, category: NotificationCategory): boolean => {
    const row = query.data?.items.find(
      (item) => item.channel === channel && item.category === category,
    )
    return row?.enabled ?? true
  }

  return (
    <Card>
      <CardHeader
        title="Your preferences"
        description="Choose what you are notified about. Opting out of one category leaves the others alone."
      />
      <CardBody>
        {error ? (
          <Alert tone="danger" title="That did not save" className="mb-4">
            {error}
          </Alert>
        ) : null}

        {query.isPending ? <LoadingState label="Loading your preferences" /> : null}

        <table className="w-full text-sm">
          <caption className="sr-only">
            Notification preferences by channel and category
          </caption>
          <thead>
            <tr className="border-b border-line text-left">
              <th scope="col" className="py-2 font-medium">
                Category
              </th>
              {NOTIFICATION_CHANNELS.map((channel) => (
                <th key={channel} scope="col" className="py-2 text-center font-medium">
                  {CHANNEL_LABELS[channel]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_CATEGORIES.map((category) => (
              <tr key={category} className="border-b border-line last:border-0">
                <th scope="row" className="py-2 text-left font-normal">
                  {CATEGORY_LABELS[category]}
                </th>
                {NOTIFICATION_CHANNELS.map((channel) => {
                  const checked = isEnabled(channel, category)
                  const id = `pref-${channel}-${category}`

                  return (
                    <td key={channel} className="py-2 text-center">
                      <input
                        id={id}
                        type="checkbox"
                        checked={checked}
                        disabled={query.isPending || toggle.isPending}
                        onChange={(event) =>
                          toggle.mutate({
                            channel,
                            category,
                            enabled: event.target.checked,
                          })
                        }
                        className="size-4 accent-[var(--color-infini-600)]"
                      />
                      <label htmlFor={id} className="sr-only">
                        {CATEGORY_LABELS[category]} over {CHANNEL_LABELS[channel]}
                      </label>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <p className="mt-4 flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          These are your own choices about your own work messages. A patient&apos;s consent to
          be contacted is recorded on their record, separately.
        </p>
      </CardBody>
    </Card>
  )
}

// ─────────────────────────── screen ───────────────────────────

export function NotificationsPage() {
  const { user } = useAuth()
  const canSend = user !== null && hasPermission(user, 'notification:send')

  return (
    <AppShell title="Notifications">
      <div className="space-y-6">
        {/*
          Stated up front rather than buried. Somebody reading a delivery log needs to know
          what its most confident-looking word actually means before they rely on it.
        */}
        <Alert tone="info" title="What &apos;handed to provider&apos; means">
          A provider accepted the message for delivery. That is the most that is known — and
          most gateways cannot tell the difference between accepted and received. No message
          in this product is ever recorded as delivered.
        </Alert>

        <DeliveryLog canSend={canSend} />
        <TemplateList />
        <MyPreferences />
      </div>
    </AppShell>
  )
}