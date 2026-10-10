import { describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { z } from 'zod'

import { ApiError } from '../infrastructure/api-error.js'
import { toApiError } from './error-handler.js'

/**
 * Error translation tests.
 *
 * The important property is that an unexpected error becomes a generic
 * `INTERNAL_ERROR` — never a leaked driver message or stack trace
 * (docs/SECURITY.md R8).
 */

describe('toApiError', () => {
  it('passes an ApiError through unchanged', () => {
    const original = ApiError.conflict('Appointment already booked')
    const result = toApiError(original)

    expect(result).toBe(original)
    expect(result.status).toBe(409)
    expect(result.code).toBe('CONFLICT')
  })

  it('maps Zod issues to field-level validation details', () => {
    const schema = z.object({ email: z.string().email(), age: z.number().min(18) })
    const parsed = schema.safeParse({ email: 'not-an-email', age: 10 })

    const result = toApiError(parsed.success ? null : parsed.error)

    expect(result.status).toBe(422)
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(result.details).toHaveLength(2)
    expect(result.details?.map((detail) => detail.path).sort()).toEqual(['age', 'email'])
  })

  it('maps a real Mongoose ValidationError to field-level details', async () => {
    // A genuine document is validated so the error shape comes from Mongoose itself
    // rather than a hand-built approximation that could drift from reality.
    const schema = new mongoose.Schema({
      uhid: { type: String, required: true },
      dateOfBirth: { type: Date, required: true },
    })
    const ProbeModel =
      mongoose.models['ErrorHandlerProbe'] ?? mongoose.model('ErrorHandlerProbe', schema)

    let thrown: unknown
    try {
      await new ProbeModel({}).validate()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(mongoose.Error.ValidationError)

    const result = toApiError(thrown)

    expect(result.status).toBe(422)
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(result.details?.map((detail) => detail.path).sort()).toEqual(['dateOfBirth', 'uhid'])
    expect(
      result.details?.every((detail) => detail.message.length > 0),
      'every field error must carry a human-readable message',
    ).toBe(true)

    // `deleteModel` removes the registration from the model registry. Deleting the
    // registry entry first and then calling deleteModel throws MissingSchemaError.
    mongoose.deleteModel('ErrorHandlerProbe')
  })

  it('maps a Mongoose CastError to a validation failure, not a server fault', () => {
    const castError = new mongoose.Error.CastError('ObjectId', 'not-an-id', 'patientId')

    const result = toApiError(castError)

    expect(result.status).toBe(422)
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(result.details?.[0]?.path).toBe('patientId')
  })

  it('maps a duplicate-key error to a CONFLICT naming the offending fields', () => {
    const duplicate = Object.assign(new Error('E11000 duplicate key error'), {
      code: 11000,
      keyPattern: { hospitalId: 1, uhid: 1 },
    })

    const result = toApiError(duplicate)

    expect(result.status).toBe(409)
    expect(result.code).toBe('CONFLICT')
    expect(result.message).toContain('hospitalId')
    expect(result.message).toContain('uhid')
  })

  it('maps malformed JSON to a readable validation error', () => {
    const parseError = Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      type: 'entity.parse.failed',
    })

    const result = toApiError(parseError)

    expect(result.status).toBe(422)
    expect(result.message).toBe('Request body is not valid JSON')
  })

  it('maps an oversized body to PAYLOAD_TOO_LARGE', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
    })

    expect(toApiError(tooLarge).code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('maps an unsupported encoding to UNSUPPORTED_MEDIA_TYPE', () => {
    const unsupported = Object.assign(new Error('unsupported'), {
      type: 'encoding.unsupported',
    })

    expect(toApiError(unsupported).code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('converts an unknown error into a generic 500 with no leaked detail', () => {
    const result = toApiError(new Error('MongoServerError: connection to 10.0.0.5 refused'))

    expect(result.status).toBe(500)
    expect(result.code).toBe('INTERNAL_ERROR')
    // The client must never learn the internal detail.
    expect(result.message).toBe('An unexpected error occurred')
    expect(result.message).not.toContain('10.0.0.5')
    expect(result.isOperational).toBe(false)
  })

  it('converts a thrown string into a generic 500', () => {
    expect(toApiError('something went wrong').status).toBe(500)
  })
})

describe('ApiError factories', () => {
  it('uses an identical message for not-found, preventing existence disclosure', () => {
    // docs/SECURITY.md R11: a 404 must not reveal whether the resource exists in
    // another tenant.
    expect(ApiError.notFound().message).toBe(ApiError.notFound().message)
    expect(ApiError.notFound().message).toBe('Resource not found')
    expect(ApiError.notFound().status).toBe(404)
  })

  it('marks a tenant-scope violation as non-operational so it is logged loudly', () => {
    const error = ApiError.tenantScopeRequired('patients.find')

    expect(error.code).toBe('TENANT_SCOPE_REQUIRED')
    expect(error.status).toBe(403)
    expect(error.isOperational).toBe(false)
  })

  it('produces statuses that match the shared error-code table', () => {
    expect(ApiError.unauthenticated().status).toBe(401)
    expect(ApiError.forbidden().status).toBe(403)
    expect(ApiError.badRequest('bad').status).toBe(422)
  })
})
