import supertest from 'supertest'
import type { Express } from 'express'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  connectTestDatabase,
  createPlatformFixture,
  installTestJwtKeys,
  resetDatabase,
  type PlatformFixture,
} from './auth-harness.js'
import { tryStartTestDatabase } from './mongo.js'

const db = await tryStartTestDatabase()

/**
 * Phase 6 — patients and appointments.
 *
 * The fixture supplies two separate hospitals (A and B), which is what makes the
 * cross-tenant assertions real rather than notional: an id handed from one tenant to the
 * other genuinely exists in the database and genuinely must not be reachable.
 *
 * Every patient in this file is fictional. There is no real patient data anywhere.
 */

const TEST_PASSWORD = 'correct-horse-battery-staple'

/**
 * A weekday comfortably in the future, in the hospital's own calendar.
 *
 * Deliberately not simply "+3 days": that can land on a Sunday, when the default opening
 * hours are empty and no doctor has a roster, so the test would be asserting against a
 * closed day for reasons unrelated to what it is testing.
 */
function futureWeekday(offsetDays = 3): string {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)

  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1)
  }

  return date.toISOString().slice(0, 10)
}

/** ISO instant with an explicit +05:30 offset, which is the form the API requires. */
function ist(dateKey: string, hour: number, minute = 0): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${dateKey}T${pad(hour)}:${pad(minute)}:00+05:30`
}

describe.skipIf(!db.uri)('patients and appointments', () => {
  let fixture: PlatformFixture
  let app: () => Express

  const signIn = (email: string) => fixture.signIn(email, TEST_PASSWORD)
  const asAdminA = () => signIn(fixture.adminA.email)
  const asAdminB = () => signIn(fixture.adminB.email)
  const asReception = () => signIn(fixture.receptionistA.email)

  /** Create a fictional patient. */
  async function createPatient(token: string, suffix: string) {
    return supertest(app())
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'Anaya',
        lastName: `Testpatient${suffix}`,
        dateOfBirth: '1991-04-17',
        gender: 'FEMALE',
        phone: '+91 90000 00000',
        email: `anaya.${suffix}@example.test`,
        address: { city: 'Ahmedabad', state: 'Gujarat', country: 'India' },
        emergencyContact: {
          name: 'Ravi Testpatient',
          relationship: 'Spouse',
          phone: '+91 90000 00001',
        },
      })
  }

  /** Give doctorA a profile and a roster on `dateKey`'s weekday. */
  async function makeDoctorBookable(token: string, dateKey: string): Promise<void> {
    const profile = await supertest(app())
      .post('/api/v1/doctors')
      .set('Authorization', `Bearer ${token}`)
      .send({
        userId: fixture.doctorA.id,
        registrationNumber: `GMC/${dateKey.replace(/-/g, '')}`,
      })

    expect(profile.status, 'doctor profile').toBe(201)

    const weekday = new Date(`${dateKey}T12:00:00.000Z`).getUTCDay()

    const schedule = await supertest(app())
      .put(`/api/v1/doctors/${profile.body.data.id}/schedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        blocks: [{ weekday, startMinute: 9 * 60, endMinute: 17 * 60, slotDurationMinutes: 20 }],
      })

    expect(schedule.status, 'doctor roster').toBe(200)
  }

  /** Book one appointment and return its payload. */
  async function bookOne(
    token: string,
    date: string,
    hour: number,
    suffix: string,
    minute = 0,
  ) {
    const patient = await createPatient(token, suffix)
    expect(patient.status, 'patient').toBe(201)

    const response = await supertest(app())
      .post('/api/v1/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        patientId: patient.body.data.id,
        doctorUserId: fixture.doctorA.id,
        startAt: ist(date, hour, minute),
      })

    return response
  }

  beforeAll(async () => {
    installTestJwtKeys()
    await connectTestDatabase(db.uri as string)
    const mod = await import('../app.js')
    app = mod.createApp
  })

  beforeEach(async () => {
    await resetDatabase()
    fixture = await createPlatformFixture()
  })

  // ─────────────────────────────── patients ──────────────────────────────────

  describe('patient registration', () => {
    it('allocates a sequential, per-hospital patient number', async () => {
      const token = await asAdminA()

      const first = await createPatient(token, '1')
      expect(first.status).toBe(201)
      expect(first.body.data.patientNumber).toMatch(/^PT-\d{6}$/)

      const second = await createPatient(token, '2')
      expect(second.status).toBe(201)

      expect(second.body.data.patientNumber).not.toBe(first.body.data.patientNumber)
      expect(Number(second.body.data.patientNumber.slice(3))).toBe(
        Number(first.body.data.patientNumber.slice(3)) + 1,
      )
    })

    /**
     * Patient numbers are unique PER HOSPITAL, never globally.
     *
     * Two hospitals each hand out their own PT-000001. Forcing global uniqueness would
     * turn a duplicate-key error into a side channel that reveals the size of one
     * hospital's register to every other tenant.
     */
    it('lets two hospitals use the same number independently', async () => {
      const a = await asAdminA()
      const b = await asAdminB()

      const firstA = await createPatient(a, 'A')
      const firstB = await createPatient(b, 'B')

      expect(firstA.status).toBe(201)
      expect(firstB.status).toBe(201)
      expect(firstA.body.data.patientNumber).toBe(firstB.body.data.patientNumber)
    })

    it('refuses a patient with no way to be contacted', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .post('/api/v1/patients')
        .set('Authorization', `Bearer ${token}`)
        .send({ firstName: 'No', lastName: 'Contact', dateOfBirth: '1990-01-01' })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/phone number or an email/i)
    })

    it('rejects an impossible date of birth', async () => {
      const token = await asAdminA()

      for (const dateOfBirth of ['2026-02-31', '1899-01-01', '01/01/1990', '2999-01-01']) {
        const response = await supertest(app())
          .post('/api/v1/patients')
          .set('Authorization', `Bearer ${token}`)
          .send({ firstName: 'Bad', lastName: 'Date', dateOfBirth, phone: '9000000000' })

        expect(response.status, `expected ${dateOfBirth} to be rejected`).toBe(422)
      }
    })

    it('refuses a hospitalId in the body rather than ignoring it', async () => {
      const token = await asAdminA()
      const other = await asAdminB()
      const otherHospital = await supertest(app())
        .get('/api/v1/hospital')
        .set('Authorization', `Bearer ${other}`)

      const response = await supertest(app())
        .post('/api/v1/patients')
        .set('Authorization', `Bearer ${token}`)
        .send({
          firstName: 'Forged',
          lastName: 'Tenant',
          dateOfBirth: '1990-01-01',
          phone: '9000000000',
          hospitalId: otherHospital.body.data.id,
        })

      expect(response.status).toBe(422)
    })
  })

  // ─────────────────────────── search and isolation ──────────────────────────

  describe('search and isolation', () => {
    it('paginates and searches server-side', async () => {
      const token = await asAdminA()

      for (let n = 1; n <= 3; n += 1) {
        const created = await supertest(app())
          .post('/api/v1/patients')
          .set('Authorization', `Bearer ${token}`)
          .send({
            firstName: `Patient${n}`,
            lastName: 'Searchable',
            dateOfBirth: '1990-01-01',
            phone: '9000000000',
          })
        expect(created.status).toBe(201)
      }

      const page = await supertest(app())
        .get('/api/v1/patients?page=1&pageSize=2')
        .set('Authorization', `Bearer ${token}`)

      expect(page.status).toBe(200)
      expect(page.body.data.items).toHaveLength(2)
      expect(page.body.data.page.total).toBe(3)

      const search = await supertest(app())
        .get('/api/v1/patients?q=Patient2')
        .set('Authorization', `Bearer ${token}`)

      expect(search.body.data.page.total).toBe(1)
    })

    it('looks up by exact patient number and by phone', async () => {
      const token = await asAdminA()
      const created = await createPatient(token, 'exact')
      expect(created.status).toBe(201)

      const byNumber = await supertest(app())
        .get(`/api/v1/patients?patientNumber=${created.body.data.patientNumber}`)
        .set('Authorization', `Bearer ${token}`)
      expect(byNumber.body.data.page.total).toBe(1)

      // Punctuation in the stored number must not defeat the lookup: a receptionist reads
      // a number off a card, not out of a database.
      const byPhone = await supertest(app())
        .get('/api/v1/patients?phone=%2B91 90000 00000')
        .set('Authorization', `Bearer ${token}`)
      expect(byPhone.status, JSON.stringify(byPhone.body)).toBe(200)
      expect(byPhone.body.data.page.total).toBe(1)
    })

    it('never exposes another hospital\'s patient', async () => {
      const a = await asAdminA()
      const b = await asAdminB()

      const created = await createPatient(a, 'private')
      const patientId = created.body.data.id

      const read = await supertest(app())
        .get(`/api/v1/patients/${patientId}`)
        .set('Authorization', `Bearer ${b}`)
      expect(read.status).toBe(404)

      const list = await supertest(app())
        .get('/api/v1/patients?pageSize=100')
        .set('Authorization', `Bearer ${b}`)
      expect((list.body.data.items ?? []).some((p: { id: string }) => p.id === patientId)).toBe(
        false,
      )

      const update = await supertest(app())
        .patch(`/api/v1/patients/${patientId}`)
        .set('Authorization', `Bearer ${b}`)
        .send({ firstName: 'Hijacked' })
      expect(update.status).toBe(404)
    })

    it('refuses the patient module to a platform operator', async () => {
      const token = await fixture.platformToken()

      const response = await supertest(app())
        .get('/api/v1/patients')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(403)
    })
  })

  // ────────────────────────── data minimisation ──────────────────────────────

  describe('data minimisation', () => {
    /**
     * The permission split has to control disclosure, not just reach.
     *
     * A membership holding `patient:read` but NOT `patient:write` — the accountant's
     * configuration — sees demographics and nothing that says where the patient lives or
     * who to telephone in an emergency. That is the point of splitting the permission.
     */
    it('withholds contact details from a reader who cannot write', async () => {
      const admin = await asAdminA()

      const created = await createPatient(admin, 'masked')
      expect(created.status).toBe(201)

      // A HOSPITAL_ADMIN holds `patient:write`, so the writer sees everything.
      expect(created.body.data.contactVisible).toBe(true)
      expect(created.body.data.phone).toBe('+91 90000 00000')

      // Narrow the membership down to `patient:read` only and sign in again as that user.
      const { MembershipModel } = await import('../modules/identity/models.js')

      await (MembershipModel as unknown as {
        updateOne(filter: unknown, update: unknown): { exec(): Promise<unknown> }
      })
        .updateOne(
          { userId: fixture.adminA.id },
          { $set: { grantedPermissions: ['hospital:read', 'patient:read'] } },
        )
        .exec()

      const readOnlyToken = await asAdminA()

      const asReader = await supertest(app())
        .get(`/api/v1/patients/${created.body.data.id}`)
        .set('Authorization', `Bearer ${readOnlyToken}`)

      expect(asReader.status).toBe(200)
      expect(asReader.body.data.contactVisible).toBe(false)
      expect(asReader.body.data.phone).toBeNull()
      expect(asReader.body.data.email).toBeNull()
      expect(asReader.body.data.address).toBeNull()
      // The emergency contact names a THIRD PARTY who never chose to be in this system.
      expect(asReader.body.data.emergencyContact).toBeNull()

      // Demographics are still there — restricted is not the same as useless.
      expect(asReader.body.data.firstName).toBe('Anaya')
      expect(asReader.body.data.patientNumber).toBe(created.body.data.patientNumber)

      // And the same restriction applies to a list, not only to a single record.
      const list = await supertest(app())
        .get('/api/v1/patients?q=Testpatientmasked')
        .set('Authorization', `Bearer ${readOnlyToken}`)

      expect(list.status).toBe(200)
      expect(list.body.data.items[0].phone).toBeNull()
    })

    it('stores no clinical fields, and refuses attempts to add them', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .post('/api/v1/patients')
        .set('Authorization', `Bearer ${token}`)
        .send({
          firstName: 'Should',
          lastName: 'BeRejected',
          dateOfBirth: '1990-01-01',
          phone: '9000000000',
          allergies: 'penicillin',
          diagnosis: 'diabetes',
          notes: 'clinical free text',
        })

      // `.strict()` refuses unknown keys outright, so clinical content cannot be smuggled
      // into a demographics record through an unanticipated field.
      expect(response.status).toBe(422)
    })

    it('keeps patient details out of the audit trail entirely', async () => {
      const adminA = await asAdminA()
      const operator = await fixture.platformToken()

      const created = await createPatient(adminA, 'audited')
      expect(created.status).toBe(201)

      const audit = await supertest(app())
        .get('/api/v1/platform/audit?limit=100')
        .set('Authorization', `Bearer ${operator}`)

      // Scan the EVENTS, not the whole envelope: `nextCursor` is base64url and begins
      // "eyJ" because it encodes a JSON object, which would match a JWT prefix by chance.
      const events = JSON.stringify(audit.body?.data?.items ?? [])

      expect(events).not.toContain('anaya.audited@example.test')
      expect(events).not.toContain('1991-04-17')
      expect(events).not.toContain('Ravi Testpatient')
      // Nothing that identifies the person survives.
      expect(events).not.toContain('anaya.audited@example.test')
      expect(events).not.toContain('1991-04-17')
      expect(events).not.toContain('Ravi Testpatient')
      // Including the patient NUMBER. This test originally asserted the opposite, and
      // was wrong: the platform console redacts metadata on read, and the audit trail is
      // broadly readable by design (docs/SECURITY.md R8). Being able to point at a
      // specific patient from an audit search would itself be a disclosure.
      expect(events).not.toContain(created.body.data.patientNumber)
    })
  })

  // ────────────────────────────── booking ────────────────────────────────────

  describe('booking', () => {
    it('books inside working hours and on the doctor\'s roster', async () => {
      const token = await asAdminA()
      const date = futureWeekday()

      await makeDoctorBookable(token, date)
      const patient = await createPatient(token, 'booked')

      const response = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: patient.body.data.id,
          doctorUserId: fixture.doctorA.id,
          startAt: ist(date, 10, 0),
          reason: 'Follow-up consultation',
        })

      expect(response.status).toBe(201)
      expect(response.body.data.status).toBe('SCHEDULED')
      expect(response.body.data.statusHistory).toHaveLength(1)
      expect(response.body.data.reason).toBe('Follow-up consultation')
    })

    it('refuses a time outside the hospital\'s opening hours', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)
      const patient = await createPatient(token, 'early')

      const response = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: patient.body.data.id,
          doctorUserId: fixture.doctorA.id,
          startAt: ist(date, 6, 0),
        })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/open 09:00/i)
    })

    it('refuses a time outside the doctor\'s roster but inside opening hours', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)
      const patient = await createPatient(token, 'offroster')

      // Hospital opens to 18:00; the doctor's roster stops at 17:00.
      const response = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: patient.body.data.id,
          doctorUserId: fixture.doctorA.id,
          startAt: ist(date, 17, 40),
        })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/roster/i)
    })

    it('refuses a bare local time and says what to send instead', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)
      const patient = await createPatient(token, 'baretime')

      const response = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: patient.body.data.id,
          doctorUserId: fixture.doctorA.id,
          startAt: `${date}T10:00:00`,
        })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/offset/i)
    })

    it('refuses a time in the past', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)
      const patient = await createPatient(token, 'past')

      const response = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: patient.body.data.id,
          doctorUserId: fixture.doctorA.id,
          startAt: ist('2020-01-06', 10, 0),
        })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/cannot be in the past/i)
    })

    it('refuses a start that is not on the slot grid', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)
      const patient = await createPatient(token, 'offgrid')

      const response = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: patient.body.data.id,
          doctorUserId: fixture.doctorA.id,
          startAt: ist(date, 10, 7),
        })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/boundaries/i)
    })
  })

  // ──────────────────── the double-booking guarantee ─────────────────────────

  describe('double booking', () => {
    it('rejects a second booking for the same slot', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)

      const first = await bookOne(token, date, 11, 'slot1')
      expect(first.status).toBe(201)

      const second = await bookOne(token, date, 11, 'slot2')
      expect(second.status).toBe(409)
      expect(second.body.error.message).toMatch(/already booked/i)
    })

    it('rejects an overlapping booking, not only an identical one', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)

      const p1 = await createPatient(token, 'overlap1')
      expect(p1.status).toBe(201)

      // 40 minutes occupies three 20-minute slots, so 11:20 falls inside it.
      const long = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: p1.body.data.id,
          doctorUserId: fixture.doctorA.id,
          startAt: ist(date, 11, 0),
          durationMinutes: 40,
        })
      expect(long.status).toBe(201)

      const p2 = await createPatient(token, 'overlap2')
      const overlapping = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: p2.body.data.id,
          doctorUserId: fixture.doctorA.id,
          startAt: ist(date, 11, 20),
        })

      expect(overlapping.status).toBe(409)
    })

    /**
     * The claim that matters: two requests racing for one slot must yield exactly one
     * booking. An application-level "is the doctor free?" check passes for both, because
     * both read "free" before either writes. The unique index does not have that window.
     */
    it('lets exactly one of two simultaneous bookings win', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)

      const a = await createPatient(token, 'raceA')
      const b = await createPatient(token, 'raceB')

      const payload = (patientId: string) => ({
        patientId,
        doctorUserId: fixture.doctorA.id,
        startAt: ist(date, 13, 0),
      })

      const [first, second] = await Promise.all([
        supertest(app())
          .post('/api/v1/appointments')
          .set('Authorization', `Bearer ${token}`)
          .send(payload(a.body.data.id)),
        supertest(app())
          .post('/api/v1/appointments')
          .set('Authorization', `Bearer ${token}`)
          .send(payload(b.body.data.id)),
      ])

      expect([first.status, second.status].sort()).toEqual([201, 409])
    })

    it('leaves no orphan appointment behind when a booking conflicts', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)

      expect((await bookOne(token, date, 14, 'orphan1')).status).toBe(201)
      expect((await bookOne(token, date, 14, 'orphan2')).status).toBe(409)

      const list = await supertest(app())
        .get(`/api/v1/appointments?from=${encodeURIComponent(ist(date, 0, 0))}`)
        .set('Authorization', `Bearer ${token}`)

      // The rejected booking must not survive as a row showing a time nobody can use.
      expect(list.body.data.items).toHaveLength(1)
    })

    it('does not let two different doctors clash with each other', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)

      const p1 = await createPatient(token, 'docA')
      const p2 = await createPatient(token, 'docB')

      const first = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: p1.body.data.id,
          doctorUserId: fixture.doctorA.id,
          startAt: ist(date, 15, 0),
        })
      expect(first.status).toBe(201)

      // A receptionist creating a second doctor to prove the constraint is per doctor.
      const secondDoctor = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'second.doctor@example.test',
          firstName: 'Second',
          lastName: 'Doctor',
          role: 'DOCTOR',
        })
      expect(secondDoctor.status).toBe(201)

      const profile = await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${token}`)
        .send({
          userId: secondDoctor.body.data.userId,
          registrationNumber: 'GMC/SECOND-0001',
        })
      expect(profile.status).toBe(201)

      const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay()
      await supertest(app())
        .put(`/api/v1/doctors/${profile.body.data.id}/schedule`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          blocks: [{ weekday, startMinute: 540, endMinute: 1020, slotDurationMinutes: 20 }],
        })

      const sameTime = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: p2.body.data.id,
          doctorUserId: secondDoctor.body.data.userId,
          startAt: ist(date, 15, 0),
        })

      // Two patients, two doctors, one slot: entirely legitimate.
      expect(sameTime.status).toBe(201)
    })
  })

  // ─────────────────────── cancellation and history ──────────────────────────

  describe('cancellation', () => {
    it('cancels, records the reason, and frees the slot', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)

      const booked = await bookOne(token, date, 15, 'cancel1')
      expect(booked.status).toBe(201)
      const appointmentId = booked.body.data.id as string

      const cancelled = await supertest(app())
        .post(`/api/v1/appointments/${appointmentId}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Patient reported they cannot travel today.' })

      expect(cancelled.status).toBe(200)
      expect(cancelled.body.data.status).toBe('CANCELLED')
      expect(cancelled.body.data.cancellationReason).toMatch(/cannot travel/)
      expect(cancelled.body.data.statusHistory).toHaveLength(2)
      expect(cancelled.body.data.statusHistory[1]).toMatchObject({
        from: 'SCHEDULED',
        to: 'CANCELLED',
      })

      // The freed slot is genuinely bookable again — a cancelled booking that still
      // occupies its slot is how a clinic ends up full and empty at the same time.
      const rebook = await bookOne(token, date, 15, 'cancel2')
      expect(rebook.status).toBe(201)
    })

    it('requires a reason worth recording', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)
      const booked = await bookOne(token, date, 16, 'noreason')

      const response = await supertest(app())
        .post(`/api/v1/appointments/${booked.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'busy' })

      expect(response.status).toBe(422)
    })

    it('refuses to cancel twice', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)
      const booked = await bookOne(token, date, 16, 'twice')

      await supertest(app())
        .post(`/api/v1/appointments/${booked.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'First cancellation by the front desk.' })

      const again = await supertest(app())
        .post(`/api/v1/appointments/${booked.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Second cancellation attempt here.' })

      expect(again.status).toBe(409)
    })

    it('never lets one hospital cancel another\'s appointment', async () => {
      const a = await asAdminA()
      const b = await asAdminB()
      const date = futureWeekday()
      await makeDoctorBookable(a, date)
      const booked = await bookOne(a, date, 15, 'crosscancel')

      const response = await supertest(app())
        .post(`/api/v1/appointments/${booked.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${b}`)
        .send({ reason: 'Attempting to cancel a rival appointment.' })

      expect(response.status).toBe(404)

      const still = await supertest(app())
        .get(`/api/v1/appointments/${booked.body.data.id}`)
        .set('Authorization', `Bearer ${a}`)
      expect(still.body.data.status).toBe('SCHEDULED')
    })
  })

  // ───────────────────────────── rescheduling ───────────────────────────────

  describe('rescheduling', () => {
    it('moves an appointment, records why, and frees the old slot', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)

      const patient = await createPatient(token, 'resched')
      const booked = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: patient.body.data.id,
          doctorUserId: fixture.doctorA.id,
          startAt: ist(date, 10, 0),
        })
      expect(booked.status).toBe(201)

      const moved = await supertest(app())
        .patch(`/api/v1/appointments/${booked.body.data.id}/reschedule`)
        .set('Authorization', `Bearer ${token}`)
        .send({ startAt: ist(date, 12, 0), reason: 'Patient requested a later time.' })

      expect(moved.status).toBe(200)
      expect(moved.body.data.startAt).toBe(new Date(ist(date, 12, 0)).toISOString())
      expect(moved.body.data.statusHistory).toHaveLength(2)

      const reuse = await bookOne(token, date, 10, 'resched2')
      expect(reuse.status).toBe(201)
    })

    it('refuses to move onto an occupied slot', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)

      const keeper = await bookOne(token, date, 11, 'mov1')
      expect(keeper.status).toBe(201)

      const mover = await bookOne(token, date, 12, 'mov2')
      expect(mover.status).toBe(201)

      const clash = await supertest(app())
        .patch(`/api/v1/appointments/${mover.body.data.id}/reschedule`)
        .set('Authorization', `Bearer ${token}`)
        .send({ startAt: ist(date, 11, 0), reason: 'Trying to move onto a taken slot.' })

      expect(clash.status).toBe(409)
    })

    it('refuses to reschedule a cancelled appointment', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)
      const booked = await bookOne(token, date, 12, 'cancelthenmove')

      await supertest(app())
        .post(`/api/v1/appointments/${booked.body.data.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Cancelled before any reschedule.' })

      const moved = await supertest(app())
        .patch(`/api/v1/appointments/${booked.body.data.id}/reschedule`)
        .set('Authorization', `Bearer ${token}`)
        .send({ startAt: ist(date, 13, 0), reason: 'Trying to revive a cancelled booking.' })

      expect(moved.status).toBe(409)
    })
  })

  // ──────────────────────── doctor self-scoping ──────────────────────────────

  describe('a doctor sees only their own schedule', () => {
    it('hides appointments belonging to another doctor', async () => {
      const admin = await asAdminA()
      const doctor = await signIn(fixture.doctorA.email)
      const date = futureWeekday()

      await makeDoctorBookable(admin, date)

      // A second doctor in the SAME hospital, with a roster on that day.
      const other = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${admin}`)
        .send({
          email: 'other.doctor@example.test',
          firstName: 'Other',
          lastName: 'Doctor',
          role: 'DOCTOR',
        })
      expect(other.status).toBe(201)

      const otherUserId = other.body.data.userId as string

      const profile = await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${admin}`)
        .send({ userId: otherUserId, registrationNumber: 'GMC/OTHER-0001' })
      expect(profile.status).toBe(201)

      const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay()
      await supertest(app())
        .put(`/api/v1/doctors/${profile.body.data.id}/schedule`)
        .set('Authorization', `Bearer ${admin}`)
        .send({
          blocks: [{ weekday, startMinute: 540, endMinute: 1020, slotDurationMinutes: 20 }],
        })

      // Book the OTHER doctor, not our own. An earlier version of this test booked
      // doctorA and then queried AS doctorA, which naturally returned a row � so it
      // passed while proving nothing about scoping.
      const patient = await createPatient(admin, 'selfscope')
      const booked = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${admin}`)
        .send({
          patientId: patient.body.data.id,
          doctorUserId: otherUserId,
          startAt: ist(date, 10, 0),
        })
      expect(booked.status).toBe(201)

      // Asking for that other doctor's day must yield nothing: the service replaces the
      // requested doctor with the caller's own id rather than honouring the request.
      const read = await supertest(app())
        .get(`/api/v1/appointments?doctorUserId=${otherUserId}`)
        .set('Authorization', `Bearer ${doctor}`)

      expect(read.status).toBe(200)
      expect(read.body.data.items).toHaveLength(0)

      // Reading it by id is refused outright.
      const direct = await supertest(app())
        .get(`/api/v1/appointments/${booked.body.data.id}`)
        .set('Authorization', `Bearer ${doctor}`)
      expect(direct.status).toBe(403)

      // An administrator asking the same question DOES see it � which is what proves the
      // emptiness above is scoping rather than a booking that failed to save.
      const asAdmin = await supertest(app())
        .get(`/api/v1/appointments?doctorUserId=${otherUserId}`)
        .set('Authorization', `Bearer ${admin}`)
      expect(asAdmin.body.data.items).toHaveLength(1)
    })


    /**
     * The other half of the same rule: reception holds `:any` precisely because booking on
     * behalf of other doctors is its job. Without this, "self only" would restrict
     * reception too, and the clinic could not be booked at all.
     */
    it('lets reception see the whole clinic, because it holds the `:any` permissions', async () => {
      const admin = await asAdminA()
      const reception = await asReception()
      const date = futureWeekday()

      await makeDoctorBookable(admin, date)
      const booked = await bookOne(admin, date, 10, 'receptionview')
      expect(booked.status).toBe(201)

      const read = await supertest(app())
        .get(`/api/v1/appointments/${booked.body.data.id}`)
        .set('Authorization', `Bearer ${reception}`)

      expect(read.status).toBe(200)
      expect(read.body.data.id).toBe(booked.body.data.id)
    })
  })

  // -------------------------------- day view ---------------------------------

  describe('the day view', () => {
    /**
     * The hospital calendar day, not the caller's.
     *
     * 10:00 IST is stored as 04:30 UTC. A view that grouped by UTC date would file this
     * appointment on the previous day for anyone east of Greenwich, so the local time is
     * derived here from the instant, using the hospital own zone.
     */
    it('returns the hospital calendar day, with local times derived from the instant', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)
      expect((await bookOne(token, date, 10, 'dayview')).status).toBe(201)

      const day = await supertest(app())
        .get(`/api/v1/appointments/day?date=${date}`)
        .set('Authorization', `Bearer ${token}`)

      expect(day.status).toBe(200)
      expect(day.body.data.timezone).toBe('Asia/Kolkata')
      expect(day.body.data.appointments).toHaveLength(1)
      expect(day.body.data.appointments[0].localTime).toBe('10:00')
      expect(day.body.data.counts.SCHEDULED).toBe(1)
    })

    it('rejects a malformed date rather than guessing at one', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .get('/api/v1/appointments/day?date=11-10-2026')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(422)
    })
  })

  // ────────────────────────────── availability ───────────────────────────────

  describe('availability', () => {
    it('omits slots that are already taken', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)
      expect((await bookOne(token, date, 10, 'avail')).status).toBe(201)

      const availability = await supertest(app())
        .get(
          `/api/v1/appointments/availability?date=${date}&doctorUserId=${fixture.doctorA.id}`,
        )
        .set('Authorization', `Bearer ${token}`)

      expect(availability.status).toBe(200)

      const times = availability.body.data.doctors[0].freeSlots.map(
        (slot: { localTime: string }) => slot.localTime,
      )
      expect(times).not.toContain('10:00')
      expect(times).toContain('10:20')
    })
  })

  // ─────────────────────── configurable working hours ────────────────────────

  describe('configurable working hours', () => {
    it('closes a day and then refuses bookings on it', async () => {
      const token = await asAdminA()
      const date = futureWeekday()
      await makeDoctorBookable(token, date)
      const patient = await createPatient(token, 'closed')

      const weekday = String(new Date(`${date}T12:00:00.000Z`).getUTCDay())

      const update = await supertest(app())
        .patch('/api/v1/appointments/working-hours')
        .set('Authorization', `Bearer ${token}`)
        .send({ workingHours: { [weekday]: null } })

      expect(update.status).toBe(200)

      const response = await supertest(app())
        .post('/api/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({
          patientId: patient.body.data.id,
          doctorUserId: fixture.doctorA.id,
          startAt: ist(date, 10, 0),
        })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/closed/i)
    })

    it('refuses working hours that close before they open', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .patch('/api/v1/appointments/working-hours')
        .set('Authorization', `Bearer ${token}`)
        .send({ workingHours: { '1': { opensAtMinute: 1080, closesAtMinute: 540 } } })

      expect(response.status).toBe(422)
    })
  })
})
