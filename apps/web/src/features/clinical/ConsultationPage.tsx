import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { ArrowLeft, Download, FileText, Lock, Plus, Save, Trash2 } from 'lucide-react'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { Modal } from '../../components/ui/Modal.js'
import { Textarea } from '../../components/ui/Textarea.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { LoadingState } from '../../components/states/LoadingState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'

import {
  createPrescription,
  downloadPrescriptionDocument,
  emptyPrescriptionItem,
  fetchConsultation,
  finalizeConsultation,
  issuePrescription,
  updateConsultation,
  type Consultation,
  type Prescription,
  type PrescriptionItem,
} from './api.js'

/**
 * One consultation: the clinical note, its amendment history, and its prescriptions.
 *
 * ── Why this screen is shaped the way it is ──────────────────────────────────
 *
 * A FINALIZED consultation is a signed record. The editor does not lock itself because the
 * server would refuse the edit anyway — it locks so that a clinician is told *why* before
 * they write a careful paragraph and then discover it cannot be saved. Changing a signed
 * record means writing an amendment, and the server requires a reason and preserves the
 * original wording; the amendment history is shown inline, on the record, because a
 * correction nobody can see is only half a correction.
 *
 * Nothing on this screen generates anything. Every field is blank until a person fills it.
 */
export function ConsultationPage() {
  const { consultationId = '' } = useParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const canWrite = user !== null && hasPermission(user, 'consultation:write')
  const canPrescribe = user !== null && hasPermission(user, 'prescription:write')

  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [amending, setAmending] = useState(false)

  const consultation = useQuery({
    queryKey: ['hospital', 'consultation', consultationId],
    queryFn: ({ signal }) => fetchConsultation(consultationId, signal),
    enabled: consultationId !== '',
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['hospital'] })
  }

  const finalize = useMutation({
    mutationFn: () => finalizeConsultation(consultationId),
    onSuccess: () => {
      setNotice('The consultation is finalized and can no longer be edited directly.')
      setFinalizing(false)
      refresh()
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiClientError ? cause.message : 'The consultation could not be finalized.',
      ),
  })

  if (consultation.isPending) {
    return (
      <AppShell title="Consultation" breadcrumbs={[{ label: 'Queue' }, { label: 'Loading' }]}>
        <LoadingState label="Loading the clinical record…" />
      </AppShell>
    )
  }

  if (consultation.isError) {
    const missing =
      consultation.error instanceof ApiClientError && consultation.error.status === 404

    return (
      <AppShell title="Consultation" breadcrumbs={[{ label: 'Queue' }, { label: 'Not found' }]}>
        <Card>
          <CardBody>
            {missing ? (
              <EmptyState
                title="No such consultation"
                description="This record does not exist in your hospital, or it belongs to another clinician."
                action={
                  <a
                    href="/queue"
                    className="text-sm font-medium text-brand-700 underline underline-offset-4"
                  >
                    Back to my queue
                  </a>
                }
              />
            ) : (
              <ErrorState
                title="Could not load this consultation"
                message={
                  consultation.error instanceof ApiClientError
                    ? consultation.error.message
                    : 'The record could not be retrieved.'
                }
                onRetry={() => void consultation.refetch()}
                retrying={consultation.isFetching}
              />
            )}
          </CardBody>
        </Card>
      </AppShell>
    )
  }

  const record = consultation.data
  const finalized = record.status === 'FINALIZED'

  return (
    <AppShell
      title={record.patientLabel ?? 'Consultation'}
      breadcrumbs={[
        { label: 'Queue', to: '/queue' },
        { label: finalized ? 'Finalized consultation' : 'Draft consultation' },
      ]}
      wide
      actions={
        <a
          href="/queue"
          className="inline-flex items-center gap-2 text-sm font-medium text-brand-700 underline-offset-4 hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          My queue
        </a>
      }
    >
      <div className="space-y-5">
        {notice ? (
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        ) : null}
        {error ? (
          <Alert tone="danger" title="Action failed" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        ) : null}

        <Card>
          <CardHeader
            title={record.patientLabel ?? 'Consultation'}
            description={`Written by ${record.doctorName ?? 'a clinician'} · ${formatMoment(record.authoredAt)}`}
            actions={
              <div className="flex items-center gap-2">
                {finalized ? (
                  <Badge tone="success">
                    <Lock aria-hidden="true" className="size-3" /> Finalized
                  </Badge>
                ) : (
                  <Badge tone="info">Draft</Badge>
                )}
                {canWrite && !finalized ? (
                  <Button onClick={() => setFinalizing(true)}>Finalize</Button>
                ) : null}
              </div>
            }
          />
          <CardBody>
            {finalized ? (
              <Alert tone="info" title="This record is signed">
                It was finalized on {formatMoment(record.finalizedAt)}. It cannot be edited
                directly — corrections are recorded as amendments, which keep the original
                wording alongside your change.
              </Alert>
            ) : (
              <p className="text-sm text-ink-muted">
                This is a draft, private to you. Finalizing is permanent and marks the record
                as complete.
              </p>
            )}
          </CardBody>
        </Card>

        {finalized && canWrite ? (
          <Button variant="outline" onClick={() => setAmending(true)}>
            Record an amendment
          </Button>
        ) : null}

        <ClinicalNote record={record} editable={canWrite && !finalized} onSaved={() => {
          setNotice('The draft was saved.')
          refresh()
        }} onError={setError} />

        {record.amendments.length > 0 ? (
          <AmendmentHistory record={record} />
        ) : null}

        <Prescriptions
          consultation={record}
          canPrescribe={canPrescribe && canWrite}
          onChanged={(message) => {
            setNotice(message)
            refresh()
          }}
          onError={setError}
        />
      </div>

      {finalizing ? (
        <Modal
          open
          onClose={() => setFinalizing(false)}
          title="Finalize this consultation?"
          description="Finalizing is permanent. It cannot be undone."
          footer={
            <>
              <Button variant="secondary" onClick={() => setFinalizing(false)}>
                Keep editing
              </Button>
              <Button busy={finalize.isPending} onClick={() => finalize.mutate()}>
                Finalize record
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-muted">
            Your name and the time will be attached to this record permanently. Afterwards,
            changes are possible but only as amendments, which record what the original said
            and why it changed.
          </p>
        </Modal>
      ) : null}

      {amending ? (
        <AmendmentDialog
          consultationId={consultationId}
          onClose={() => setAmending(false)}
          onDone={(message) => {
            setAmending(false)
            setNotice(message)
            refresh()
          }}
          onError={setError}
        />
      ) : null}
    </AppShell>
  )
}

// ───────────────────────────── the note ─────────────────────────────

const FIELDS = [
  { key: 'chiefComplaint', label: 'Chief complaint', rows: 2, max: 2000 },
  { key: 'symptoms', label: 'Symptoms', rows: 4, max: 4000 },
  { key: 'assessment', label: 'Assessment', rows: 4, max: 8000 },
  { key: 'plan', label: 'Plan and advice', rows: 4, max: 8000 },
] as const

function ClinicalNote({
  record,
  editable,
  onSaved,
  onError,
}: {
  record: Consultation
  editable: boolean
  onSaved: () => void
  onError: (message: string) => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((field) => [field.key, (record[field.key] ?? '') as string])),
  )

  const save = useMutation({
    mutationFn: () => {
      const changes: Record<string, string> = {}
      for (const field of FIELDS) {
        const next = values[field.key] ?? ''
        if (next !== ((record[field.key] ?? '') as string)) changes[field.key] = next
      }
      if (Object.keys(changes).length === 0) {
        throw new ApiClientError('VALIDATION_ERROR', 'Nothing has changed', 400)
      }
      return updateConsultation(record.id, changes)
    },
    onSuccess: onSaved,
    onError: (cause) =>
      onError(
        cause instanceof ApiClientError ? cause.message : 'The note could not be saved.',
      ),
  })

  return (
    <Card>
      <CardHeader
        title="Clinical note"
        description="Written by the clinician. Nothing here is generated or suggested."
        actions={
          editable ? (
            <Button
              size="sm"
              busy={save.isPending}
              onClick={() => save.mutate()}
              leadingIcon={<Save aria-hidden="true" className="size-4" />}
            >
              Save draft
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        <div className="space-y-4">
          {FIELDS.map((field) =>
            editable ? (
              <FormField key={field.key} label={field.label}>
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    rows={field.rows}
                    maxLength={field.max}
                    value={values[field.key] ?? ''}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                )}
              </FormField>
            ) : (
              <ReadOnlyField key={field.key} label={field.label}>
                {(record[field.key] as string | null) ?? ''}
              </ReadOnlyField>
            ),
          )}
        </div>
      </CardBody>
    </Card>
  )
}

function ReadOnlyField({
  label,
  children,
}: {
  label: string
  children: string
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap text-sm">
        {children.trim() === '' ? <span className="text-ink-subtle">Not recorded</span> : children}
      </dd>
    </div>
  )
}

// ─────────────────────── amendments ───────────────────────

function AmendmentHistory({ record }: { record: Consultation }) {
  return (
    <Card>
      <CardHeader
        title="Amendment history"
        description="Every change made to this record after it was signed, with what it said before."
      />
      <CardBody>
        <ol className="space-y-4">
          {record.amendments.map((amendment, index) => (
            <li key={`${amendment.at}-${index}`} className="border-l-2 border-line pl-4">
              <p className="text-sm font-medium">
                {amendment.fields.join(', ')} changed · {formatMoment(amendment.at)}
              </p>
              <p className="mt-1 text-sm text-ink-muted">{amendment.reason}</p>
              {amendment.fields.map((field) => (
                <div key={field} className="mt-2 space-y-1">
                  <p className="text-xs uppercase tracking-wide text-ink-subtle">
                    {field} — said before
                  </p>
                  <p className="whitespace-pre-wrap rounded bg-canvas px-3 py-2 text-sm line-through opacity-70">
                    {String(amendment.before[field] ?? '') || 'Not recorded'}
                  </p>
                  <p className="text-xs uppercase tracking-wide text-ink-subtle">now says</p>
                  <p className="whitespace-pre-wrap rounded bg-canvas px-3 py-2 text-sm">
                    {String(amendment.after[field] ?? '') || 'Not recorded'}
                  </p>
                </div>
              ))}
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  )
}

function AmendmentDialog({
  consultationId,
  onClose,
  onDone,
  onError,
}: {
  consultationId: string
  onClose: () => void
  onDone: (message: string) => void
  onError: (message: string) => void
}) {
  const [field, setField] = useState('assessment')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')

  const submit = useMutation({
    mutationFn: () =>
      updateConsultation(consultationId, {
        [field]: value,
        amendmentReason: reason,
      }),
    onSuccess: () => onDone('The amendment was recorded, keeping the original wording.'),
    onError: (cause) =>
      onError(
        cause instanceof ApiClientError ? cause.message : 'The amendment could not be recorded.',
      ),
  })

  return (
    <Modal
      open
      onClose={onClose}
      title="Record an amendment"
      description="The original wording is kept alongside your change."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={submit.isPending}
            disabled={value.trim() === '' || reason.trim().length < 5}
            onClick={() => submit.mutate()}
          >
            Record amendment
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit.mutate()
        }}
      >
        <FormField label="Which part of the record?">
          {({ id }) => (
            <select
              id={id}
              value={field}
              onChange={(event) => setField(event.target.value)}
              className="w-full rounded-md border border-line px-3 py-2 text-sm"
            >
              {FIELDS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </FormField>

        <FormField label="Corrected text" required>
          {({ id }) => (
            <Textarea
              id={id}
              rows={4}
              maxLength={8000}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </FormField>

        <FormField
          label="Why is this being corrected?"
          required
          hint="Recorded permanently against the record. At least 5 characters."
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </FormField>
      </form>
    </Modal>
  )
}

// ─────────────────────── prescriptions ───────────────────────

function Prescriptions({
  consultation,
  canPrescribe,
  onChanged,
  onError,
}: {
  consultation: Consultation
  canPrescribe: boolean
  onChanged: (message: string) => void
  onError: (message: string) => void
}) {
  const [composing, setComposing] = useState(false)
  const prescriptions = consultation.prescriptions ?? []

  return (
    <Card>
      <CardHeader
        title="Prescriptions"
        description="Documents authored by the named clinician. Nothing is suggested or generated."
        actions={
          canPrescribe ? (
            <Button size="sm" onClick={() => setComposing(true)} leadingIcon={<Plus aria-hidden="true" className="size-4" />}>
              New prescription
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {prescriptions.length === 0 ? (
          <EmptyState
            icon={<FileText aria-hidden="true" className="size-8" />}
            title="No prescriptions"
            description="Nothing has been prescribed from this consultation."
          />
        ) : (
          <ul className="space-y-4">
            {prescriptions.map((prescription) => (
              <PrescriptionCard
                key={prescription.id}
                prescription={prescription}
                canPrescribe={canPrescribe}
                onChanged={onChanged}
                onError={onError}
              />
            ))}
          </ul>
        )}
      </CardBody>

      {composing ? (
        <PrescriptionComposer
          consultationId={consultation.id}
          onClose={() => setComposing(false)}
          onCreated={(message) => {
            setComposing(false)
            onChanged(message)
          }}
          onError={onError}
        />
      ) : null}
    </Card>
  )
}

function PrescriptionCard({
  prescription,
  canPrescribe,
  onChanged,
  onError,
}: {
  prescription: Prescription
  canPrescribe: boolean
  onChanged: (message: string) => void
  onError: (message: string) => void
}) {
  const [confirming, setConfirming] = useState(false)

  const issue = useMutation({
    mutationFn: () => issuePrescription(prescription.id),
    onSuccess: () => {
      setConfirming(false)
      onChanged('The prescription was issued and its document generated.')
    },
    onError: (cause) =>
      onError(cause instanceof ApiClientError ? cause.message : 'The prescription could not be issued.'),
  })

  const download = useMutation({
    mutationFn: () => downloadPrescriptionDocument(prescription.id),
    onSuccess: ({ fileName, blob }) => {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.click()
      URL.revokeObjectURL(url)
    },
    onError: (cause) =>
      onError(
        cause instanceof ApiClientError ? cause.message : 'The document could not be downloaded.',
      ),
  })

  const issued = prescription.status === 'FINALIZED'

  return (
    <li className="rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          {prescription.items.length}{' '}
          {prescription.items.length === 1 ? 'medicine' : 'medicines'}
        </p>
        <Badge tone={issued ? 'success' : 'info'}>{issued ? 'Issued' : 'Draft'}</Badge>
      </div>

      <ul className="mt-3 space-y-2">
        {prescription.items.map((item, index) => (
          <li key={`${item.drugName}-${index}`} className="text-sm">
            <span className="font-medium">{item.drugName}</span>{' '}
            <span className="text-ink-muted">
              — {item.dose}, {item.route}, {item.frequency}
              {item.duration ? `, for ${item.duration}` : ''}
            </span>
          </li>
        ))}
      </ul>

      {prescription.notes ? (
        <p className="mt-3 whitespace-pre-wrap text-sm text-ink-muted">{prescription.notes}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {issued && prescription.documentAvailable ? (
          <Button
            size="sm"
            variant="outline"
            busy={download.isPending}
            leadingIcon={<Download aria-hidden="true" className="size-4" />}
            onClick={() => download.mutate()}
          >
            Download PDF
          </Button>
        ) : null}

        {canPrescribe && !issued ? (
          <Button size="sm" onClick={() => setConfirming(true)}>
            Issue prescription
          </Button>
        ) : null}
      </div>

      {confirming ? (
        <Modal
          open
          onClose={() => setConfirming(false)}
          title="Issue this prescription?"
          description="The document is generated and names you as its author."
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Not yet
              </Button>
              <Button busy={issue.isPending} onClick={() => issue.mutate()}>
                Issue it
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-muted">
            Issuing seals the prescription and generates a printable document. Only you and
            colleagues with permission over this patient&rsquo;s records can download it —
            the document is not published to a shareable address.
          </p>
        </Modal>
      ) : null}
    </li>
  )
}

function PrescriptionComposer({
  consultationId,
  onClose,
  onCreated,
  onError,
}: {
  consultationId: string
  onClose: () => void
  onCreated: (message: string) => void
  onError: (message: string) => void
}) {
  const [items, setItems] = useState<PrescriptionItem[]>([emptyPrescriptionItem()])
  const [notes, setNotes] = useState('')

  const create = useMutation({
    mutationFn: () => createPrescription({ consultationId, items, notes: notes || undefined }),
    onSuccess: () => onCreated('The prescription draft was created. Review it, then issue it.'),
    onError: (cause) =>
      onError(
        cause instanceof ApiClientError ? cause.message : 'The prescription could not be created.',
      ),
  })

  const update = (index: number, changes: Partial<PrescriptionItem>) => {
    setItems((current) =>
      current.map((item, position) => (position === index ? { ...item, ...changes } : item)),
    )
  }

  // Every required field must be filled. A drug name with no dose or route reaches the
  // patient as something that is not a prescription, so the composer refuses it before
  // the API ever sees it.
  const complete = items.every(
    (item) =>
      item.drugName.trim() !== '' &&
      item.dose.trim() !== '' &&
      item.route.trim() !== '' &&
      item.frequency.trim() !== '',
  )

  return (
    <Modal
      open
      onClose={onClose}
      title="Write a prescription"
      description="Authored by you. Nothing here is suggested or generated."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={create.isPending} disabled={!complete} onClick={() => create.mutate()}>
            Create draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {items.map((item, index) => (
          <fieldset key={index} className="rounded-lg border border-line p-4">
            <legend className="px-1 text-xs font-medium uppercase tracking-wide text-ink-subtle">
              Medicine {index + 1}
            </legend>

            <div className="space-y-3">
              <FormField label="Medicine" required>
                {({ id }) => (
                  <Input
                    id={id}
                    value={item.drugName}
                    maxLength={200}
                    onChange={(event) => update(index, { drugName: event.target.value })}
                  />
                )}
              </FormField>

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Dose" required hint='For example "500 mg"'>
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      value={item.dose}
                      maxLength={100}
                      onChange={(event) => update(index, { dose: event.target.value })}
                    />
                  )}
                </FormField>

                <FormField label="Route" required hint='For example "oral"'>
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      value={item.route}
                      maxLength={100}
                      onChange={(event) => update(index, { route: event.target.value })}
                    />
                  )}
                </FormField>

                <FormField label="Frequency" required hint='For example "twice daily"'>
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      value={item.frequency}
                      maxLength={100}
                      onChange={(event) => update(index, { frequency: event.target.value })}
                    />
                  )}
                </FormField>

                <FormField label="Duration">
                  {({ id }) => (
                    <Input
                      id={id}
                      value={item.duration ?? ''}
                      maxLength={100}
                      onChange={(event) => update(index, { duration: event.target.value })}
                    />
                  )}
                </FormField>
              </div>

              <FormField label="Instructions for the patient">
                {({ id }) => (
                  <Input
                    id={id}
                    value={item.instructions ?? ''}
                    maxLength={500}
                    onChange={(event) => update(index, { instructions: event.target.value })}
                  />
                )}
              </FormField>

              {items.length > 1 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<Trash2 aria-hidden="true" className="size-4" />}
                  onClick={() =>
                    setItems((current) => current.filter((_, position) => position !== index))
                  }
                >
                  Remove this medicine
                </Button>
              ) : null}
            </div>
          </fieldset>
        ))}

        <Button
          size="sm"
          variant="outline"
          leadingIcon={<Plus aria-hidden="true" className="size-4" />}
          onClick={() => setItems((current) => [...current, emptyPrescriptionItem()])}
        >
          Add another medicine
        </Button>

        <FormField label="Notes for the patient">
          {({ id }) => (
            <Textarea
              id={id}
              rows={3}
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </FormField>
      </div>
    </Modal>
  )
}

function formatMoment(value: string | null): string {
  if (!value) return 'an unknown time'
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}