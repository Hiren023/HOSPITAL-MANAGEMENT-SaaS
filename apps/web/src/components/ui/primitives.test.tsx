import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Alert } from './Alert.js'
import { Badge, HospitalStatusBadge, RoleBadge, roleLabel } from './Badge.js'
import { ConfirmDialog } from './ConfirmDialog.js'
import { DataTable, TableSkeleton, type Column } from './DataTable.js'
import { FormField } from './FormField.js'
import { Input } from './Input.js'
import { Modal } from './Modal.js'
import { Pagination } from './Pagination.js'
import { SearchInput } from './SearchInput.js'
import { Select } from './Select.js'
import { Textarea } from './Textarea.js'
import { Button } from './Button.js'
import { expectNoSeriousViolations } from '../../test/a11y.js'

describe('FormField', () => {
  it('associates the label with the control', () => {
    render(
      <FormField label="Hospital name" required>
        {({ id, describedBy, invalid }) => (
          <Input id={id} aria-describedby={describedBy} invalid={invalid} />
        )}
      </FormField>,
    )

    const input = screen.getByLabelText(/hospital name/i)
    expect(input).toBeInTheDocument()
    // The required marker is visual, but it is also announced.
    expect(input).toHaveAccessibleName(/required/i)
  })

  it('links the error to the control and announces it', () => {
    render(
      <FormField label="Email" error="Enter a valid email address" required>
        {({ id, describedBy, invalid }) => (
          <Input id={id} aria-describedby={describedBy} invalid={invalid} />
        )}
      </FormField>,
    )

    const input = screen.getByLabelText(/email/i)
    const message = screen.getByRole('alert')

    expect(input).toHaveAttribute('aria-invalid', 'true')
    // The description id actually points at the rendered error node.
    expect(input.getAttribute('aria-describedby')).toContain(message.id)
  })

  it('links the hint to the control', () => {
    render(
      <FormField label="Password" hint="At least 12 characters.">
        {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} />}
      </FormField>,
    )

    const input = screen.getByLabelText(/password/i)
    expect(input).toHaveAccessibleDescription('At least 12 characters.')
  })

  it('links both hint and error when both are present', () => {
    render(
      <FormField label="Password" hint="At least 12 characters." error="Too short">
        {({ id, describedBy, invalid }) => (
          <Input id={id} aria-describedby={describedBy} invalid={invalid} />
        )}
      </FormField>,
    )

    const input = screen.getByLabelText(/password/i)
    const describedBy = input.getAttribute('aria-describedby') ?? ''
    expect(describedBy.split(' ')).toHaveLength(2)
  })

  it('gives each field a unique id', () => {
    render(
      <>
        <FormField label="First">{({ id }) => <Input id={id} />}</FormField>
        <FormField label="Second">{({ id }) => <Input id={id} />}</FormField>
      </>,
    )

    expect(screen.getByLabelText('First').id).not.toBe(screen.getByLabelText('Second').id)
  })
})

describe('Button', () => {
  it('announces a pending state without losing its label', () => {
    render(
      <Button busy busyLabel="Saving, please wait">
        Save
      </Button>,
    )

    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Save')
    expect(button).toHaveTextContent('Saving, please wait')
  })

  it('defaults to type=button so it never submits a form by accident', () => {
    render(<Button>Click</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
  })

  it('is reachable and activatable by keyboard', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Activate</Button>)

    await user.tab()
    expect(screen.getByRole('button')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe('Alert', () => {
  it('interrupts only for failures', () => {
    const { rerender } = render(<Alert tone="success">Saved</Alert>)
    // A success message is polite; announcing it with `alert` would interrupt.
    expect(screen.getByRole('status')).toHaveTextContent('Saved')

    rerender(<Alert tone="danger">Failed</Alert>)
    expect(screen.getByRole('alert')).toHaveTextContent('Failed')
  })

  it('exposes an accessible dismiss control', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(<Alert onDismiss={onDismiss}>Message</Alert>)

    await user.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

describe('status indicators', () => {
  it('pairs every colour with text, never colour alone', () => {
    render(<HospitalStatusBadge status="SUSPENDED" />)
    // Colour-blind users cannot distinguish red from green; the word carries the meaning.
    expect(screen.getByText('Suspended')).toBeInTheDocument()
  })

  it('falls back to the raw value for an unknown status', () => {
    render(<HospitalStatusBadge status="SOMETHING_NEW" />)
    expect(screen.getByText('SOMETHING_NEW')).toBeInTheDocument()
  })

  it('renders human labels for roles', () => {
    expect(roleLabel('SUPER_ADMIN')).toBe('Platform administrator')
    render(<RoleBadge role="ACCOUNTANT" />)
    expect(screen.getByText('Accountant')).toBeInTheDocument()
  })
})

interface Row {
  id: string
  name: string
  amount: number
  note: string
}

const ROWS: Row[] = [
  { id: '1', name: 'Fictional Patient One', amount: 1250, note: 'Consultation' },
  { id: '2', name: 'Fictional Patient Two', amount: 430, note: 'Follow-up' },
]

const COLUMNS: Column<Row>[] = [
  { key: 'name', header: 'Patient', cell: (row) => row.name },
  { key: 'amount', header: 'Amount', cell: (row) => `₹${row.amount}`, numeric: true },
  { key: 'note', header: 'Note', cell: (row) => row.note, secondary: true },
]

describe('DataTable', () => {
  it('is described by its caption and exposes column headers', () => {
    render(
      <DataTable
        caption="Invoices raised this month"
        columns={COLUMNS}
        items={ROWS}
        rowKey={(row) => row.id}
      />,
    )

    // The caption is the first thing a screen reader announces for the table.
    expect(screen.getByRole('table', { name: /invoices raised this month/i })).toBeInTheDocument()

    for (const header of ['Patient', 'Amount', 'Note']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
  })

  it('marks column headers with a scope so navigation announces position', () => {
    render(<DataTable caption="Invoices" columns={COLUMNS} items={ROWS} rowKey={(row) => row.id} />)

    expect(screen.getByRole('columnheader', { name: 'Patient' })).toHaveAttribute('scope', 'col')
  })

  it('renders an empty message rather than a blank table', () => {
    render(
      <DataTable
        caption="Invoices"
        columns={COLUMNS}
        items={[]}
        rowKey={(row) => row.id}
        empty={<span>Nothing raised yet</span>}
      />,
    )

    expect(screen.getByText('Nothing raised yet')).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /patient one/i })).not.toBeInTheDocument()
  })

  it('is keyboard reachable so a clipped table can still be scrolled', () => {
    const { container } = render(
      <DataTable caption="Invoices" columns={COLUMNS} items={ROWS} rowKey={(row) => row.id} />,
    )

    // A scroll container that cannot receive focus strands keyboard users on mobile.
    expect(container.querySelector('[role="region"]')).toHaveAttribute('tabindex', '0')
  })

  it('the loading placeholder announces itself and holds the column count', () => {
    const { container } = render(<TableSkeleton rows={3} columns={4} caption="Invoices" />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading Invoices')
    // The same region exists before, during and after loading, so a screen-reader user
    // navigating by landmark finds it in the same place throughout.
    expect(screen.getByRole('region', { name: 'Invoices' })).toHaveAttribute('aria-busy', 'true')
    expect(container.querySelectorAll('.animate-pulse').length).toBe(12)
  })
})

describe('Pagination', () => {
  it('hides itself when there is a single page', () => {
    const { container } = render(
      <Pagination page={1} pageCount={1} onPageChange={vi.fn()} total={4} />,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('marks the current page and reports the result range', async () => {
    const user = userEvent.setup()
    const onPageChange = vi.fn()
    render(<Pagination page={2} pageCount={5} onPageChange={onPageChange} total={137} />)

    expect(screen.getByRole('button', { name: 'Go to page 2' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByText(/showing page 2 of 5/i)).toHaveTextContent('137')

    await user.click(screen.getByRole('button', { name: 'Go to page 3' }))
    expect(onPageChange).toHaveBeenCalledWith(3)
  })

  it('disables previous on the first page and next on the last', () => {
    const { rerender } = render(<Pagination page={1} pageCount={3} onPageChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled()

    rerender(<Pagination page={3} pageCount={3} onPageChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /previous/i })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })

  it('collapses long ranges into a window with a labelled navigation region', () => {
    render(<Pagination page={10} pageCount={40} onPageChange={vi.fn()} />)

    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to page 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to page 40' })).toBeInTheDocument()
  })
})

describe('SearchInput', () => {
  it('debounces so typing does not fire a query per keystroke', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <SearchInput
          value={value}
          onChange={(next) => {
            onChange(next)
            setValue(next)
          }}
          label="Search patients"
        />
      )
    }

    render(<Harness />)
    await user.type(screen.getByLabelText('Search patients'), 'abc')

    // Nothing yet — the debounce window has not elapsed.
    expect(onChange).not.toHaveBeenCalled()

    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('abc')
    })

    // One call for three keystrokes, not three.
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('clears with the button and returns focus to the input', async () => {
    const user = userEvent.setup()

    function Harness() {
      const [value, setValue] = useState('Meera')
      return <SearchInput value={value} onChange={setValue} label="Search" />
    }

    render(<Harness />)
    const input = screen.getByLabelText('Search')
    expect(input).toHaveValue('Meera')

    await user.click(screen.getByRole('button', { name: /clear search/i }))

    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
  })

  it('shows no clear control when there is nothing to clear', () => {
    render(<SearchInput value="" onChange={vi.fn()} label="Search" />)
    expect(screen.queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument()
  })

  it('clears on Escape', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    function Harness() {
      const [value, setValue] = useState('Meera')
      return (
        <SearchInput
          value={value}
          onChange={(next) => {
            onChange(next)
            setValue(next)
          }}
          label="Search"
        />
      )
    }

    render(<Harness />)
    await user.type(screen.getByLabelText('Search'), '{Escape}')

    expect(onChange).toHaveBeenCalledWith('')
  })
})

describe('Modal', () => {
  function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
    return (
      <>
        <button type="button">Outside control</button>
        <Modal open onClose={onClose} title="Approve hospital" description="This cannot be undone.">
          <input aria-label="Confirmation" />
        </Modal>
      </>
    )
  }

  it('is a labelled modal dialog', () => {
    render(<Harness />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('Approve hospital')
    expect(dialog).toHaveAccessibleDescription('This cannot be undone.')
  })

  it('moves focus to the dialog itself, not onto a control inside it', async () => {
    render(<Harness />)

    // Focusing the container announces the title and description on arrival, and avoids
    // a reflexive Enter landing on a destructive confirm button.
    await vi.waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveFocus()
    })
  })

  it('restores focus to the trigger when it closes', async () => {
    const user = userEvent.setup()

    function Closable() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Example">
            <input aria-label="Confirmation" />
          </Modal>
        </>
      )
    }

    render(<Closable />)

    const trigger = screen.getByRole('button', { name: /open dialog/i })
    await user.click(trigger)
    await vi.waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())

    await user.keyboard('{Escape}')

    await vi.waitFor(() => {
      expect(trigger).toHaveFocus()
    })
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('traps Tab inside the dialog', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const dialog = screen.getByRole('dialog')
    const focusables = within(dialog)
      .getAllByRole('button')
      .concat(within(dialog).queryAllByRole('textbox'))

    // Cycle well past the number of focusable elements; focus must never escape.
    for (let index = 0; index < focusables.length + 3; index += 1) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('renders nothing when closed', () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="Hidden">
        content
      </Modal>,
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('ConfirmDialog', () => {
  it('names the action in the confirm button, not just "Confirm"', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    render(
      <ConfirmDialog
        open
        title="Suspend this hospital?"
        description="Its staff will lose access immediately."
        confirmLabel="Suspend hospital"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )

    const button = screen.getByRole('button', { name: 'Suspend hospital' })
    await user.click(button)
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('cancels without acting', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmDialog
        open
        title="Delete?"
        description="Irreversible."
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('Select', () => {
  it('renders a native control with an accessible name', () => {
    render(
      <FormField label="Department" required>
        {({ id }) => (
          <Select
            id={id}
            placeholder="Select a department"
            options={[
              { value: 'cardiology', label: 'Cardiology' },
              { value: 'paeds', label: 'Paediatrics' },
            ]}
          />
        )}
      </FormField>,
    )

    const select = screen.getByLabelText(/department/i)
    expect(select.tagName).toBe('SELECT')
    expect(within(select).getByRole('option', { name: 'Select a department' })).toBeDisabled()
  })
})

describe('Textarea', () => {
  it('marks itself invalid when given an error', () => {
    render(<Textarea aria-label="Message" invalid />)
    expect(screen.getByLabelText('Message')).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('accessibility of the primitive set', () => {
  it('has no serious violations in a representative composition', async () => {
    const { container } = render(
      <div>
        <FormField label="Hospital name" required>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              defaultValue="Fictional"
            />
          )}
        </FormField>
        <Alert tone="warning" title="Pending approval">
          This hospital cannot sign in yet.
        </Alert>
        <div className="flex gap-2">
          <Badge tone="success">Active</Badge>
          <RoleBadge role="RECEPTIONIST" />
        </div>
        <DataTable caption="Invoices" columns={COLUMNS} items={ROWS} rowKey={(row) => row.id} />
        <Pagination page={1} pageCount={3} onPageChange={vi.fn()} total={42} />
      </div>,
    )

    await expectNoSeriousViolations(container)
  })
})
