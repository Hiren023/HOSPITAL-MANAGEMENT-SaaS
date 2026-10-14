import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { NOTIFICATION_CHANNELS, type NotificationChannel } from '@infinigrow/shared'

import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { LoadingState } from '../../components/states/LoadingState.js'
import { ApiClientError } from '../../lib/api-client.js'

import {
  fetchConsents,
  formatTimestamp,
  recordConsent,
  type ConsentRecord,
} from '../notifications/api.js'

/**
 * A patient's consent to be contacted.
 *
 * ── Consent is not a preference ────────────────────────────────────────────────
 *
 * The wording here is deliberately different from the "Your preferences" screen. A
 * preference is a staff member choosing about their own work messages and defaults to on.
 * Consent is a patient agreeing to be contacted and defaults to **absent** — nothing is
 * sent until it exists.
 *
 * Presenting the two the same way would invite somebody to treat a patient's silence as
 * agreement, which is the failure mode this whole screen exists to prevent.
 *
 * ── A revocation stops future sends; it does not erase history ────────────────
 *
 * Revoking flips the decision and stamps the time. Nothing is deleted, because "when did
 * this patient withdraw consent" is a question with a legal answer attached, and deleting
 * the record makes it unanswerable.
 */

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  SMS: 'SMS',
  EMAIL: 'Email',
}

/**
 * Describe a consent in one line.
 *
 * ── Four states, not two ──────────────────────────────────────────────────────
 *
 * "Granted" and "withdrawn" are different facts, and so is "never granted". Collapsing
 * the middle two into "no" loses the thing an incident review actually needs: that
 * consent existed and was taken back on a date, rather than never having existed at all.
 *
 * `grantedAt` survives a withdrawal precisely so this can say "Withdrawn on X" — the
 * server deliberately stops clearing it on revoke.
 */
function describeConsent(record: ConsentRecord | undefined): string {
  if (record === undefined) return 'Never asked'

  const granted = record.granted && record.revokedAt === null

  if (granted) return `Granted ${formatTimestamp(record.grantedAt)}`

  if (record.revokedAt !== null) {
    const was = record.grantedAt !== null ? ` on ${formatTimestamp(record.grantedAt)}` : ''
    return `Withdrawn ${formatTimestamp(record.revokedAt)}${was}`
  }

  return 'Not agreed'
}

export function PatientConsentCard({
  patientId,
  canManage,
}: {
  patientId: string
  /** Whether this identity may record a decision, as well as read one. */
  canManage: boolean
}) {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['consents', patientId],
    queryFn: ({ signal }) => fetchConsents(patientId, 'PATIENT', signal),
  })

  const decide = useMutation({
    mutationFn: recordConsent,
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['consents', patientId] })
    },
    onError: (cause) => {
      setError(
        cause instanceof ApiClientError ? cause.message : 'That decision could not be recorded.',
      )
    },
  })

  const find = (channel: NotificationChannel): ConsentRecord | undefined =>
    query.data?.consents.find((record) => record.channel === channel)

  return (
    <Card>
      <CardHeader
        title="Contact consent"
        description="Whether this patient has agreed to be contacted on each channel."
        actions={<ShieldCheck aria-hidden="true" className="size-4 text-[var(--color-ink-subtle)]" />}
      />
      <CardBody>
        {error ? (
          <Alert tone="danger" title="That did not save" className="mb-4">
            {error}
          </Alert>
        ) : null}

        {query.isPending ? <LoadingState label="Loading consent" /> : null}

        {query.isError ? (
          <ErrorState
            title="Consent could not be loaded"
            message={query.error instanceof Error ? query.error.message : 'Something went wrong.'}
            onRetry={() => void query.refetch()}
          />
        ) : null}

        {query.data ? (
          <>
            <ul className="space-y-3">
              {NOTIFICATION_CHANNELS.map((channel) => {
                const record = find(channel)
                const granted = record?.granted === true && record.revokedAt === null

                return (
                  <li
                    key={channel}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3"
                  >
                    <div>
                      <p className="font-medium">{CHANNEL_LABELS[channel]}</p>
                      <p className="mt-0.5 text-xs text-[var(--color-ink-subtle)]">
                        {describeConsent(record)}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Badge tone={granted ? 'success' : 'warning'}>
                        {granted ? 'Agreed' : 'Not agreed'}
                      </Badge>

                      {canManage ? (
                        <Button
                          size="sm"
                          variant={granted ? 'ghost' : 'secondary'}
                          busy={decide.isPending}
                          onClick={() =>
                            decide.mutate({
                              recipientRef: patientId,
                              recipientKind: 'PATIENT',
                              channel,
                              granted: !granted,
                              source: 'PATIENT_RECORD',
                            })
                          }
                        >
                          {granted ? 'Withdraw' : 'Record agreement'}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>

            <Alert tone="info" title="No agreement, no message" className="mt-4">
              A reminder is never sent on a channel this patient has not agreed to. The
              attempt is still recorded, with the reason, so &apos;we did not contact them&apos;
              can be answered afterwards.
            </Alert>
          </>
        ) : null}
      </CardBody>
    </Card>
  )
}