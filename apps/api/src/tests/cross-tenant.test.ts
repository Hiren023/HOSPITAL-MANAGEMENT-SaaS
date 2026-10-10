import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose, { type Model } from 'mongoose'

import { authenticate, requirePermission, requireTenantScope } from '../middleware/auth.js'
import { errorHandler } from '../middleware/error-handler.js'
import { requestId } from '../middleware/request-id.js'
import { notFoundHandler } from '../middleware/not-found.js'
import { validate } from '../validation/validate.js'
import { z } from 'zod'

import {
  connectTestDatabase,
  installTestJwtKeys,
  resetDatabase,
  seedFixtures,
  TEST_PASSWORD,
  type Fixture,
} from './auth-harness.js'
import { tryStartTestDatabase } from './mongo.js'
import { tenantScopedSchema } from '../infrastructure/db/tenant-plugin.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GATE: cross-tenant access control, proved at the HTTP layer.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two fictional hospitals are seeded:
 *   Hospital A  "Aarav Memorial Hospital"      — admin-a@example.test
 *   Hospital B  "Bhavna Community Hospital"    — admin-b@example.test
 *
 * Each hospital holds records that are only meaningful inside that tenant
 * (`ClinicalNote`). This suite signs in as a REAL user of Hospital A and attempts to
 * read, modify and delete Hospital B's records — both directly and by forging a
 * `hospitalId` in the request.
 *
 * Every attempt must fail. If any of these assertions ever passes, the product must
 * not ship.
 */

const db = await tryStartTestDatabase()

let fixture: Fixture

const NOTE_A = 'Patient A consultation summary — fictional'
const NOTE_B = 'Patient B consultation summary — fictional'

/** A tenant-scoped clinical record, standing in for a real patient record. */
const ClinicalNoteModel: Model<Record<string, unknown>> =
  (mongoose.models['ClinicalNote'] as Model<Record<string, unknown>> | undefined) ??
  mongoose.model<Record<string, unknown>>(
    'ClinicalNote',
    tenantScopedSchema<Record<string, unknown>>('ClinicalNote', {
      summary: { type: String, required: true },
      authorRole: { type: String, required: true },
    }),
  )

/**
 * Routes exercising the real middleware stack.
 *
 * These are TEST routes, not product routes — the note module itself belongs to a
 * later phase. What matters is that they sit behind exactly the same authenticate →
 * tenant-scope → permission → validation chain as production routes will.
 */
function buildTestApp(): Express {
  const app = express()

  app.use(requestId)
  app.use(express.json())
  app.use(cookieParserSafe())

  app.use(authenticate)

  app.get(
    '/notes',
    requireTenantScope,
    requirePermission('patient:read'),
    async (_req, res, next) => {
      try {
        const notes = await ClinicalNoteModel.find({}).sort({ _id: 1 }).lean().exec()
        res.json({
          success: true,
          data: notes.map((n) => ({ id: String(n['_id']), summary: n['summary'] })),
        })
      } catch (error) {
        next(error)
      }
    },
  )

  app.get(
    '/notes/:id',
    requireTenantScope,
    requirePermission('patient:read'),
    async (req, res, next) => {
      try {
        const id = (req as Request & { params: Record<string, string> }).params.id
        const note = await ClinicalNoteModel.findById(id).lean().exec()
        if (!note) {
          res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Resource not found', requestId: req.requestId },
          })
          return
        }
        res.json({ success: true, data: { id: String(note['_id']), summary: note['summary'] } })
      } catch (error) {
        next(error)
      }
    },
  )

  app.patch(
    '/notes/:id',
    requireTenantScope,
    requirePermission('patient:write'),
    validate({
      params: z.object({ id: z.string().regex(/^[0-9a-fA-F]{24}$/) }).strict(),
      // `.strict()` is what turns "hospitalId in the body" into a 422 rather than a
      // silently ignored field. Validating params alone is not enough.
      body: z.object({ summary: z.string().trim().min(1).max(2000) }).strict(),
    }),
    async (req, res, next) => {
      try {
        const id = (req as Request & { params: Record<string, string> }).params.id
        const { summary } = req.body as { summary: string }

        const result = await ClinicalNoteModel.updateOne({ _id: id }, { $set: { summary } }).exec()
        res.json({ success: true, data: { modified: result.modifiedCount } })
      } catch (error) {
        next(error)
      }
    },
  )

  app.delete(
    '/notes/:id',
    requireTenantScope,
    requirePermission('patient:write'),
    validate({ params: z.object({ id: z.string().regex(/^[0-9a-fA-F]{24}$/) }).strict() }),
    async (req, res, next) => {
      try {
        const id = (req as Request & { params: Record<string, string> }).params.id
        const result = await ClinicalNoteModel.deleteOne({ _id: id }).exec()
        res.json({ success: true, data: { deleted: result.deletedCount } })
      } catch (error) {
        next(error)
      }
    },
  )

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}

function cookieParserSafe() {
  return (_req: express.Request, _res: express.Response, next: express.NextFunction): void => next()
}

// Express Request type is needed inside the route callbacks above.
type Request = express.Request

async function seedNotes(): Promise<{ noteA: string; noteB: string }> {
  const { runWithContext } = await import('../infrastructure/db/tenant-context.js')
  const { issueAccessToken, keysFromEnv } = await import('../modules/identity/access-token.util.js')

  const contextFor = (hospitalId: string, userId: string) => ({
    requestId: 'seed',
    userId: userId as never,
    membershipId: '507f1f77bcf86cd799439022' as never,
    role: 'HOSPITAL_ADMIN' as const,
    hospitalId: hospitalId as never,
    permissions: new Set<string>(),
    ip: '127.0.0.1',
    userAgent: 'seed',
  })

  const noteA = (await runWithContext(contextFor(fixture.hospitalA.id, fixture.adminA.id), () =>
    ClinicalNoteModel.create({
      hospitalId: fixture.hospitalA.id,
      summary: NOTE_A,
      authorRole: 'DOCTOR',
    }),
  )) as Record<string, unknown>

  const noteB = (await runWithContext(contextFor(fixture.hospitalB.id, fixture.adminB.id), () =>
    ClinicalNoteModel.create({
      hospitalId: fixture.hospitalB.id,
      summary: NOTE_B,
      authorRole: 'DOCTOR',
    }),
  )) as Record<string, unknown>

  void issueAccessToken
  void keysFromEnv

  return { noteA: String(noteA['_id']), noteB: String(noteB['_id']) }
}

/**
 * Read a document through the RAW collection, bypassing every safeguard.
 *
 * Only the final arbiter of the gate: it proves what was actually persisted rather
 * than trusting the API response. `_id` must be cast, because a plain string will not
 * match an ObjectId in a raw driver call.
 */
async function readRawNote(id: string): Promise<Record<string, unknown> | undefined> {
  const found = await ClinicalNoteModel.collection.findOne({
    _id: new mongoose.Types.ObjectId(id),
  })
  return found ?? undefined
}

async function rawNoteCount(id?: string): Promise<number> {
  return id
    ? ClinicalNoteModel.collection.countDocuments({ _id: new mongoose.Types.ObjectId(id) })
    : ClinicalNoteModel.collection.countDocuments()
}

async function signIn(email: string): Promise<string> {
  const app = fixture.app
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: TEST_PASSWORD })

  return String((response.body.data as { accessToken: string }).accessToken)
}

describe.skipIf(!db.uri)('CROSS-TENANT ACCESS CONTROL (release gate)', () => {
  let testApp: Express
  let noteA: string
  let noteB: string
  let tokenA: string

  beforeAll(async () => {
    installTestJwtKeys()
    await connectTestDatabase(db.uri as string)
  })

  beforeEach(async () => {
    await resetDatabase()
    fixture = await seedFixtures()
    testApp = buildTestApp()

    const seeded = await seedNotes()
    noteA = seeded.noteA
    noteB = seeded.noteB

    tokenA = await signIn(fixture.adminA.email)
  })

  afterAll(async () => {})

  it('seeded one note per hospital, with different contents', async () => {
    expect(noteA).not.toBe(noteB)

    const all = await rawNoteCount()
    expect(all).toBe(2)
  })

  // ────────────────── READ ──────────────────

  it('user of Hospital A sees ONLY Hospital A notes on a list endpoint', async () => {
    const response = await request(testApp).get('/notes').set('Authorization', `Bearer ${tokenA}`)

    expect(response.status).toBe(200)

    const notes = response.body.data as { summary: string }[]
    expect(notes).toHaveLength(1)
    expect(notes[0]?.summary).toBe(NOTE_A)
    // Hospital B's content must not appear anywhere in the response.
    expect(JSON.stringify(response.body)).not.toContain(NOTE_B)
  })

  it('user of Hospital A gets 404 for Hospital B note by id', async () => {
    const response = await request(testApp)
      .get(`/notes/${noteB}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('NOT_FOUND')
    // A 403 would confirm the record exists; 404 must look identical to absence.
    expect(response.body.error.message).toBe('Resource not found')
    expect(JSON.stringify(response.body)).not.toContain(NOTE_B)
  })

  it('user of Hospital A CAN read Hospital A note by id', async () => {
    const response = await request(testApp)
      .get(`/notes/${noteA}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(response.status).toBe(200)
    expect(response.body.data.summary).toBe(NOTE_A)
  })

  // ────────────────── MODIFY ──────────────────

  it('user of Hospital A cannot modify Hospital B note', async () => {
    const response = await request(testApp)
      .patch(`/notes/${noteB}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ summary: 'TAMPERED BY HOSPITAL A' })

    expect(response.body.data?.modified ?? 0).toBe(0)

    // The stored value must be untouched.
    const stored = await readRawNote(noteB)
    expect(stored?.['summary']).toBe(NOTE_B)
  })

  it('user of Hospital A CAN modify Hospital A note', async () => {
    const response = await request(testApp)
      .patch(`/notes/${noteA}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ summary: 'UPDATED BY OWN HOSPITAL' })

    expect(response.body.data?.modified).toBe(1)
  })

  // ────────────────── DELETE ──────────────────

  it('user of Hospital A cannot delete Hospital B note', async () => {
    const response = await request(testApp)
      .delete(`/notes/${noteB}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(response.body.data?.deleted ?? 0).toBe(0)
    expect(await rawNoteCount(noteB)).toBe(1)
  })

  it('user of Hospital A CAN delete Hospital A note', async () => {
    const response = await request(testApp)
      .delete(`/notes/${noteA}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(response.body.data?.deleted).toBe(1)
  })

  // ────────────────── FORGED hospitalId ──────────────────

  it('ignores a forged hospitalId in the query', async () => {
    const response = await request(testApp)
      .get('/notes')
      .query({ hospitalId: fixture.hospitalB.id })
      .set('Authorization', `Bearer ${tokenA}`)

    expect(response.status).toBe(200)
    const notes = response.body.data as { summary: string }[]
    // The client asked for B; it still receives only A.
    expect(notes).toHaveLength(1)
    expect(notes[0]?.summary).toBe(NOTE_A)
    expect(JSON.stringify(response.body)).not.toContain(NOTE_B)
  })

  it('ignores a forged hospitalId in the request body', async () => {
    const response = await request(testApp)
      .patch(`/notes/${noteB}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ summary: 'x', hospitalId: fixture.hospitalA.id })

    // The write still cannot reach B, even while claiming to be A.
    expect(response.body.data?.modified ?? 0).toBe(0)
    const stored = await readRawNote(noteB)
    expect(stored?.['summary']).toBe(NOTE_B)
  })

  it('rejects a body carrying a hospitalId field outright (strict schema)', async () => {
    const response = await request(testApp)
      .patch(`/notes/${noteA}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ summary: 'x', hospitalId: fixture.hospitalB.id })

    expect(response.status).toBe(422)
  })

  // ────────────────── SYMMETRY ──────────────────

  it('the reverse direction is equally blocked (B cannot read A)', async () => {
    const tokenB = await signIn(fixture.adminB.email)

    const list = await request(testApp).get('/notes').set('Authorization', `Bearer ${tokenB}`)
    expect(list.body.data as unknown[]).toHaveLength(1)
    expect((list.body.data as { summary: string }[])[0]?.summary).toBe(NOTE_B)

    const direct = await request(testApp)
      .get(`/notes/${noteA}`)
      .set('Authorization', `Bearer ${tokenB}`)
    expect(direct.status).toBe(404)
  })

  // ────────────────── UNAUTHENTICATED ──────────────────

  it('refuses every tenant operation without a token', async () => {
    expect((await request(testApp).get('/notes')).status).toBe(401)
    expect((await request(testApp).delete(`/notes/${noteB}`)).status).toBe(401)
  })

  it("refuses tenant operations with another user's invalid token", async () => {
    const response = await request(testApp)
      .get('/notes')
      .set('Authorization', 'Bearer not.a.real.token')

    expect(response.status).toBe(401)
  })
})
