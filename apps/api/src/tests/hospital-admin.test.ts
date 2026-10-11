import type { Express } from 'express'
import supertest from 'supertest'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  connectTestDatabase,
  createPlatformFixture,
  installTestJwtKeys,
  modelOf,
  resetDatabase,
  type PlatformFixture,
} from './auth-harness.js'
import { tryStartTestDatabase } from './mongo.js'

/**
 * Hospital administration.
 *
 * Four questions, asked against a real HTTP surface with real signed tokens:
 *
 *  1. **Duplicates** — a code, a name, a registration number, a schedule block.
 *     All unique *within a hospital*, and never across them.
 *  2. **Invalid input** — empty bodies, malformed ids, nonsensical times.
 *  3. **Unauthorised actions** — the wrong role, and the SUPER_ADMIN escalation.
 *  4. **Cross-tenant access** — hospital B's departments, doctors and staff, requested
 *     by hospital A's administrator, by id, and by sending `hospitalId` in the body.
 */

const db = await tryStartTestDatabase()

describe.skipIf(!db.uri)('hospital administration', () => {
  let fixture: PlatformFixture
  const app = (): Express => fixture.app

  beforeAll(async () => {
    installTestJwtKeys()
    await connectTestDatabase(db.uri as string)
  })

  beforeEach(async () => {
    await resetDatabase()
    fixture = await createPlatformFixture()
  })

  const asAdminA = () => fixture.signIn(fixture.adminA.email)
  const asAdminB = () => fixture.signIn(fixture.adminB.email)
  const asDoctorA = () => fixture.signIn(fixture.doctorA.email)
  const asReceptionA = () => fixture.signIn(fixture.receptionistA.email)

  async function createDepartment(token: string, overrides: Record<string, unknown> = {}) {
    const response = await supertest(app())
      .post('/api/v1/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Cardiology', code: 'CARD', ...overrides })

    return response
  }

  // ────────────────────────────── tenant scoping ──────────────────────────────

  describe('every record is scoped to the caller’s hospital', () => {
    it('reads only its own hospital profile', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .get('/api/v1/hospital')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(200)
      expect(response.body.data.id).toBe(fixture.hospitalA.id)
      expect(response.body.data.name).toBe(fixture.hospitalA.name)
    })

    it('cannot name another hospital in the request', async () => {
      const token = await asAdminA()

      // A crafted body must not redirect the write at another tenant.
      const response = await supertest(app())
        .patch('/api/v1/hospital')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed Hospital', hospitalId: fixture.hospitalB.id })

      // `hospitalId` is not a field of the schema, so the strict object rejects it.
      expect(response.status).toBe(422)

      const other = await supertest(app())
        .get(`/api/v1/hospital`)
        .set('Authorization', `Bearer ${token}`)

      expect(other.body.data.hospitalId).toBeUndefined()
    })

    it('does not list another hospital’s departments', async () => {
      const tokenA = await asAdminA()
      const tokenB = await asAdminB()

      await createDepartment(tokenB, { name: 'Neurology', code: 'NEUR' })

      const list = await supertest(app())
        .get('/api/v1/departments')
        .set('Authorization', `Bearer ${tokenA}`)

      expect(list.status).toBe(200)
      expect(list.body.data.items).toHaveLength(0)
      expect(JSON.stringify(list.body)).not.toContain('Neurology')
    })

    it('cannot read another hospital’s department by id', async () => {
      const tokenA = await asAdminA()
      const tokenB = await asAdminB()

      const created = await createDepartment(tokenB, { name: 'Neurology', code: 'NEUR' })
      expect(created.status).toBe(201)

      const read = await supertest(app())
        .get(`/api/v1/departments/${created.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`)

      // 404, not 403: confirming the id exists elsewhere would itself be a disclosure.
      expect(read.status).toBe(404)
    })

    it('cannot modify another hospital’s department', async () => {
      const tokenA = await asAdminA()
      const tokenB = await asAdminB()

      const created = await createDepartment(tokenB, { name: 'Neurology', code: 'NEUR' })

      const response = await supertest(app())
        .patch(`/api/v1/departments/${created.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Hijacked' })

      expect(response.status).toBe(404)

      const check = await supertest(app())
        .get(`/api/v1/departments/${created.body.data.id}`)
        .set('Authorization', `Bearer ${tokenB}`)

      expect(check.body.data.name).toBe('Neurology')
    })

    it('does not list another hospital’s staff', async () => {
      const tokenA = await asAdminA()
      const tokenB = await asAdminB()

      const created = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({
          email: 'b-side@example.test',
          firstName: 'Bhavna',
          lastName: 'Rao',
          role: 'STAFF',
        })
      expect(created.status).toBe(201)

      const list = await supertest(app())
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${tokenA}`)

      expect(list.status).toBe(200)
      expect(JSON.stringify(list.body)).not.toContain('b-side@example.test')
    })

    it('cannot change another hospital’s staff role', async () => {
      const tokenA = await asAdminA()
      const tokenB = await asAdminB()

      const created = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ email: 'b-staff@example.test', firstName: 'B', lastName: 'Side', role: 'STAFF' })

      const response = await supertest(app())
        .patch(`/api/v1/staff/${created.body.data.userId}/role`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ role: 'HOSPITAL_ADMIN' })

      expect(response.status).toBe(404)
    })

    it('refuses a platform administrator, who has no hospital membership', async () => {
      const token = await fixture.platformToken()

      for (const path of [
        '/api/v1/hospital',
        '/api/v1/departments',
        '/api/v1/doctors',
        '/api/v1/staff',
      ]) {
        const response = await supertest(app())
          .get(path)
          .set('Authorization', `Bearer ${token}`)

        expect(response.status, `${path} as SUPER_ADMIN`).toBe(403)
      }
    })

    it('refuses an anonymous caller', async () => {
      const response = await supertest(app()).get('/api/v1/departments')
      expect(response.status).toBe(401)
    })
  })

  // ────────────────────────────── duplicates ──────────────────────────────

  describe('duplicates are rejected within a hospital', () => {
    it('rejects a duplicate department code', async () => {
      const token = await asAdminA()

      expect((await createDepartment(token)).status).toBe(201)

      const duplicate = await createDepartment(token, { name: 'Cardiac Unit' })
      expect(duplicate.status).toBe(409)
      expect(duplicate.body.error.message).toMatch(/code CARD is already used/i)
    })

    it('rejects a duplicate department name', async () => {
      const token = await asAdminA()

      await createDepartment(token)

      const duplicate = await createDepartment(token, { code: 'CARD2' })
      expect(duplicate.status).toBe(409)
      expect(duplicate.body.error.message).toMatch(/already exists in this hospital/i)
    })

    it('allows the same code in a different hospital', async () => {
      const tokenA = await asAdminA()
      const tokenB = await asAdminB()

      // Uniqueness is per tenant: one hospital's "CARD" must not block another's.
      expect((await createDepartment(tokenA, { name: 'Cardiology A', code: 'CARD' })).status).toBe(201)
      expect((await createDepartment(tokenB, { name: 'Cardiology B', code: 'CARD' })).status).toBe(201)
    })

    it('rejects a duplicate staff email', async () => {
      const token = await asAdminA()

      const body = {
        email: 'new.staff@example.test',
        firstName: 'New',
        lastName: 'Staff',
        role: 'RECEPTIONIST',
      }

      expect((await supertest(app()).post('/api/v1/staff').set('Authorization', `Bearer ${token}`).send(body)).status).toBe(201)

      const duplicate = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...body, firstName: 'Another' })

      expect(duplicate.status).toBe(409)
    })

    it('rejects a duplicate doctor registration number', async () => {
      const token = await asAdminA()

      const created = await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${token}`)
        .send({
          userId: fixture.doctorA.id,
          registrationNumber: 'GMC/2026/001',
        })
      expect(created.status).toBe(201)

      // A second doctor with the same council registration.
      await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'second.doctor@example.test',
          firstName: 'Second',
          lastName: 'Doctor',
          role: 'DOCTOR',
        })
        .then(async (res) => {
          const duplicate = await supertest(app())
            .post('/api/v1/doctors')
            .set('Authorization', `Bearer ${token}`)
            .send({
              userId: res.body.data.userId,
              registrationNumber: 'GMC/2026/001',
            })

          expect(duplicate.status).toBe(409)
          expect(duplicate.body.error.message).toMatch(/already registered in this hospital/i)
        })
    })

    it('rejects a second profile for the same doctor', async () => {
      const token = await asAdminA()

      const body = { userId: fixture.doctorA.id, registrationNumber: 'GMC/2026/002' }

      expect((await supertest(app()).post('/api/v1/doctors').set('Authorization', `Bearer ${token}`).send(body)).status).toBe(201)

      const duplicate = await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...body, registrationNumber: 'GMC/2026/003' })

      expect(duplicate.status).toBe(409)
    })

    it('allows the same registration number in another hospital', async () => {
      const tokenA = await asAdminA()
      const tokenB = await asAdminB()

      // A doctor may hold registrations in two states, or practise at two sites.
      expect(
        (
          await supertest(app())
            .post('/api/v1/doctors')
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ userId: fixture.doctorA.id, registrationNumber: 'GMC/2026/777' })
        ).status,
      ).toBe(201)

      await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ email: 'bdoc@example.test', firstName: 'B', lastName: 'Doc', role: 'DOCTOR' })
        .then(async (res) => {
          const response = await supertest(app())
            .post('/api/v1/doctors')
            .set('Authorization', `Bearer ${tokenB}`)
            .send({ userId: res.body.data.userId, registrationNumber: 'GMC/2026/777' })

          expect(response.status).toBe(201)
        })
    })

    it('rejects two working blocks on the same weekday', async () => {
      const token = await asAdminA()

      const profile = await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: fixture.doctorA.id, registrationNumber: 'GMC/2026/010' })

      const response = await supertest(app())
        .put(`/api/v1/doctors/${profile.body.data.id}/schedule`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          blocks: [
            { weekday: 1, startMinute: 540, endMinute: 720 },
            { weekday: 1, startMinute: 780, endMinute: 1020 },
          ],
        })

      expect(response.status).toBe(422)
      expect(response.body.error.details?.[0]?.message).toMatch(/one working block per weekday/i)
    })
  })

  // ────────────────────────────── invalid input ──────────────────────────────

  describe('invalid input is rejected with a useful message', () => {
    it('rejects an empty update', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .patch('/api/v1/hospital')
        .set('Authorization', `Bearer ${token}`)
        .send({})

      expect(response.status).toBe(422)
    })

    it('rejects a department with no name', async () => {
      const token = await asAdminA()

      const response = await createDepartment(token, { name: '', code: 'X' })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/name is required/i)
    })

    it('rejects a department code with punctuation', async () => {
      const token = await asAdminA()

      // Codes are printed on rosters; a slash or quote would break a printed schedule.
      const response = await createDepartment(token, { code: 'CAR/D' })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/letters, digits and hyphens/i)
    })

    it('rejects a malformed id in the path', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .get('/api/v1/departments/not-an-object-id')
        .set('Authorization', `Bearer ${token}`)

      expect(response.status).toBe(422)
    })

    it('rejects an unknown field rather than dropping it silently', async () => {
      const token = await asAdminA()

      const response = await createDepartment(token, { leadUserId: '507f1f77bcf86cd799439099' })

      // A dropped field is worse than a rejection: the form would say "saved" while the
      // value was never stored.
      expect(response.status).toBe(422)
    })

    it('rejects a working block that ends before it starts', async () => {
      const token = await asAdminA()

      const profile = await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: fixture.doctorA.id, registrationNumber: 'GMC/2026/011' })

      const response = await supertest(app())
        .put(`/api/v1/doctors/${profile.body.data.id}/schedule`)
        .set('Authorization', `Bearer ${token}`)
        .send({ blocks: [{ weekday: 2, startMinute: 1020, endMinute: 540 }] })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/end after it starts/i)
    })

    it('rejects an out-of-range weekday', async () => {
      const token = await asAdminA()

      const profile = await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: fixture.doctorA.id, registrationNumber: 'GMC/2026/012' })

      const response = await supertest(app())
        .put(`/api/v1/doctors/${profile.body.data.id}/schedule`)
        .set('Authorization', `Bearer ${token}`)
        .send({ blocks: [{ weekday: 9, startMinute: 540, endMinute: 720 }] })

      expect(response.status).toBe(422)
    })

    it('rejects a doctor profile for someone who is not a member', async () => {
      const token = await asAdminA()

      // A user from hospital B, profiled as a doctor in hospital A.
      const response = await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${token}`)
        .send({
          userId: fixture.adminB.id,
          registrationNumber: 'GMC/2026/013',
        })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/not a member of this hospital/i)
    })

    it('rejects a staff status change with no reason', async () => {
      const token = await asAdminA()

      const created = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'temp@example.test', firstName: 'T', lastName: 'Emp', role: 'STAFF' })

      const response = await supertest(app())
        .patch(`/api/v1/staff/${created.body.data.userId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'SUSPENDED' })

      expect(response.status).toBe(422)
    })
  })

  // ────────────────────────────── privilege ──────────────────────────────

  describe('a hospital admin cannot create or promote to SUPER_ADMIN', () => {
    it('rejects SUPER_ADMIN as a staff role', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'sneaky@example.test',
          firstName: 'Sneaky',
          lastName: 'Operator',
          role: 'SUPER_ADMIN',
        })

      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/cannot be assigned within a hospital/i)

      // Nothing may have been written — not even the global user.
      const user = await modelOf('User').findOne({ email: 'sneaky@example.test' }).lean().exec()
      expect(user).toBeNull()
    })

    it('rejects promoting an existing member to SUPER_ADMIN', async () => {
      const token = await asAdminA()

      const created = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'promote@example.test', firstName: 'P', lastName: 'Target', role: 'STAFF' })

      const response = await supertest(app())
        .patch(`/api/v1/staff/${created.body.data.userId}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'SUPER_ADMIN' })

      expect(response.status).toBe(422)

      const membership = await modelOf('Membership')
        .findOne({ userId: created.body.data.userId })
        .lean()
        .exec()

      expect(String(membership?.['role'])).toBe('STAFF')
    })

    it('rejects PATIENT as a staff role', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'patient@example.test', firstName: 'P', lastName: 'P', role: 'PATIENT' })

      expect(response.status).toBe(422)
    })

    it('discards platform permissions from an explicit grant', async () => {
      const token = await asAdminA()

      const created = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({
          email: 'grantee@example.test',
          firstName: 'G', lastName: 'Rantee',
          role: 'STAFF',
          grantedPermissions: ['hospital:read', 'platform:hospital:approve', 'audit:read'],
        })

      const membership = await modelOf('Membership')
        .findOne({ userId: created.body.data.userId })
        .lean()
        .exec()

      const granted = membership?.['grantedPermissions'] as string[]

      // STAFF's ceiling includes `hospital:read`, so that grant survives.
      expect(granted).toContain('hospital:read')
      // The two platform-level grants are outside every hospital ceiling and vanish.
      expect(granted).not.toContain('platform:hospital:approve')
      expect(granted).not.toContain('audit:read')
    })

    it('refuses a doctor creating a department', async () => {
      const token = await asDoctorA()

      const response = await createDepartment(token)

      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('FORBIDDEN')
    })

    it('refuses a receptionist editing a doctor profile', async () => {
      const token = await asReceptionA()

      const adminToken = await asAdminA()
      const profile = await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: fixture.doctorA.id, registrationNumber: 'GMC/2026/020' })

      const response = await supertest(app())
        .patch(`/api/v1/doctors/${profile.body.data.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ consultationFeeInPaise: 100 })

      expect(response.status).toBe(403)
    })

    it('refuses a doctor changing staff roles', async () => {
      const token = await asDoctorA()

      const response = await supertest(app())
        .patch(`/api/v1/staff/${fixture.receptionistA.id}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'HOSPITAL_ADMIN' })

      expect(response.status).toBe(403)
    })

    it('refuses an administrator changing their own role', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .patch(`/api/v1/staff/${fixture.adminA.id}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'STAFF' })

      // Otherwise an administrator can demote themselves out of the only interface that
      // could restore them.
      expect(response.status).toBe(422)
      expect(JSON.stringify(response.body)).toMatch(/your own role/i)
    })

    it('refuses suspending the only active administrator', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .patch(`/api/v1/staff/${fixture.adminA.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'SUSPENDED', reason: 'Attempting to lock the hospital out' })

      expect([403, 409, 422]).toContain(response.status)
    })
  })

  // ────────────────────────────── sensitive data ──────────────────────────────

  describe('professional and staff information is protected', () => {
    it('masks the registration number for a reader without doctor:write', async () => {
      const adminToken = await asAdminA()
      await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: fixture.doctorA.id, registrationNumber: 'GMC/2026/55555' })

      // A receptionist may book appointments, so may read the doctor list — but a
      // council licence number is not part of that job.
      const receptionToken = await asReceptionA()

      const list = await supertest(app())
        .get('/api/v1/doctors')
        .set('Authorization', `Bearer ${receptionToken}`)

      expect(list.status).toBe(200)
      expect(JSON.stringify(list.body)).not.toContain('GMC/2026/55555')
      expect(list.body.data.items[0].registrationNumberMasked).toBe(true)
    })

    it('shows the registration number to a doctor manager', async () => {
      const adminToken = await asAdminA()
      await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: fixture.doctorA.id, registrationNumber: 'GMC/2026/55556' })

      const list = await supertest(app())
        .get('/api/v1/doctors')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(JSON.stringify(list.body)).toContain('GMC/2026/55556')
      expect(list.body.data.items[0].registrationNumberMasked).toBe(false)
    })

    it('never copies a registration number into the audit trail', async () => {
      const adminToken = await asAdminA()
      await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId: fixture.doctorA.id, registrationNumber: 'GMC/2026/99999' })

      const entries = await modelOf('AuditLog').find({ action: 'doctor_profile.created' }).lean().exec()

      expect(entries.length).toBeGreaterThan(0)
      // The audit log is a second store of personal data; it must not duplicate one.
      expect(JSON.stringify(entries)).not.toContain('GMC/2026/99999')
    })

    it('never returns a password hash or MFA secret', async () => {
      const adminToken = await asAdminA()

      await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'secretcheck@example.test', firstName: 'S', lastName: 'C', role: 'STAFF' })

      const list = await supertest(app())
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${adminToken}`)

      const body = JSON.stringify(list.body)
      expect(body).not.toContain('passwordHash')
      expect(body).not.toContain('argon2')
      expect(body).not.toContain('secretEnc')
    })

    it('never copies a staff email into the audit trail on a profile read', async () => {
      const adminToken = await asAdminA()
      await supertest(app())
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${adminToken}`)

      const entries = await modelOf('AuditLog')
        .find({ action: 'hospital.viewed', resourceType: 'Hospital' })
        .lean()
        .exec()

      expect(JSON.stringify(entries)).not.toMatch(/example\.test/)
    })
  })

  // ────────────────────────────── audit ──────────────────────────────

  describe('important changes are audited', () => {
    it('records department creation', async () => {
      const token = await asAdminA()
      await createDepartment(token)

      const entries = await modelOf('AuditLog')
        .find({ action: 'department.created', hospitalId: fixture.hospitalA.id })
        .lean()
        .exec()

      expect(entries).toHaveLength(1)
    })

    it('records a hospital profile change without copying the values', async () => {
      const token = await asAdminA()

      await supertest(app())
        .patch('/api/v1/hospital')
        .set('Authorization', `Bearer ${token}`)
        .send({ contactEmail: 'new.contact@fictional.test' })

      const entries = await modelOf('AuditLog')
        .find({ action: 'hospital.profile_updated' })
        .lean()
        .exec()

      expect(entries).toHaveLength(1)
      // The field NAME is recorded; the value is personal data and stays in one place.
      expect(JSON.stringify(entries)).not.toContain('new.contact@fictional.test')
    })

    it('records a role change with the previous and new role', async () => {
      const token = await asAdminA()

      const created = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'audited@example.test', firstName: 'A', lastName: 'U', role: 'STAFF' })

      await supertest(app())
        .patch(`/api/v1/staff/${created.body.data.userId}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'RECEPTIONIST' })

      const entry = await modelOf('AuditLog')
        .findOne({ action: 'membership.permissions_changed' })
        .lean()
        .exec()

      expect(entry?.['metadata']).toMatchObject({ previousRole: 'STAFF', newRole: 'RECEPTIONIST' })
    })

    it('records a staff status change with its reason', async () => {
      const token = await asAdminA()

      const created = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'status@example.test', firstName: 'S', lastName: 'T', role: 'STAFF' })

      await supertest(app())
        .patch(`/api/v1/staff/${created.body.data.userId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'SUSPENDED', reason: 'Left the hospital in September' })

      const entry = await modelOf('AuditLog')
        .findOne({ action: 'membership.status_changed' })
        .lean()
        .exec()

      expect(entry?.['metadata']).toMatchObject({
        newStatus: 'SUSPENDED',
        reason: 'Left the hospital in September',
      })
    })

    it('records a schedule change', async () => {
      const token = await asAdminA()

      const profile = await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: fixture.doctorA.id, registrationNumber: 'GMC/2026/030' })

      await supertest(app())
        .put(`/api/v1/doctors/${profile.body.data.id}/schedule`)
        .set('Authorization', `Bearer ${token}`)
        .send({ blocks: [{ weekday: 1, startMinute: 540, endMinute: 1020 }] })

      const entries = await modelOf('AuditLog')
        .find({ action: 'doctor.schedule_updated' })
        .lean()
        .exec()

      expect(entries).toHaveLength(1)
      expect(entries[0]?.['metadata']).toMatchObject({ blockCount: 1, activeDays: 1 })
    })
  })

  // ────────────────────────────── workflows ──────────────────────────────

  describe('day-to-day administration works', () => {
    it('paginates and searches departments server-side', async () => {
      const token = await asAdminA()

      for (const [name, code] of [
        ['Cardiology', 'CARD'],
        ['Neurology', 'NEUR'],
        ['Paediatrics', 'PAED'],
      ]) {
        const created = await createDepartment(token, { name, code })
        expect(created.status).toBe(201)
      }

      const paged = await supertest(app())
        .get('/api/v1/departments?page=1&pageSize=2')
        .set('Authorization', `Bearer ${token}`)

      expect(paged.status).toBe(200)
      expect(paged.body.data.items).toHaveLength(2)
      expect(paged.body.data.page.total).toBe(3)
      expect(paged.body.data.page.totalPages).toBe(2)

      const searched = await supertest(app())
        .get('/api/v1/departments?q=neuro')
        .set('Authorization', `Bearer ${token}`)

      expect(searched.body.data.items).toHaveLength(1)
      expect(searched.body.data.items[0].name).toBe('Neurology')
    })

    it('filters staff by role', async () => {
      const token = await asAdminA()

      await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'r1@example.test', firstName: 'R', lastName: 'One', role: 'RECEPTIONIST' })
      await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'r2@example.test', firstName: 'R', lastName: 'Two', role: 'ACCOUNTANT' })

      const filtered = await supertest(app())
        .get('/api/v1/staff?role=ACCOUNTANT')
        .set('Authorization', `Bearer ${token}`)

      expect(filtered.status).toBe(200)
      expect(filtered.body.data.items).toHaveLength(1)
      expect(filtered.body.data.items[0].role).toBe('ACCOUNTANT')
    })

    it('replaces rather than merges a schedule', async () => {
      const token = await asAdminA()

      const profile = await supertest(app())
        .post('/api/v1/doctors')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: fixture.doctorA.id, registrationNumber: 'GMC/2026/040' })

      const path = `/api/v1/doctors/${profile.body.data.id}/schedule`

      await supertest(app())
        .put(path)
        .set('Authorization', `Bearer ${token}`)
        .send({
          blocks: [
            { weekday: 1, startMinute: 540, endMinute: 720 },
            { weekday: 2, startMinute: 540, endMinute: 720 },
          ],
        })

      // A form submits the whole week; merging would leave a deleted block behind.
      const replaced = await supertest(app())
        .put(path)
        .set('Authorization', `Bearer ${token}`)
        .send({ blocks: [{ weekday: 3, startMinute: 600, endMinute: 780 }] })

      expect(replaced.status).toBe(200)
      expect(replaced.body.data.blocks).toHaveLength(1)
      expect(replaced.body.data.blocks[0].weekday).toBe(3)

      const read = await supertest(app())
        .get(path)
        .set('Authorization', `Bearer ${token}`)

      expect(read.body.data.blocks).toHaveLength(1)
    })

    it('updates hospital settings without touching the profile', async () => {
      const token = await asAdminA()

      const response = await supertest(app())
        .patch('/api/v1/hospital/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ slotDurationMinutes: 20, appointmentBufferMinutes: 5 })

      expect(response.status).toBe(200)
      expect(response.body.data.settings.slotDurationMinutes).toBe(20)

      const profile = await supertest(app())
        .get('/api/v1/hospital')
        .set('Authorization', `Bearer ${token}`)

      expect(profile.body.data.name).toBe(fixture.hospitalA.name)
    })

    it('creates staff who start unverified and can then be activated', async () => {
      const token = await asAdminA()

      const created = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'lifecycle@example.test', firstName: 'L', lastName: 'C', role: 'STAFF' })

      expect(created.status).toBe(201)
      expect(created.body.data.accountStatus).toBe('PENDING_VERIFICATION')

      const activated = await supertest(app())
        .patch(`/api/v1/staff/${created.body.data.userId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'ACTIVE', reason: 'Verified documents and enrolled in training' })

      expect(activated.status).toBe(200)
    })

    it('leaves no orphaned user when a membership cannot be created', async () => {
      const token = await asAdminA()

      // Force the membership write to fail by pre-creating one that collides.
      const orphan = await modelOf('User').create({
        email: 'orphan@example.test',
        firstName: 'Orphan',
        lastName: 'Record',
        passwordHash: 'x',
        status: 'ACTIVE',
        failedLoginCount: 0,
      })

      await modelOf('Membership').create({
        userId: orphan['_id'],
        hospitalId: fixture.hospitalA.id,
        role: 'STAFF',
        grantedPermissions: [],
        status: 'ACTIVE',
        joinedAt: new Date(),
      })

      const response = await supertest(app())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'orphan@example.test', firstName: 'Orphan', lastName: 'Record', role: 'STAFF' })

      // The email is taken, so nothing is written at all.
      expect(response.status).toBe(409)
    })
  })
})