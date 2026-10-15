import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'

import { fetchPatientSummary, type Consultation } from './api.js'

/**
 * A patient's clinical summary and history.
 *
 * ── What "history" means here ────────────────────────────────────────────────
 *
 * It means the consultations THIS CALLER is entitled to read, which for a doctor is the
 * ones they wrote. The panel says so explicitly rather than presenting a short list as
 * though it were the patient's whole medical story — a clinician who believes they are
 * looking at everything when they are looking at their own encounters is exactly the kind
 * of mistake this notice exists to prevent.
 *
 * The full count in the hospital is reported alongside it, so the gap is visible rather
 * than silent.
 *
 * There is deliberately no clinical content generated or summarised here. The panel shows
 * what clinicians recorded, verbatim, and nothing else.
 */
export function PatientClinicalSummary({ patientId }: { patientId: string }) {
  const [showDrafts, setShowDrafts] = useState(false)

  const summary = useQuery({
    queryKey: ['hospital', 'clinical-summary', patientId],
    queryFn: ({ signal }) => fetchPatientSummary(patientId, signal),
    enabled: patientId !== '',
  })

  if (summary.isPending) {
    return (
      <Card>
        <TableSkeleton
          rows={3}
          columns={3}
          caption="Clinical consultations recorded for this patient"
        />
      </Card>
    )
  }

  if (summary.isError) {
    return (
      <Card>
        <CardBody>
          <ErrorState
            title="Could not load the clinical summary"
            message={
              summary.error instanceof ApiClientError
                ? summary.error.message
                : 'The summary could not be retrieved.'
            }
            onRetry={() => void summary.refetch()}
            retrying={summary.isFetching}
          />
        </CardBody>
      </Card>
    )
  }

  const data = summary.data
  if (!data) return null

  const consultations = showDrafts
    ? data.consultations
    : data.consultations.filter((row) => row.status === 'FINALIZED')

  const hiddenDrafts = data.consultations.length - consultations.length

  const columns: Column<Consultation>[] = [
    {
      key: 'when',
      header: 'Recorded',
      cell: (row) => (
        <span className="whitespace-nowrap text-sm">
          {new Date(row.authoredAt).toLocaleDateString(undefined, {
            dateStyle: 'medium',
          })}
        </span>
      ),
    },
    {
      key: 'doctor',
      header: 'Clinician',
      cell: (row) => <span className="text-sm text-body-muted">{row.doctorName ?? '—'}</span>,
      secondary: true,
    },
    {
      key: 'complaint',
      header: 'Chief complaint',
      cell: (row) => (
        <span className="text-sm text-body-muted">{row.chiefComplaint ?? '—'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={row.status === 'FINALIZED' ? 'success' : 'info'}>
            {row.status === 'FINALIZED' ? 'Finalized' : 'Draft'}
          </Badge>
          {row.amendments.length > 0 ? (
            <Badge tone="warning">{row.amendments.length} amendment(s)</Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: 'open',
      header: <span className="sr-only">Open</span>,
      cell: (row) => (
        <a
          href={`/consultations/${row.id}`}
          className="text-sm font-medium text-infini-700 underline underline-offset-4"
        >
          Open
        </a>
      ),
    },
  ]

  return (
    <Card>
      <CardHeader
        title="Clinical history"
        description={
          data.scopedToOwnRecords
            ? `Consultations you recorded for this patient (${data.visibleConsultations} of ${data.totalConsultationsInHospital} in this hospital).`
            : `All consultations recorded in this hospital (${data.totalConsultationsInHospital}).`
        }
        actions={
          hiddenDrafts > 0 || showDrafts ? (
            <Button size="sm" variant="ghost" onClick={() => setShowDrafts((value) => !value)}>
              {showDrafts ? 'Hide drafts' : `Show drafts (${hiddenDrafts})`}
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {data.scopedToOwnRecords ? (
          <Alert tone="info" title="You are seeing your own records">
            Clinical notes are shown per clinician. {data.totalConsultationsInHospital}{' '}
            consultation(s) exist for this patient in this hospital and you can read{' '}
            {data.visibleConsultations}. Anything else was written by another clinician and is
            not shown here.
          </Alert>
        ) : null}

        {consultations.length === 0 ? (
          <EmptyState
            title="No consultations recorded"
            description={
              data.totalConsultationsInHospital === 0
                ? 'This patient has no recorded consultations.'
                : 'This patient has consultations in this hospital, but none that you are able to read.'
            }
          />
        ) : (
          <DataTable
            caption="Consultations recorded for this patient, with their status and any amendments"
            columns={columns}
            items={consultations}
            rowKey={(row) => row.id}
          />
        )}
      </CardBody>
    </Card>
  )
}