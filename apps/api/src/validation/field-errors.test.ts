import { describe, expect, it } from 'vitest'

import { fieldError, pruneUndefined, toFieldErrors } from './field-errors.js'

describe('fieldError', () => {
  it('builds a normalised field error', () => {
    expect(fieldError('email', 'Must be a valid email address')).toEqual({
      path: 'email',
      message: 'Must be a valid email address',
    })
  })
})

describe('toFieldErrors', () => {
  it('joins nested paths with dots', () => {
    const errors = toFieldErrors([
      { path: ['items', 0, 'quantity'], message: 'Must be greater than 0' },
      { path: ['email'], message: 'Invalid email' },
    ])

    expect(errors).toEqual([
      { path: 'items.0.quantity', message: 'Must be greater than 0' },
      { path: 'email', message: 'Invalid email' },
    ])
  })

  it('labels a root-level issue as (root) rather than an empty string', () => {
    expect(toFieldErrors([{ path: [], message: 'Bad payload' }])[0]?.path).toBe('(root)')
  })

  it('handles numeric path segments', () => {
    expect(toFieldErrors([{ path: [0, 'name'], message: 'Required' }])[0]?.path).toBe('0.name')
  })
})

describe('pruneUndefined', () => {
  it('removes undefined keys so PATCH never sends explicit undefined', () => {
    const result = pruneUndefined({ name: 'Aarav', age: undefined, active: false })

    expect(result).toEqual({ name: 'Aarav', active: false })
    expect('age' in result).toBe(false)
  })

  it('keeps null, false and empty string, which are meaningful values', () => {
    const result = pruneUndefined({ a: null, b: false, c: '' })

    expect(result).toEqual({ a: null, b: false, c: '' })
  })

  it('does not mutate its input', () => {
    const input = { a: 1, b: undefined }
    pruneUndefined(input)

    expect('b' in input).toBe(true)
  })

  it('returns an empty object for an empty input', () => {
    expect(pruneUndefined({})).toEqual({})
  })
})
