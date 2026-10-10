import request from 'supertest'
import { describe, expect, it } from 'vitest'
import express, { type Express } from 'express'
import { z } from 'zod'

import { ApiError } from '../infrastructure/api-error.js'
import { errorHandler } from '../middleware/error-handler.js'
import { validate } from './validate.js'

/**
 * Validation middleware tests.
 *
 * These cover the security-relevant behaviour, not just the happy path: operator
 * injection, mass assignment, and coercion that must happen before a handler runs.
 */

const strictSchema = z
  .object({
    name: z.string().trim().min(2).max(50),
    age: z.coerce.number().int().min(18).max(120),
  })
  .strict()

/**
 * Minimal app exercising `validate` on its own.
 *
 * It deliberately does NOT install the shared error handler: `validate` calls
 * `next(ApiError…)`, so without a terminal handler Express would return its own
 * default HTML error page and the JSON envelope could not be asserted. The
 * `validate — envelope` block below installs the real `errorHandler` for that.
 */
function appWith(schemas: Parameters<typeof validate>[0]): Express {
  const app = express()
  app.use(express.json())

  app.post('/test', validate(schemas), (req, res) => {
    res.status(200).json({
      success: true,
      data: { body: req.body, query: (req as { validatedQuery?: unknown }).validatedQuery },
    })
  })

  app.get('/test', validate(schemas), (req, res) => {
    res.status(200).json({
      success: true,
      data: { query: (req as { validatedQuery?: unknown }).validatedQuery },
    })
  })

  app.use(errorHandler)

  return app
}

describe('validate — body', () => {
  it('accepts a valid payload and returns the parsed value', async () => {
    const response = await request(appWith({ body: strictSchema }))
      .post('/test')
      .send({ name: 'Aarav', age: 30 })

    expect(response.status).toBe(200)
    expect(response.body.data.body).toEqual({ name: 'Aarav', age: 30 })
  })

  it('coerces a numeric string before the handler sees it', async () => {
    const response = await request(appWith({ body: strictSchema }))
      .post('/test')
      .send({ name: 'Aarav', age: '30' })

    expect(response.status).toBe(200)
    // Handlers must never have to parse strings themselves.
    expect(response.body.data.body.age).toBe(30)
    expect(typeof response.body.data.body.age).toBe('number')
  })

  it('trims strings as declared by the schema', async () => {
    const response = await request(appWith({ body: strictSchema }))
      .post('/test')
      .send({ name: '  Aarav  ', age: 30 })

    expect(response.body.data.body.name).toBe('Aarav')
  })

  it('returns 422 with per-field errors', async () => {
    const response = await request(appWith({ body: strictSchema }))
      .post('/test')
      .send({ name: 'A', age: 10 })

    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'name' }),
        expect.objectContaining({ path: 'age' }),
      ]),
    )
  })

  it('rejects unknown keys, which is what prevents mass assignment', async () => {
    // docs/SECURITY.md R10 — a client must not be able to set `hospitalId` or `role`.
    const response = await request(appWith({ body: strictSchema }))
      .post('/test')
      .send({ name: 'Aarav', age: 30, hospitalId: 'aaaaaaaaaaaaaaaaaaaaaaaa', role: 'SUPER_ADMIN' })

    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    // The dangerous fields must not reach the handler.
    expect(response.body.data).toBeUndefined()
  })

  it('reports which unrecognised keys were rejected', async () => {
    const response = await request(appWith({ body: strictSchema }))
      .post('/test')
      .send({ name: 'Aarav', age: 30, role: 'SUPER_ADMIN' })

    expect(response.status).toBe(422)
    expect(JSON.stringify(response.body.error.details)).toContain('role')
  })

  it('rejects a MongoDB operator object before it reaches a query', async () => {
    // docs/SECURITY.md R3 — {"$ne": null} must never become a query operator.
    const response = await request(appWith({ body: strictSchema }))
      .post('/test')
      .send({ name: { $ne: null }, age: 30 })

    expect(response.status).toBe(422)
    expect(JSON.stringify(response.body)).not.toContain('$ne')
  })

  it('rejects an operator hidden in a nested object', async () => {
    const nested = z.object({ profile: z.record(z.string(), z.unknown()) }).strict()

    const response = await request(appWith({ body: nested }))
      .post('/test')
      .send({ profile: { $where: 'this.a === 1' } })

    expect(response.status).toBe(422)
  })

  it('rejects a dot-PREFIXED key (a MongoDB field-path reference)', async () => {
    const freeform = z.object({ meta: z.record(z.string(), z.unknown()) }).strict()

    const response = await request(appWith({ body: freeform }))
      .post('/test')
      .send({ meta: { '.where': '1==1' } })

    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a top-level dot-prefixed key', async () => {
    const response = await request(appWith({ body: strictSchema }))
      .post('/test')
      .send({ name: 'Aarav', age: 30, '.where': '1==1' })

    expect(response.status).toBe(422)
  })

  it('allows a key containing an interior dot inside a free-form map', async () => {
    // DELIBERATE: `{'a.b': 'x'}` is not rejected here. It is a legal JSON key, and
    // rejecting every key containing a dot would break legitimate metadata.
    //
    // The real protection is defence in depth: (1) schemas are `.strict()`, so a
    // free-form map is never spread into a document, and (2) Mongoose runs with
    // `sanitizeFilter: true`, which strips `$`-prefixed keys from query filters
    // (docs/SECURITY.md R3, asserted in infrastructure/db/connection.test.ts).
    //
    // This test records the boundary so a future change does not "fix" it by
    // over-blocking, nor assume the schema alone is sufficient.
    const freeform = z.object({ meta: z.record(z.string(), z.unknown()) }).strict()

    const response = await request(appWith({ body: freeform }))
      .post('/test')
      .send({ meta: { 'a.b': 'x' } })

    expect(response.status).toBe(200)
    expect(response.body.data.body.meta).toEqual({ 'a.b': 'x' })
  })
})

describe('validate — query and params', () => {
  it('stores parsed query separately, since Express 5 query is getter-only', async () => {
    const querySchema = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .strict()

    const response = await request(appWith({ query: querySchema })).get('/test?page=3&pageSize=50')

    expect(response.status).toBe(200)
    expect(response.body.data.query).toEqual({ page: 3, pageSize: 50 })
  })

  it('applies schema defaults when a query parameter is absent', async () => {
    const querySchema = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .strict()

    const response = await request(appWith({ query: querySchema })).get('/test')

    expect(response.body.data.query).toEqual({ page: 1, pageSize: 20 })
  })

  it('rejects an out-of-range query parameter', async () => {
    const querySchema = z.object({ pageSize: z.coerce.number().int().max(100) }).strict()

    const response = await request(appWith({ query: querySchema })).get('/test?pageSize=5000')

    expect(response.status).toBe(422)
  })

  it('validates path params', async () => {
    const paramsSchema = z.object({ id: z.string().regex(/^[0-9a-fA-F]{24}$/) }).strict()

    const app = express()
    app.get('/items/:id', validate({ params: paramsSchema }), (req, res) => {
      res.json({ success: true, data: (req as { validatedParams?: unknown }).validatedParams })
    })

    const ok = await request(app).get('/items/507f1f77bcf86cd799439011')
    expect(ok.status).toBe(200)

    const bad = await request(app).get('/items/not-an-object-id')
    expect(bad.status).toBe(422)
  })
})

describe('validate — envelope', () => {
  it('includes the request id so a failure can be traced', async () => {
    // `requestId` is assigned by middleware in app.ts; mirror it here so the error
    // envelope can be checked end to end.
    const withId = express()
    withId.use(express.json())
    withId.post(
      '/t',
      (req, _res, next) => {
        req.requestId = 'req-test-123'
        next()
      },
      validate({ body: strictSchema }),
      (_req, res) => {
        res.status(200).json({ success: true })
      },
    )
    withId.use((_req, _res, next) => {
      next(ApiError.notFound())
    })
    withId.use(errorHandler)

    const response = await request(withId).post('/t').send({ name: 'A', age: 1 })

    expect(response.status).toBe(422)
    expect(response.body.error.requestId).toBe('req-test-123')
  })

  it('never leaks a stack trace', async () => {
    const response = await request(appWith({ body: strictSchema }))
      .post('/test')
      .send({ name: 'A', age: 1 })

    expect(JSON.stringify(response.body)).not.toContain('at Object.')
  })
})