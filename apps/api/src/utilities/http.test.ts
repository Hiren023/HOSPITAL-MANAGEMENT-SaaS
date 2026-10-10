import express, { type Express } from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import type { Request, Response } from 'express'
import { ApiError } from '../infrastructure/api-error.js'
import { errorHandler } from '../middleware/error-handler.js'
import { asyncHandler, sendSuccess, throwNotFound } from './http.js'

/**
 * HTTP helper tests.
 *
 * `asyncHandler` matters because an unhandled rejection in a route would otherwise
 * hang the request until timeout, which looks like a hang to the caller and hides the
 * real error.
 */

function appWith(
  handler: (req: Request, res: Response, next: (error?: unknown) => void) => unknown,
): Express {
  const app = express()
  app.use(express.json())
  app.get('/x', asyncHandler(handler))
  app.use((_req, _res, next) => next(ApiError.notFound()))
  app.use(errorHandler)
  return app
}

describe('asyncHandler', () => {
  it('returns the response from a successful handler', async () => {
    const app = appWith((_req, res) => {
      res.status(200).json({ success: true, data: 'ok' })
    })

    const response = await request(app).get('/x')
    expect(response.status).toBe(200)
    expect(response.body.data).toBe('ok')
  })

  it('forwards a thrown error to the error handler', async () => {
    const app = appWith(() => {
      throw ApiError.conflict('Already exists')
    })

    const response = await request(app).get('/x')
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('CONFLICT')
  })

  it('forwards a rejected promise to the error handler', async () => {
    const app = appWith(async () => {
      await Promise.resolve()
      throw ApiError.forbidden('Not allowed')
    })

    const response = await request(app).get('/x')
    expect(response.status).toBe(403)
  })

  it('turns a rejected promise into a 500 rather than an unhandled rejection', async () => {
    const app = appWith(async () => {
      await Promise.resolve()
      throw new Error('unexpected internal detail')
    })

    const response = await request(app).get('/x')

    expect(response.status).toBe(500)
    expect(response.body.error.message).toBe('An unexpected error occurred')
    expect(JSON.stringify(response.body)).not.toContain('unexpected internal detail')
  })
})

describe('sendSuccess', () => {
  it('sends a bare success envelope when no meta is supplied', () => {
    const json = vi.fn()
    const res = { status: vi.fn().mockReturnValue({ json }) }

    sendSuccess(res as never, { id: '1' })

    expect(res.status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({ success: true, data: { id: '1' } })
  })

  it('includes meta when supplied', () => {
    const json = vi.fn()
    const res = { status: vi.fn().mockReturnValue({ json }) }

    sendSuccess(res as never, [1, 2, 3], { requestId: 'r1', total: 3 })

    expect(json).toHaveBeenCalledWith({
      success: true,
      data: [1, 2, 3],
      meta: { requestId: 'r1', total: 3 },
    })
  })

  it('supports a created status code', () => {
    const json = vi.fn()
    const res = { status: vi.fn().mockReturnValue({ json }) }

    sendSuccess(res as never, { id: '1' }, undefined, 201)

    expect(res.status).toHaveBeenCalledWith(201)
  })
})

describe('throwNotFound', () => {
  it('throws a 404 whose message does not reveal existence', () => {
    expect(() => throwNotFound()).toThrow('Resource not found')

    try {
      throwNotFound()
    } catch (error) {
      expect((error as ApiError).status).toBe(404)
      // docs/SECURITY.md R11 — indistinguishable from a cross-tenant miss.
      expect((error as ApiError).message).toBe(ApiError.notFound().message)
    }
  })
})