import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Plus, Receipt } from 'lucide-react'
import { formatBasisPoints, formatMinorUnits } from '@infinigrow/shared'

import { AppShell } from '../../components/layout/AppShell.js'
import { Alert } from '../../components/ui/Alert.js'
import { Badge } from '../../components/ui/Badge.js'
import { Button } from '../../components/ui/Button.js'
import { Card, CardBody, CardHeader } from '../../components/ui/Card.js'
import { DataTable, TableSkeleton, type Column } from '../../components/ui/DataTable.js'
import { FormField } from '../../components/ui/FormField.js'
import { Input } from '../../components/ui/Input.js'
import { Modal } from '../../components/ui/Modal.js'
import { Select } from '../../components/ui/Select.js'
import { Textarea } from '../../components/ui/Textarea.js'
import { EmptyState } from '../../components/states/EmptyState.js'
import { ErrorState } from '../../components/states/ErrorState.js'
import { ApiClientError } from '../../lib/api-client.js'
import { useAuth } from '../../auth/auth-context.js'
import { hasPermission } from '../../auth/session.js'

import {
  createService,
  fetchServices,
  SERVICE_CATEGORY_OPTIONS,
  type Service,
} from './api.js'

/**
 * The service catalogue: what this hospital charges for, and at what price.
 *
 * Prices are entered in MAJOR units — a person types "500" for five hundred rupees — and
 * converted to minor units on the way out. Nothing here does arithmetic on money; the
 * conversion is a rounding-free shift, and totals are computed by the server regardless.
 */
export function ServicesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { user } = useAuth()

  const canWrite = user !== null && hasPermission(user, 'billing:write')

  const q = searchParams.get('q') ?? ''
  const category = searchParams.get('category') ?? ''

  const [adding, setAdding] = useState(false)

  const services = useQuery({
    queryKey: ['hospital', 'services', { q, category }],
    queryFn: ({ signal }) =>
      fetchServices(
        { q: q || undefined, category: category || undefined, pageSize: 50 },
        signal,
      ),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['hospital', 'services'] })
  }

  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (value === '') next.delete(key)
      else next.set(key, value)
    }
    setSearchParams(next)
  }

  const rows = services.data?.items ?? []
  const currency = 'INR'

  const columns: Column<Service>[] = [
    {
      key: 'name',
      header: 'Service',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.name}</p>
          <p className="truncate font-mono text-xs text-ink-subtle">{row.code}</p>
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      cell: (row) => (
        <span className="whitespace-nowrap text-sm text-ink-muted">
          {row.category.replace('_', ' ').toLowerCase()}
        </span>
      ),
      secondary: true,
    },
    {
      key: 'price',
      header: 'Price',
      cell: (row) => (
        <span className="whitespace-nowrap font-medium">
          {formatMinorUnits(row.unitPriceMinor, currency)}
        </span>
      ),
    },
    {
      key: 'tax',
      header: 'Tax',
      cell: (row) => (
        <span className="whitespace-nowrap text-sm text-ink-muted">
          {row.taxBps === 0 ? '—' : formatBasisPoints(row.taxBps)}
          {row.taxInclusive ? ' incl.' : ''}
        </span>
      ),
      secondary: true,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge tone={row.isActive ? 'success' : 'neutral'}>
          {row.isActive ? 'Active' : 'Retired'}
        </Badge>
      ),
    },
  ]

  return (
    <AppShell
      title="Service catalogue"
      breadcrumbs={[{ label: 'Finance' }, { label: 'Services' }]}
      wide
      actions={
        canWrite ? (
          <Button leadingIcon={<Plus aria-hidden="true" className="size-4" />} onClick={() => setAdding(true)}>
            Add a service
          </Button>
        ) : undefined
      }
    >
      <Card>
        <CardHeader
          title="What this hospital charges for"
          description="Prices are shown in the hospital's own currency."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="service-search" className="sr-only">
                Search services
              </label>
              <Input
                id="service-search"
                value={q}
                placeholder="Search services…"
                onChange={(event) => update({ q: event.target.value })}
                className="w-56"
              />

              <label htmlFor="service-category" className="sr-only">
                Category
              </label>
              <select
                id="service-category"
                value={category}
                onChange={(event) => update({ category: event.target.value })}
                className="rounded-md border border-line px-3 py-2 text-sm"
              >
                <option value="">All categories</option>
                {SERVICE_CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          }
        />

        {services.isPending ? (
          <TableSkeleton rows={5} columns={columns.length} caption="Services this hospital offers" />
        ) : services.isError ? (
          <CardBody>
            <ErrorState
              title="Could not load the catalogue"
              message={
                services.error instanceof ApiClientError
                  ? services.error.message
                  : 'The service catalogue could not be retrieved.'
              }
              onRetry={() => void services.refetch()}
              retrying={services.isFetching}
            />
          </CardBody>
        ) : rows.length === 0 ? (
          <CardBody>
            <EmptyState
              icon={<Receipt aria-hidden="true" className="size-10" />}
              title={q ? 'Nothing matches that search' : 'No services yet'}
              description={
                q
                  ? 'Try a different name or code.'
                  : 'Add what this hospital charges for before raising an invoice.'
              }
              action={
                canWrite && !q ? <Button onClick={() => setAdding(true)}>Add the first service</Button> : undefined
              }
            />
          </CardBody>
        ) : (
          <DataTable
            caption="Services this hospital offers, with price and configured tax"
            columns={columns}
            items={rows}
            rowKey={(row) => row.id}
          />
        )}
      </Card>

      {adding ? (
        <AddServiceDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            refresh()
          }}
        />
      ) : null}
    </AppShell>
  )
}

function AddServiceDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: () => void
}) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState('CONSULTATION')
  const [price, setPrice] = useState('')
  const [taxPercent, setTaxPercent] = useState('18')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: () =>
      createService({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description: description.trim() || undefined,
        category,
        // Major units in, minor units out. A rounding-free shift; the server does all
        // arithmetic that could actually be wrong.
        unitPriceMinor: Math.round(Number(price) * 100),
        taxBps: Math.round(Number(taxPercent) * 100),
      }),
    onSuccess: onAdded,
    onError: (cause) =>
      setError(
        cause instanceof ApiClientError ? cause.message : 'The service could not be added.',
      ),
  })

  const valid = code.trim() !== '' && name.trim() !== '' && Number(price) > 0

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a service"
      description="Prices are entered in whole currency units."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={add.isPending} disabled={!valid} onClick={() => add.mutate()}>
            Add service
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" title="Could not add the service">
          {error}
        </Alert>
      ) : null}

      <div className="space-y-4">
        <FormField label="Code" required hint="A short internal code, e.g. CONS or XRAY.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={code}
              maxLength={40}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
          )}
        </FormField>

        <FormField label="Name" required>
          {({ id }) => (
            <Input
              id={id}
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </FormField>

        <FormField label="Category">
          {({ id }) => (
            <Select
              id={id}
              options={SERVICE_CATEGORY_OPTIONS}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            />
          )}
        </FormField>

        <FormField label="Price" required hint="In whole units, e.g. 500 for five hundred.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          )}
        </FormField>

        <FormField label="Tax rate" hint="As a percentage, e.g. 18 for 18%.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              inputMode="decimal"
              value={taxPercent}
              onChange={(event) => setTaxPercent(event.target.value)}
            />
          )}
        </FormField>

        <FormField label="Description">
          {({ id }) => (
            <Textarea
              id={id}
              rows={2}
              maxLength={1000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </FormField>
      </div>
    </Modal>
  )
}