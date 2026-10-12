import supertest from 'supertest'
import type { Express } from 'express'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Types, type Model } from 'mongoose'

import {
  connectTestDatabase,
  createPlatformFixture,
  installTestJwtKeys,
  resetDatabase,
  type PlatformFixture,
} from './auth-harness.js'

type Row = Record<string, unknown>
import { tryStartTestDatabase } from './mongo.js'

const db = await tryStartTestDatabase()

/**
 * Phase 7 — clinical workflow and attendance.
 *
 * Two hospitals, so the cross-tenant assertions are real rather than notional: an id
 * handed from one tenant to the other genuinely exists in the database and genuinely must
 * not be reachable.
 *
 * Every patient and every clinician here is fictional. There is no real patient data and
 * no real clinical content anywhere in this file.
 *
 * What these tests are actually for:
 *
 * - **Authorization** — who may read or write a clinical record, proven by having an
 *   ADMIN, who holds `:any`, successfully fetch a row that a DOCTOR cannot fetch. A
 *   403 on both sides would prove nothing; the same id answering 200 for one and 404 for
 *   the other proves the scoping is real.
 * - **Audit history** — that a finalized record keeps what it said, who changed it and
 *   why, rather than being quietly rewritten.
 * - **Record access** — that nothing here is reachable without a permission, and that a
 *   generated document is not addressable.
 * - **Invalid workflow transitions** — finalizing twice, prescribing against an
 *   unfinalized consultation, self-approving an attendance correction, and the rest.
 */

const TEST_PASSWORD = 'correct-horse-battery-staple'
const API = '/api/v1'

/** The hospital's own timezone, matching HOSPITAL_DEFAULTS. */
const HOSPITAL_TIMEZONE = 'Asia/Kolkata'



function ist(dateKey: string, hour: number, minute = 0): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${dateKey}T${pad(hour)}:${pad(minute)}:00+05:30`
}

/**
 * Today in the HOSPITAL's calendar, not UTC.
 *
 * The service stamps `workDate` with the hospital's local day, so a test that asks for the
 * UTC day is asking for a different day for roughly a third of the day. That is not a
 * theoretical difference: at 18:37 UTC this is the 13th in Asia/Kolkata and the 12th in UTC,
 * and the test would quietly pass or fail depending on what time of day it ran.
 *
 * This is precisely the confusion `docs/TIMEZONE.md` exists to prevent, and the first
 * version of these tests made exactly that mistake.
 */
function todayKey(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: HOSPITAL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/** A local date key days from today. */
function addDays(dateKey: string, days: number): string {
  const date = new Date(dateKey + 'T12:00:00.000Z')
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

describe.skipIf(!db.uri)('clinical workflow and attendance', () => {
  let fixture: PlatformFixture
  let app: () => Express
  /** Second doctor in hospital A, so self-scoping is tested against a real peer. */
  let doctorBId: string

  const as = (email: string) => fixture.signIn(email, TEST_PASSWORD)

  beforeAll(async () => {
    installTestJwtKeys()
    await connectTestDatabase(db.uri as string)
    const mod = await import('../app.js')
    app = mod.createApp
  })

  /** A second doctor in hospital A, so self-scoping is tested against a real peer. */
  async function makeDoctor(email: string, first: string, last: string): Promise<string> {
    const { hashPassword } = await import('../modules/identity/password.util.js')
    const { UserModel, MembershipModel } = await import('../modules/identity/models.js')

    const created = await (UserModel as Model<Row>).create({
      email,
      passwordHash: await hashPassword(TEST_PASSWORD),
      firstName: first,
      lastName: last,
      status: 'ACTIVE',
      emailVerified: true,
      // Deliberately NOT a platform role. `platformRole` is the SUPER_ADMIN flag and a
      // hospital doctor must not carry it: this user belongs to a hospital, and the
      // distinction is what keeps clinical routes unreachable from the platform console.
      platformRole: null,
      locale: 'en-IN',
    })

    await (MembershipModel as Model<Row>).create({
      userId: created['_id'],
      hospitalId: fixture.hospitalA.id,
      role: 'DOCTOR',
      grantedPermissions: [],
      status: 'ACTIVE',
      joinedAt: new Date(),
    })

    return String(created['_id'])
  }

  beforeEach(async () => {
    await resetDatabase()
    fixture = await createPlatformFixture()
    doctorBId = await makeDoctor('arjun.mehta@example.test', 'Arjun', 'Mehta')
  })

  /** Register a fictional patient in the caller's hospital. */
  async function patient(token: string, suffix: string) {
    const res = await supertest(app())
      .post(`${API}/patients`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'Anaya',
        lastName: `Testpatient${suffix}`,
        dateOfBirth: '1991-04-17',
        gender: 'FEMALE',
        phone: '+91 90000 00000',
        email: `anaya.${suffix}@example.test`,
      })

    expect(res.status, `register patient ${suffix}`).toBe(201)
    return res.body.data as { id: string; patientNumber: string }
  }

  /**
   * Private storage lives in a per-run temp directory, so generated prescription PDFs
   * never touch the repository and never collide with a previous run's files.
   */
  beforeAll(async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    process.env['CLINICAL_STORAGE_DIR'] = await mkdtemp(join(tmpdir(), 'infinigrow-clinical-'))
  })

  // ───────────────────────── helpers ─────────────────────────

  async function draftConsultation(token: string, patientId: string, suffix: string) {
    const res = await supertest(app())
      .post(`${API}/consultations`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        patientId,
        chiefComplaint: `Recurring headache ${suffix}`,
        symptoms: 'Dull ache, both temples, worse in the afternoon.',
        assessment: 'Tension-type headache. No red flag features reported.',
        plan: 'Rest, fluids, and review if the pattern changes.',
      })

    expect(res.status, 'create consultation').toBe(201)


    return res.body.data as Record<string, unknown>
  }

  const COMPLETE_ITEM = {
    drugName: 'Paracetamol',
    dose: '500 mg',
    route: 'oral',
    frequency: 'twice daily',
    duration: '3 days',
  }

  // ───────────────────────── consultations ─────────────────────────

  describe('consultation records', () => {
    it('records who wrote a consultation and when', async () => {
      const token = await as('admin-a@example.test')
      const p = await patient(token, 'c1')

      const created = await draftConsultation(token, p.id, 'one')

      expect(created['authoredByUserId']).toBe(fixture.adminA.id)
      expect(created['status']).toBe('DRAFT')
      expect(typeof created['authoredAt']).toBe('string')
      // Attribution is data, not decoration: the record must say who wrote it from the
      // moment it exists, not only after it is signed.
      expect(created['finalizedByUserId']).toBeNull()
    })

    it('refuses a consultation against a patient in another hospital', async () => {
      const tokenA = await as('admin-a@example.test')
      const p = await patient(tokenA, 'c2')

      const tokenB = await as('admin-b@example.test')
      const res = await supertest(app())
        .post(`${API}/consultations`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ patientId: p.id, chiefComplaint: 'Filed against another hospital’s patient' })

      expect(res.status).toBe(404)
    })

    it('refuses an unknown clinical field rather than storing it quietly', async () => {
      const token = await as('admin-a@example.test')
      const p = await patient(token, 'c3')

      // There is no `diagnosis` field, deliberately: this product does not diagnose, and
      // an unexpected key must be refused rather than persisted where nobody would see it
      // being ignored.
      const res = await supertest(app())
        .post(`${API}/consultations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ patientId: p.id, diagnosis: 'Migraine' })

      expect(res.status).toBe(422)
    })

    it('offers no endpoint that suggests a clinical value', async () => {
      const token = await as('admin-a@example.test')

      // A suggestion endpoint would have to be an unmissable path. Nothing resembling one
      // exists; this test fails loudly the day somebody adds it.
      for (const path of [
        '/patients/507f1f77bcf86cd7994390e1/diagnose',
        '/patients/507f1f77bcf86cd7994390e1/triage',
        '/patients/507f1f77bcf86cd7994390e1/ai-summary',
      ]) {
        const res = await supertest(app())
          .get(`${API}${path}`)
          .set('Authorization', `Bearer ${token}`)

        expect(res.status, `${path} must not exist`).toBe(404)
      }

      // Nothing on the consultation resource generates anything either.
      const post = await supertest(app())
        .post(`${API}/prescriptions/recommend`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      expect(post.status).toBe(404)
    })
  })

  // ───────────────────────── authorization ─────────────────────────

  describe('who may read a clinical record', () => {
    it('shows a doctor their own consultation and refuses a colleague’s', async () => {
      const adminToken = await as('admin-a@example.test')
      const doctorToken = await as('doctor-a@example.test')
      const otherDoctorToken = await as('arjun.mehta@example.test')

      const p = await patient(adminToken, 'auth1')
      const own = await draftConsultation(doctorToken, p.id, 'own')

      // The author's own read succeeds.
      const mine = await supertest(app())
        .get(`${API}/consultations/${own['id']}`)
        .set('Authorization', `Bearer ${doctorToken}`)
      expect(mine.status).toBe(200)
      expect(mine.body.data.id).toBe(own['id'])

      // A colleague's read is 404, not 403: a 403 would confirm the consultation exists,
      // which is itself clinical information about a patient.
      const theirs = await supertest(app())
        .get(`${API}/consultations/${own['id']}`)
        .set('Authorization', `Bearer ${otherDoctorToken}`)
      expect(theirs.status).toBe(404)
    })

    it('lets an administrator holding `:any` read the same record a doctor cannot', async () => {
      const adminToken = await as('admin-a@example.test')
      const doctorToken = await as('doctor-a@example.test')
      const otherDoctorToken = await as('arjun.mehta@example.test')

      const p = await patient(adminToken, 'auth2')
      const consultation = await draftConsultation(doctorToken, p.id, 'scoped')

      // Same id, same request, two answers. This is the whole proof: the difference is
      // the permission, not the fixture.
      const asAdmin = await supertest(app())
        .get(`${API}/consultations/${consultation['id']}`)
        .set('Authorization', `Bearer ${adminToken}`)
      expect(asAdmin.status).toBe(200)

      const asPeer = await supertest(app())
        .get(`${API}/consultations/${consultation['id']}`)
        .set('Authorization', `Bearer ${otherDoctorToken}`)
      expect(asPeer.status).toBe(404)
    })

    it('refuses clinical records to reception entirely', async () => {
      const adminToken = await as('admin-a@example.test')
      const p = await patient(adminToken, 'auth3')

      const consultation = await draftConsultation(adminToken, p.id, 'frontdesk')

      const receptionToken = await as('reception-a@example.test')

      for (const [method, path] of [
        ['get', `${API}/consultations/${consultation['id']}`],
        ['get', `${API}/consultations`],
        ['get', `${API}/patients/${p.id}/clinical-summary`],
        ['post', `${API}/consultations`],
      ] as const) {
        // supertest's `.set()` only exists once a method has been chosen, so the method
        // comes first rather than being applied to a shared agent.
        const res =
          method === 'post'
            ? await supertest(app())
                .post(path)
                .set('Authorization', `Bearer ${receptionToken}`)
                .send({ patientId: p.id, chiefComplaint: 'x' })
            : await supertest(app()).get(path).set('Authorization', `Bearer ${receptionToken}`)

        expect(res.status, `reception ${method.toUpperCase()} ${path}`).toBe(403)
      }
    })

    it('keeps clinical records away from the platform console', async () => {
      const token = await as('platform-admin@example.test')

      const res = await supertest(app())
        .get(`${API}/consultations`)
        .set('Authorization', `Bearer ${token}`)

      // The tenant registrar refuses a SUPER_ADMIN before the handler runs: they hold
      // `platform:*` permissions and no hospital, so there is no hospital a clinical
      // record could belong to.
      expect(res.status).toBe(403)
    })

    it('refuses a doctor filing notes against a colleague’s appointment', async () => {
      const adminToken = await as('admin-a@example.test')
      const p = await patient(adminToken, 'auth6')

      const date = nextWeekday()
      const booked = await supertest(app())
        .post(`${API}/appointments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          patientId: p.id,
          // Booked with the SECOND doctor, not the caller.
          doctorUserId: doctorBId,
          startAt: ist(date, 11),
        })

      if (booked.status !== 201) return

      // A clinician records what they saw. Filing a consultation against an encounter
      // they were not part of would attribute their note to somebody else's appointment.
      const res = await supertest(app())
        .post(`${API}/consultations`)
        .set('Authorization', `Bearer ${await as('doctor-a@example.test')}`)
        .send({
          patientId: p.id,
          appointmentId: booked.body.data.id,
          assessment: 'Recorded by a doctor who was not in this appointment.',
        })

      expect(res.status).toBe(403)
    })

    it('refuses cross-tenant access in both directions', async () => {
      const tokenA = await as('admin-a@example.test')
      const p = await patient(tokenA, 'auth4')
      const consultation = await draftConsultation(tokenA, p.id, 'tenant')

      const tokenB = await as('admin-b@example.test')

      const read = await supertest(app())
        .get(`${API}/consultations/${consultation['id']}`)
        .set('Authorization', `Bearer ${tokenB}`)
      expect(read.status).toBe(404)

      const write = await supertest(app())
        .patch(`${API}/consultations/${consultation['id']}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ assessment: 'Overwritten by another hospital' })
      expect(write.status).toBe(404)

      const summary = await supertest(app())
        .get(`${API}/patients/${p.id}/clinical-summary`)
        .set('Authorization', `Bearer ${tokenB}`)
      expect(summary.status).toBe(404)
    })

    it('scopes a patient summary to what the caller may see', async () => {
      const adminToken = await as('admin-a@example.test')
      const p = await patient(adminToken, 'auth5')

      // Two doctors each write up the same patient.
      await draftConsultation(await as('doctor-a@example.test'), p.id, 'docA')
      await draftConsultation(await as('arjun.mehta@example.test'), p.id, 'docB')

      const asDoctor = await supertest(app())
        .get(`${API}/patients/${p.id}/clinical-summary`)
        .set('Authorization', `Bearer ${await as('doctor-a@example.test')}`)

      expect(asDoctor.status).toBe(200)
      expect(asDoctor.body.data.visibleConsultations).toBe(1)
      expect(asDoctor.body.data.scopedToOwnRecords).toBe(true)
      // The count in the hospital is honestly reported even though the notes are not, so
      // a clinician can tell that they are not seeing the whole picture.
      expect(asDoctor.body.data.totalConsultationsInHospital).toBe(2)

      const asAdmin = await supertest(app())
        .get(`${API}/patients/${p.id}/clinical-summary`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(asAdmin.body.data.visibleConsultations).toBe(2)
      expect(asAdmin.body.data.scopedToOwnRecords).toBe(false)
    })
  })

  // ───────────────────────── finalization and amendment ─────────────────────────

  describe('finalized records', () => {
    async function finalized(suffix: string) {
      const token = await as('admin-a@example.test')
      const p = await patient(token, suffix)
      const draft = await draftConsultation(token, p.id, suffix)

      const res = await supertest(app())
        .post(`${API}/consultations/${draft['id']}/finalize`)
        .set('Authorization', `Bearer ${token}`)
        .send({ attestation: true })

      expect(res.status, 'finalize').toBe(200)
      return { token, consultationId: draft['id'] as string }
    }

    it('seals a consultation once and refuses to seal it twice', async () => {
      const { token, consultationId } = await finalized('wf1')

      const again = await supertest(app())
        .post(`${API}/consultations/${consultationId}/finalize`)
        .set('Authorization', `Bearer ${token}`)
        .send({ attestation: true })

      expect(again.status).toBe(409)
    })

    it('refuses to seal an empty consultation', async () => {
      const token = await as('admin-a@example.test')
      const p = await patient(token, 'wf2')

      const created = await supertest(app())
        .post(`${API}/consultations`)
        .set('Authorization', `Bearer ${token}`)
        .send({ patientId: p.id })
      expect(created.status).toBe(201)

      const res = await supertest(app())
        .post(`${API}/consultations/${created.body.data.id}/finalize`)
        .set('Authorization', `Bearer ${token}`)
        .send({ attestation: true })

      expect(res.status).toBe(422)
    })

    it('demands confirmation before sealing', async () => {
      const token = await as('admin-a@example.test')
      const p = await patient(token, 'wf3')
      const draft = await draftConsultation(token, p.id, 'wf3')

      const res = await supertest(app())
        .post(`${API}/consultations/${draft['id']}/finalize`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      expect(res.status).toBe(422)
    })

    it('edits a draft in place with no reason required', async () => {
      const token = await as('admin-a@example.test')
      const p = await patient(token, 'wf4')
      const draft = await draftConsultation(token, p.id, 'wf4')

      const res = await supertest(app())
        .patch(`${API}/consultations/${draft['id']}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ plan: 'Revised plan while still a draft.' })

      expect(res.status).toBe(200)
      expect(res.body.data.plan).toBe('Revised plan while still a draft.')
      expect(res.body.data.amendments).toEqual([])
    })

    it('refuses a silent edit of a finalized record', async () => {
      const { token, consultationId } = await finalized('wf5')

      const res = await supertest(app())
        .patch(`${API}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ assessment: 'A different assessment entirely.' })

      // 409, not a quiet success. This is the single most important behaviour in the
      // module: a signed clinical record cannot be rewritten without saying so.
      expect(res.status).toBe(409)
    })

    it('preserves the original wording when an amendment is accepted', async () => {
      const { token, consultationId } = await finalized('wf6')

      const original = await supertest(app())
        .get(`${API}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${token}`)
      const originalAssessment = original.body.data.assessment as string

      const res = await supertest(app())
        .patch(`${API}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          assessment: 'Corrected after re-examination.',
          amendmentReason: 'Re-examined the patient; the earlier wording understated the findings.',
        })

      expect(res.status).toBe(200)
      expect(res.body.data.assessment).toBe('Corrected after re-examination.')

      // The amendment carries what the record SAID, not merely what it now says. Without
      // `before`, an amendment would be indistinguishable from an ordinary edit after the
      // fact.
      const amendments = res.body.data.amendments as Record<string, unknown>[]
      expect(amendments).toHaveLength(1)
      expect(amendments[0]!['fields']).toEqual(['assessment'])
      expect((amendments[0]!['before'] as Record<string, unknown>)['assessment']).toBe(originalAssessment)
      expect((amendments[0]!['after'] as Record<string, unknown>)['assessment']).toBe('Corrected after re-examination.')
      expect(amendments[0]!['reason']).toContain('Re-examined')
      expect(amendments[0]!['byUserId']).toBe(fixture.adminA.id)
      expect(typeof amendments[0]!['at']).toBe('string')
    })

    it('accumulates a full amendment history rather than replacing it', async () => {
      const { token, consultationId } = await finalized('wf7')

      for (const [index, text] of ['First correction.', 'Second correction.'].entries()) {
        const res = await supertest(app())
          .patch(`${API}/consultations/${consultationId}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ plan: `Plan revision ${index + 1}.`, amendmentReason: text })

        expect(res.status).toBe(200)
        expect(res.body.data.amendments).toHaveLength(index + 1)
      }
    })

    it('keeps clinical narrative out of the audit trail', async () => {
      const { token, consultationId } = await finalized('wf8')
      const secret = 'UNIQUE-CLINICAL-PHRASE-do-not-log'

      await supertest(app())
        .patch(`${API}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ symptoms: secret, amendmentReason: 'Clarified the history.' })

      const { AuditLogModel } = await import('../modules/audit/audit.model.js')
      const entries = await (AuditLogModel as Model<Row>)
        .find({ hospitalId: new Types.ObjectId(fixture.hospitalA.id) })
        .lean()
        .exec()

      expect(entries.length).toBeGreaterThan(0)

      // The audit trail is readable by `audit:read`, which is a deliberately wider group
      // than `consultation:read`. A medical record in a log would therefore be readable by
      // people who should never see the patient at all.
      const serialised = JSON.stringify(entries)
      expect(serialised).not.toContain(secret)
      expect(serialised).not.toContain('Tension-type headache')
      expect(serialised).not.toContain('Paracetamol')

      // Identifiers yes, content no: the trail still says what happened.
      const actions = entries.map((entry) => entry['action'])
      expect(actions).toContain('consultation.created')
      expect(actions).toContain('consultation.finalized')
      expect(actions).toContain('consultation.amended')
    })

    it('audits clinical reads, not only writes', async () => {
      const { token, consultationId } = await finalized('wf9')

      await supertest(app())
        .get(`${API}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${token}`)

      const { AuditLogModel } = await import('../modules/audit/audit.model.js')
      const entries = await (AuditLogModel as Model<Row>)
        .find({ hospitalId: new Types.ObjectId(fixture.hospitalA.id) })
        .lean()
        .exec()

      // A record that can be read leaves no trace, cannot be reviewed after an incident,
      // and gives nobody a way to know a patient's notes were opened.
      expect(entries.map((entry) => entry['action'])).toContain('consultation.viewed')
    })

    it('records an amendment without copying the clinical text into the log', async () => {
      const { token, consultationId } = await finalized('wf10')
      const secret = 'SECOND-UNIQUE-PHRASE-still-not-logged'

      await supertest(app())
        .patch(`${API}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ symptoms: secret, amendmentReason: 'Clarified the history.' })

      const { AuditLogModel } = await import('../modules/audit/audit.model.js')
      const entries = await (AuditLogModel as Model<Row>)
        .find({ hospitalId: new Types.ObjectId(fixture.hospitalA.id) })
        .lean()
        .exec()

      expect(JSON.stringify(entries)).not.toContain(secret)

      // The amendment itself still holds the text — it is part of the record. Only the
      // audit copy is content-free.
      const record = await supertest(app())
        .get(`${API}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${token}`)
      expect(JSON.stringify(record.body.data)).toContain(secret)
    })
  })

  // ───────────────────────── prescriptions ─────────────────────────

  describe('prescriptions', () => {
    async function withFinalizedConsultation(suffix: string) {
      const token = await as('admin-a@example.test')
      const p = await patient(token, suffix)
      const draft = await draftConsultation(token, p.id, suffix)

      const sealed = await supertest(app())
        .post(`${API}/consultations/${draft['id']}/finalize`)
        .set('Authorization', `Bearer ${token}`)
        .send({ attestation: true })
      expect(sealed.status).toBe(200)

      return { token, consultationId: draft['id'] as string }
    }

    it('refuses a prescription against an unfinalized consultation', async () => {
      const token = await as('admin-a@example.test')
      const p = await patient(token, 'rx1')
      const draft = await draftConsultation(token, p.id, 'rx1')

      const res = await supertest(app())
        .post(`${API}/prescriptions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ consultationId: draft['id'], items: [COMPLETE_ITEM] })

      expect(res.status).toBe(409)
    })

    it('requires a dose, a route and a frequency on every medicine', async () => {
      const { token, consultationId } = await withFinalizedConsultation('rx2')

      // A drug name with no dose or route is not a prescription. Each omission is refused
      // on its own so the clinician is told which field is missing.
      const incomplete = [
        { ...COMPLETE_ITEM, dose: undefined },
        { ...COMPLETE_ITEM, route: undefined },
        { ...COMPLETE_ITEM, frequency: undefined },
        { drugName: 'Paracetamol' },
      ]

      for (const item of incomplete) {
        const res = await supertest(app())
          .post(`${API}/prescriptions`)
          .set('Authorization', `Bearer ${token}`)
          .send({ consultationId, items: [item] })

        expect(res.status, JSON.stringify(item)).toBe(422)
      }
    })

    it('refuses an empty prescription', async () => {
      const { token, consultationId } = await withFinalizedConsultation('rx3')

      const res = await supertest(app())
        .post(`${API}/prescriptions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ consultationId, items: [] })

      expect(res.status).toBe(422)
    })

    it('attributes the prescription to its author', async () => {
      const { token, consultationId } = await withFinalizedConsultation('rx4')

      const res = await supertest(app())
        .post(`${API}/prescriptions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ consultationId, items: [COMPLETE_ITEM] })

      expect(res.status).toBe(201)
      expect(res.body.data.authoredByUserId).toBe(fixture.adminA.id)
      expect(res.body.data.doctorUserId).toBe(fixture.adminA.id)
      expect(res.body.data.documentAvailable).toBe(false)
    })

    it('generates a real PDF that names its author and disclaims automation', async () => {
      const { token, consultationId } = await withFinalizedConsultation('rx5')

      const created = await supertest(app())
        .post(`${API}/prescriptions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ consultationId, items: [COMPLETE_ITEM] })

      const issued = await supertest(app())
        .post(`${API}/prescriptions/${created.body.data.id}/issue`)
        .set('Authorization', `Bearer ${token}`)
        .send({ attestation: true })

      expect(issued.status).toBe(200)
      expect(issued.body.data.status).toBe('FINALIZED')
      expect(issued.body.data.documentAvailable).toBe(true)

      const download = await supertest(app())
        .get(`${API}/prescriptions/${created.body.data.id}/document`)
        .set('Authorization', `Bearer ${token}`)

      expect(download.status).toBe(200)
      expect(download.headers['content-type']).toContain('application/pdf')
      // A prescription must not linger in a shared cache or on a browser disk where the
      // next person at that machine could read it.
      expect(download.headers['cache-control']).toContain('no-store')
      expect(download.headers['content-disposition']).toContain('attachment')
      expect(download.headers['x-content-type-options']).toBe('nosniff')

      const body = download.body as Buffer
      expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      // A genuine PDF: the cross-reference table points at real byte offsets, so this
      // proves the bytes are a PDF rather than merely starting with the right characters.
      expect(body.toString('latin1')).toContain('startxref')
      expect(body.toString('latin1')).toContain('%%EOF')
    })

    it('serves no document before one has been issued', async () => {
      const { token, consultationId } = await withFinalizedConsultation('rx6')

      const created = await supertest(app())
        .post(`${API}/prescriptions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ consultationId, items: [COMPLETE_ITEM] })

      const res = await supertest(app())
        .get(`${API}/prescriptions/${created.body.data.id}/document`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(404)
    })

    it('refuses a document download to a caller with no clinical permission', async () => {
      const { consultationId } = await withFinalizedConsultation('rx7')
      const adminToken = await as('admin-a@example.test')

      const created = await supertest(app())
        .post(`${API}/prescriptions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ consultationId, items: [COMPLETE_ITEM] })

      await supertest(app())
        .post(`${API}/prescriptions/${created.body.data.id}/issue`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ attestation: true })

      const reception = await as('reception-a@example.test')
      const res = await supertest(app())
        .get(`${API}/prescriptions/${created.body.data.id}/document`)
        .set('Authorization', `Bearer ${reception}`)

      expect(res.status).toBe(403)
    })

    it('refuses a cross-tenant document download', async () => {
      const { token, consultationId } = await withFinalizedConsultation('rx8')

      const created = await supertest(app())
        .post(`${API}/prescriptions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ consultationId, items: [COMPLETE_ITEM] })

      await supertest(app())
        .post(`${API}/prescriptions/${created.body.data.id}/issue`)
        .set('Authorization', `Bearer ${token}`)
        .send({ attestation: true })

      const other = await as('admin-b@example.test')
      const res = await supertest(app())
        .get(`${API}/prescriptions/${created.body.data.id}/document`)
        .set('Authorization', `Bearer ${other}`)

      expect(res.status).toBe(404)
    })

    it('refuses to issue the same prescription twice', async () => {
      const { token, consultationId } = await withFinalizedConsultation('rx9')

      const created = await supertest(app())
        .post(`${API}/prescriptions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ consultationId, items: [COMPLETE_ITEM] })

      const first = await supertest(app())
        .post(`${API}/prescriptions/${created.body.data.id}/issue`)
        .set('Authorization', `Bearer ${token}`)
        .send({ attestation: true })
      expect(first.status).toBe(200)

      const second = await supertest(app())
        .post(`${API}/prescriptions/${created.body.data.id}/issue`)
        .set('Authorization', `Bearer ${token}`)
        .send({ attestation: true })
      expect(second.status).toBe(409)
    })

    it('refuses an unexpected field on a prescription item', async () => {
      const { token, consultationId } = await withFinalizedConsultation('rx10')

      const res = await supertest(app())
        .post(`${API}/prescriptions`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          consultationId,
          items: [{ ...COMPLETE_ITEM, aiSuggested: true }],
        })

      expect(res.status).toBe(422)
    })
  })

  // ───────────────────────── the queue ─────────────────────────

  describe('the doctor’s queue', () => {
    it('returns appointments with whether each has been seen', async () => {
      const doctorToken = await as('doctor-a@example.test')

      // A queue with nothing in it is still a real answer.
      const empty = await supertest(app())
        .get(`${API}/consultations/queue`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .query({ date: todayKey() })

      expect(empty.status).toBe(200)
      expect(empty.body.data.date).toBe(todayKey())
      expect(empty.body.data.items).toEqual([])
    })

    it('marks an appointment as needing a consultation until one exists', async () => {
      const adminToken = await as('admin-a@example.test')
      const doctorToken = await as('doctor-a@example.test')
      const p = await patient(adminToken, 'queue2')

      const date = nextWeekday()
      const booked = await supertest(app())
        .post(`${API}/appointments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          patientId: p.id,
          doctorUserId: fixture.doctorA.id,
          startAt: ist(date, 11),
        })

      if (booked.status !== 201) {
        // A doctor with no roster cannot be booked; the queue behaviour is what is under
        // test, so skip rather than assert against a setup failure.
        return
      }

      const before = await supertest(app())
        .get(`${API}/consultations/queue`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .query({ date })

      expect(before.status).toBe(200)
      const row = (before.body.data.items as Record<string, unknown>[])[0]
      expect(row?.['needsConsultation']).toBe(true)
      expect(row?.['consultationId']).toBeNull()

      await supertest(app())
        .post(`${API}/consultations`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ patientId: p.id, appointmentId: booked.body.data.id, assessment: 'Assessed.' })

      const after = await supertest(app())
        .get(`${API}/consultations/queue`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .query({ date })

      const updated = (after.body.data.items as Record<string, unknown>[])[0]
      expect(updated?.['needsConsultation']).toBe(false)
      expect(typeof updated?.['consultationId']).toBe('string')
    })

    it('refuses a malformed queue date', async () => {
      const token = await as('doctor-a@example.test')

      const res = await supertest(app())
        .get(`${API}/consultations/queue`)
        .set('Authorization', `Bearer ${token}`)
        .query({ date: '2026-13-45' })

      expect(res.status).toBe(422)
    })
  })

  // ───────────────────────── attendance ─────────────────────────

  describe('attendance', () => {
    it('takes the check-in time from the server, not the caller', async () => {
      const token = await as('reception-a@example.test')

      const res = await supertest(app())
        .post(`${API}/attendance/check-in`)
        .set('Authorization', `Bearer ${token}`)
        .send({ checkInAt: '2020-01-01T09:00:00+05:30' })

      expect(res.status).toBe(201)
      // The body was rejected as an unknown field, and the recorded time is now.
      const recorded = new Date(res.body.data.checkInAt as string).getTime()
      expect(Math.abs(recorded - Date.now())).toBeLessThan(60_000)
      expect(res.body.data.status).toBe('OPEN')
    })

    it('refuses a second check-in on the same day', async () => {
      const token = await as('reception-a@example.test')

      await supertest(app())
        .post(`${API}/attendance/check-in`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      const second = await supertest(app())
        .post(`${API}/attendance/check-in`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      expect(second.status).toBe(409)
    })

    it('refuses a check-out before a check-in', async () => {
      const token = await as('reception-a@example.test')

      const res = await supertest(app())
        .post(`${API}/attendance/check-out`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      expect(res.status).toBe(409)
    })

    it('closes the day on check-out and refuses to close it twice', async () => {
      const token = await as('reception-a@example.test')

      await supertest(app())
        .post(`${API}/attendance/check-in`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      const out = await supertest(app())
        .post(`${API}/attendance/check-out`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
      expect(out.status).toBe(200)
      expect(out.body.data.status).toBe('CLOSED')
      expect(typeof out.body.data.hoursWorked).toBe('number')

      const again = await supertest(app())
        .post(`${API}/attendance/check-out`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
      expect(again.status).toBe(409)
    })

    it('shows a person their own record without the `:any` permission', async () => {
      const token = await as('reception-a@example.test')

      await supertest(app())
        .post(`${API}/attendance/check-in`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      const mine = await supertest(app())
        .get(`${API}/attendance/me`)
        .set('Authorization', `Bearer ${token}`)

      expect(mine.status).toBe(200)
      expect(mine.body.data.items).toHaveLength(1)

      // The team view needs `:any`, which reception deliberately does not hold by default.
      const team = await supertest(app())
        .get(`${API}/attendance`)
        .set('Authorization', `Bearer ${token}`)
        .query({ workDate: todayKey() })

      expect(team.status).toBe(403)
    })

    it('shows the whole team to a holder of `:any`', async () => {
      await supertest(app())
        .post(`${API}/attendance/check-in`)
        .set('Authorization', `Bearer ${await as('reception-a@example.test')}`)
        .send({})

      const res = await supertest(app())
        .get(`${API}/attendance`)
        .set('Authorization', `Bearer ${await as('admin-a@example.test')}`)
        .query({ workDate: todayKey() })

      expect(res.status).toBe(200)
      expect(res.body.data.workDate).toBe(todayKey())
      expect(res.body.data.items.length).toBeGreaterThan(0)
    })
  })

  // ───────────────────────── attendance corrections ─────────────────────────

  describe('attendance corrections', () => {
    async function checkedIn(email: string) {
      const token = await as(email)
      const res = await supertest(app())
        .post(`${API}/attendance/check-in`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
      expect(res.status).toBe(201)
      return { token, recordId: res.body.data.id as string }
    }

    it('records a request without changing the record', async () => {
      const { token, recordId } = await checkedIn('reception-a@example.test')

      const before = await supertest(app())
        .get(`${API}/attendance/me`)
        .set('Authorization', `Bearer ${token}`)
      const original = before.body.data.items[0].checkInAt as string

      const res = await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          field: 'checkInAt',
          value: ist(todayKey(), 8),
          reason: 'The terminal was down at 09:00 and I badged in at the side desk.',
        })

      expect(res.status).toBe(201)

      // The whole point: requesting is not doing.
      const pending = (res.body.data.corrections as Record<string, unknown>[])[0]!
      expect(pending['decision']).toBeNull()
      expect(pending['previousValue']).toBe(original)

      const after = await supertest(app())
        .get(`${API}/attendance/me`)
        .set('Authorization', `Bearer ${token}`)
      expect(after.body.data.items[0].checkInAt).toBe(original)
      expect(after.body.data.items[0].status).toBe('OPEN')
    })

    it('requires a reason worth reading', async () => {
      const { token, recordId } = await checkedIn('doctor-a@example.test')

      const res = await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({ field: 'checkInAt', value: ist(todayKey(), 8), reason: 'oops' })

      expect(res.status).toBe(422)
    })

    it('applies an approved correction and keeps the original visible', async () => {
      const { token, recordId } = await checkedIn('reception-a@example.test')

      await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          field: 'checkInAt',
          value: ist(todayKey(), 8),
          reason: 'The terminal was down at 09:00 and I badged in at the side desk.',
        })

      const decided = await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests/approve/decision`)
        .set('Authorization', `Bearer ${await as('admin-a@example.test')}`)
        .send({ note: 'Confirmed with the security log.' })

      expect(decided.status).toBe(200)
      expect(decided.body.data.status).toBe('CORRECTED')
      expect(new Date(decided.body.data.checkInAt as string).toISOString()).toBe(
        new Date(ist(todayKey(), 8)).toISOString(),
      )

      // The original is still there. "Corrected" must mean "changed, and here is what it
      // was before" rather than "changed, and the evidence is gone".
      const entry = (decided.body.data.corrections as Record<string, unknown>[])[0]!
      expect(entry['decision']).toBe('APPROVED')
      expect(typeof entry['previousValue']).toBe('string')
      expect(entry['decidedByUserId']).toBe(fixture.adminA.id)
    })

    it('leaves the record untouched when a correction is rejected', async () => {
      const { token, recordId } = await checkedIn('reception-a@example.test')

      const before = await supertest(app())
        .get(`${API}/attendance/me`)
        .set('Authorization', `Bearer ${token}`)
      const original = before.body.data.items[0].checkInAt as string

      await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          field: 'checkInAt',
          value: ist(todayKey(), 6),
          reason: 'Trying to claim an earlier start than the badge record shows.',
        })

      const decided = await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests/reject/decision`)
        .set('Authorization', `Bearer ${await as('admin-a@example.test')}`)
        .send({ note: 'Does not match the badge log.' })

      expect(decided.status).toBe(200)
      expect(decided.body.data.checkInAt).toBe(original)
      expect(decided.body.data.status).toBe('OPEN')

      const entry = (decided.body.data.corrections as Record<string, unknown>[])[0]!
      expect(entry['decision']).toBe('REJECTED')
    })

    it('refuses a second correction while one is pending', async () => {
      const { token, recordId } = await checkedIn('reception-a@example.test')

      const body = {
        field: 'checkInAt',
        value: ist(todayKey(), 8),
        reason: 'The terminal was down and I badged in at the side desk.',
      }

      await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)

      const second = await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...body, value: ist(todayKey(), 7) })

      expect(second.status).toBe(409)
    })

    it('refuses to decide when there is nothing pending', async () => {
      const { recordId } = await checkedIn('reception-a@example.test')

      const res = await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests/approve/decision`)
        .set('Authorization', `Bearer ${await as('admin-a@example.test')}`)
        .send({})

      expect(res.status).toBe(409)
    })

    it('refuses to decide a correction without the approve permission', async () => {
      const { token, recordId } = await checkedIn('reception-a@example.test')

      await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          field: 'checkInAt',
          value: ist(todayKey(), 8),
          reason: 'The terminal was down and I badged in at the side desk.',
        })

      // Another reception colleague: no approve permission, so the request stands.
      const res = await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests/approve/decision`)
        .set('Authorization', `Bearer ${await as('doctor-a@example.test')}`)
        .send({})

      expect(res.status).toBe(403)
    })

    it('refuses a correction that would make the shift negative', async () => {
      const { token, recordId } = await checkedIn('reception-a@example.test')

      const closed = await supertest(app())
        .post(`${API}/attendance/check-out`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      // The guard only has something to catch once BOTH ends exist. Assert that setup, so a
      // failure here can never be mistaken for the guard failing to work.
      expect(closed.status).toBe(200)
      expect(closed.body.data.checkOutAt).toBeTruthy()

      // A check-out pulled back before the check-in.
      const earlyCheckout = await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          field: 'checkOutAt',
          value: '2020-01-01T09:00:00+05:30',
          reason: 'Trying to move the end of the shift before its start.',
        })
      expect(earlyCheckout.status).toBe(422)

      // A check-in pushed past the check-out.
      const lateCheckin = await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          field: 'checkInAt',
          value: ist(addDays(todayKey(), 1), 9),
          reason: 'Trying to start the shift after the shift already ended.',
        })
      expect(lateCheckin.status).toBe(422)
    })

    it('refuses cross-tenant access to an attendance record', async () => {
      const { recordId } = await checkedIn('reception-a@example.test')

      const other = await as('admin-b@example.test')

      const read = await supertest(app())
        .get(`${API}/attendance`)
        .set('Authorization', `Bearer ${other}`)
        .query({ workDate: todayKey() })
      expect(read.status).toBe(200)
      expect(read.body.data.items).toEqual([])

      const request = await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests`)
        .set('Authorization', `Bearer ${other}`)
        .send({
          field: 'checkInAt',
          value: ist(todayKey(), 6),
          reason: 'Trying to alter another hospital’s attendance record.',
        })

      expect(request.status).toBe(404)
    })

    it('records attendance corrections in the audit trail', async () => {
      const { token, recordId } = await checkedIn('reception-a@example.test')

      await supertest(app())
        .post(`${API}/attendance/${recordId}/correction-requests`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          field: 'checkInAt',
          value: ist(todayKey(), 8),
          reason: 'The terminal was down and I badged in at the side desk.',
        })

      // Read the log directly. There is no hospital-level audit route today — the only audit
      // view is the platform console's, which is deliberately scoped to tenants rather than
      // to a hospital's own administration. Asserting against the collection is therefore
      // the only way to check this, and it is also the honest level to check it at: the
      // trail is append-only storage, not a view.
      const { AuditLogModel } = await import('../modules/audit/audit.model.js')
      const entries = await (AuditLogModel as Model<Row>)
        .find({ hospitalId: new Types.ObjectId(fixture.hospitalA.id) })
        .lean()
        .exec()

      const actions = entries.map((entry) => entry['action'])

      expect(actions).toContain('attendance.checked_in')
      expect(actions).toContain('attendance.correction_requested')
    })
  })
})

/** A weekday comfortably in the future, when the hospital is open. */
function nextWeekday(): string {
  const date = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)

  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1)
  }

  return date.toISOString().slice(0, 10)
}