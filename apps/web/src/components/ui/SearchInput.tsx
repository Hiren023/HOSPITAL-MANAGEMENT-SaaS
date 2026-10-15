import { Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { cn } from '../../lib/cn.js'

/**
 * Search input with debouncing.
 *
 * The request is issued only after the user pauses, so typing a patient name does not
 * fire a query per keystroke against a clinical database. The clear button appears only
 * when there is something to clear — a permanently present dead control is worse than no
 * control.
 *
 * The pending state is announced through `aria-busy`, not a spinner alone, because a
 * sighted person sees the spinner and a screen-reader user needs to be told the results
 * are still coming.
 */
export interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  /** Milliseconds to wait after the last keystroke. */
  debounceMs?: number
  className?: string
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  label = 'Search',
  debounceMs = 300,
  className,
}: SearchInputProps) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * Track the last value seen from the parent so the draft can be resynchronised during
   * render rather than in an effect.
   *
   * React's documented pattern for "adjusting state when a prop changes": doing it here
   * means a parent that resets the query re-renders once, instead of the effect firing
   * afterwards and triggering a second, cascading render — and it removes the flash in
   * which the input momentarily shows a stale query.
   */
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(value)
  }

  /**
   * Pending is derived, not stored: the query is outstanding exactly while the draft and
   * the committed value disagree. Storing it would require a synchronous `setState` in
   * the debounce effect, which costs an extra render on every keystroke.
   */
  const isPending = draft !== value

  useEffect(() => {
    if (!isPending) return

    const timer = setTimeout(() => {
      onChange(draft)
    }, debounceMs)

    return () => clearTimeout(timer)
  }, [draft, isPending, debounceMs, onChange])

  return (
    <div className={cn('relative', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-body-subtle"
      />
      <input
        ref={inputRef}
        id={id}
        type="search"
        value={draft}
        placeholder={placeholder}
        aria-busy={isPending || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Enter applies immediately rather than making someone wait for the debounce.
          if (event.key === 'Enter') {
            event.preventDefault()
            onChange(draft)
          }
          if (event.key === 'Escape' && draft !== '') {
            event.preventDefault()
            setDraft('')
            onChange('')
          }
        }}
        className="w-full rounded-lg border border-line-strong bg-white py-2 pl-9 pr-9 text-sm text-body placeholder:text-body-subtle focus:border-infini-600 [&::-webkit-search-cancel-button]:hidden"
      />
      {draft !== '' ? (
        <button
          type="button"
          onClick={() => {
            setDraft('')
            onChange('')
            inputRef.current?.focus()
          }}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-body-subtle transition-colors hover:bg-surface-muted hover:text-body"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  )
}
