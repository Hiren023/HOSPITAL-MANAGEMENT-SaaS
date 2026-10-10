import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { registerHospital, approveHospital } from '../modules/auth/registration.service.js'
import { ApiError } from '../infrastructure/api-error.js'
import { HospitalModel, MembershipModel, UserModel } from '../modules/identity/models.js'
import { AuditLogModel } from '../modules/audit/audit.model.js'
import { connectTestDatabase, resetDatabase } from './auth-harness.js'
import { tryStartTestDatabase } from './mongo.js'

/**
 * Hospital registration and approval.
 *
 * The safe-creation properties are what matter here: a new tenant must be unusable
 * until approved, and the administrator's role must come from the server rather than
 * from the request.
 */

const db = await tryStartTestDatabase()

const meta = { ip: '127.0.0.1', requestId: 'req-registration-test' }
const PASSWORD = 'correct-horse-battery-staple'

interface RegistrationBody {
  hospitalName: string
  registrationNumber?: string
  contactEmail: string
  admin: {
    firstName: string
    lastName: string
    email: string
    password: string
    phone?: string
  }
}

function registration(overrides: Partial<RegistrationBody> = {}) {
  return {
    hospitalName: 'Kaveri Diagnostics Centre',
    registrationNumber: 'KA/2026/1234',
    contactEmail: 'contact@kaveri.example.test',
    admin: {
      firstName: 'Meera',
      lastName: 'Nair',
      email: 'meera.nair@example.test',
      password: PASSWORD,
    },
    ...overrides,
  } as RegistrationBody
}

describe.skipIf(!db.uri)('hospital registration', () => {
  beforeAll(async () => {
    await connectTestDatabase(db.uri as string)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
  })

  it('creates the hospital in PENDING status', async () => {
    const result = await registerHospital(registration(), meta)

    expect(result.hospitalStatus).toBe('PENDING')

    const hospital = await (HospitalModel as never as {
      findById: (id: string) => { lean: () => { exec: () => Promise<Record<string, unknown> | null> } }
    }).findById(result.hospitalId).lean().exec()

    expect(hospital?.['status']).toBe('PENDING')
    expect(hospital?.['approvedAt']).toBeFalsy()
  })

  it('assigns the administrator role server-side', async () => {
    const result = await registerHospital(registration(), meta)

    const membership = await (MembershipModel as never as {
      findOne: (input: unknown) => { lean: () => { exec: () => Promise<Record<string, unknown> | null> } }
    }).findOne({ hospitalId: result.hospitalId }).lean().exec()

    expect(membership?.['role']).toBe('HOSPITAL_ADMIN')
    expect(membership?.['status']).toBe('ACTIVE')
  })

  it('creates the administrator with a PENDING_VERIFICATION status', async () => {
    const result = await registerHospital(registration(), meta)

    const user = await (UserModel as never as {
      findById: (id: string) => { lean: () => { exec: () => Promise<Record<string, unknown> | null> } }
    }).findById(result.adminUserId).lean().exec()

    expect(user?.['status']).toBe('PENDING_VERIFICATION')
    expect(user?.['emailVerified']).toBe(false)
  })

  it('never stores the plaintext password', async () => {
    const result = await registerHospital(registration(), meta)

    const user = await (UserModel as never as {
      findById: (id: string) => { select: (v: string) => { lean: () => { exec: () => Promise<Record<string, unknown> | null> } } }
    }).findById(result.adminUserId).select('+passwordHash').lean().exec()

    const stored = String(user?.['passwordHash'] ?? '')
    expect(stored).toMatch(/^\$argon2id\$/)
    expect(stored).not.toContain(PASSWORD)
  })

  it('derives a URL-safe slug from the hospital name', async () => {
    const result = await registerHospital(
      registration({ hospitalName: 'Sankara Multi Speciality Hospital!' }),
      meta,
    )

    expect(result.hospitalSlug).toBe('sankara-multi-speciality-hospital')
  })

  it('allocates a distinct slug when the base name collides', async () => {
    // Must not silently reuse an existing slug: an attacker registering a look-alike
    // must not receive the identity of another tenant.
    await registerHospital(registration({ hospitalName: 'Kaveri Diagnostics Centre' }), meta)
    const second = await registerHospital(
      registration({
        hospitalName: 'Kaveri Diagnostics Centre',
        admin: { ...registration().admin, email: 'second.admin@example.test' },
      }),
      meta,
    )

    expect(second.hospitalSlug).not.toBe('kaveri-diagnostics-centre')
    expect(second.hospitalSlug).toMatch(/^kaveri-diagnostics-centre-[0-9a-f]{6}$/)
  })

  it('handles a name that slugifies to nothing', async () => {
    const result = await registerHospital(
      registration({
        hospitalName: '!!!',
        admin: { ...registration().admin, email: 'symbols@example.test' },
      }),
      meta,
    )

    expect(result.hospitalSlug).toBeTruthy()
  })

  it('refuses a duplicate administrator email', async () => {
    await registerHospital(registration(), meta)

    await expect(
      registerHospital(
        registration({
          hospitalName: 'Another Hospital',
          admin: { ...registration().admin, email: 'meera.nair@example.test' },
        }),
        meta,
      ),
    ).rejects.toBeInstanceOf(ApiError)
  })

  it('records an audit entry without the password', async () => {
    await registerHospital(registration(), meta)

    const entries = await (AuditLogModel as never as {
      find: (input: unknown) => { lean: () => { exec: () => Promise<Record<string, unknown>[]> } }
    }).find({ action: 'hospital.registered' }).lean().exec()

    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries)).not.toContain(PASSWORD)
    // Field NAMES only, never submitted values.
    expect(entries[0]?.['metadata']).toMatchObject({ hospitalName: 'Kaveri Diagnostics Centre' })
  })

  it('records a membership-created audit entry', async () => {
    await registerHospital(registration(), meta)

    const entries = await (AuditLogModel as never as {
      find: (input: unknown) => { lean: () => { exec: () => Promise<Record<string, unknown>[]> } }
    }).find({ action: 'membership.created' }).lean().exec()

    expect(entries).toHaveLength(1)
  })
})

describe.skipIf(!db.uri)('hospital approval', () => {
  beforeAll(async () => {
    await connectTestDatabase(db.uri as string)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  afterAll(async () => {
  })

  it('flips the tenant to APPROVED and records who approved it', async () => {
    const { hospitalId } = await registerHospital(registration(), meta)

    const result = await approveHospital({
      hospitalId,
      actor: { userId: new (await import('mongoose')).Types.ObjectId().toString(), role: 'SUPER_ADMIN' },
      meta,
    })

    expect(result.status).toBe('APPROVED')

    const hospital = await (HospitalModel as never as {
      findById: (id: string) => { lean: () => { exec: () => Promise<Record<string, unknown> | null> } }
    }).findById(hospitalId).lean().exec()

    expect(hospital?.['status']).toBe('APPROVED')
    expect(hospital?.['approvedAt']).toBeTruthy()
  })

  it('activates the owner account so they can sign in', async () => {
    const { hospitalId, adminUserId } = await registerHospital(registration(), meta)

    await approveHospital({
      hospitalId,
      actor: { userId: '507f1f77bcf86cd799439011', role: 'SUPER_ADMIN' },
      meta,
    })

    const user = await (UserModel as never as {
      findById: (id: string) => { lean: () => { exec: () => Promise<Record<string, unknown> | null> } }
    }).findById(adminUserId).lean().exec()

    expect(user?.['status']).toBe('ACTIVE')
  })

  it('the approval ROUTE activates the owner, not just the tenant', async () => {
    // Regression guard: the route once repeated the status update inline and never
    // activated the owner, so an approved hospital's administrator received 403 at
    // sign-in. The route must delegate to the same service the tests cover.
    const { hospitalId } = await registerHospital(registration(), meta)

    await approveHospital({
      hospitalId,
      actor: { userId: '507f1f77bcf86cd799439011', role: 'SUPER_ADMIN' },
      meta,
    })

    const owner = await (MembershipModel as never as {
      findOne: (input: unknown) => { lean: () => { exec: () => Promise<Record<string, unknown> | null> } }
    }).findOne({ hospitalId, role: 'HOSPITAL_ADMIN' }).lean().exec()

    const user = await (UserModel as never as {
      findById: (id: string) => { lean: () => { exec: () => Promise<Record<string, unknown> | null> } }
    }).findById(String(owner?.['userId'])).lean().exec()

    expect(user?.['status']).toBe('ACTIVE')
  })

  it('returns 404 for an unknown hospital', async () => {
    await expect(
      approveHospital({
        hospitalId: '507f1f77bcf86cd799439099',
        actor: { userId: '507f1f77bcf86cd799439011', role: 'SUPER_ADMIN' },
        meta,
      }),
    ).rejects.toThrow(/Resource not found/)
  })

  it('records an approval audit entry', async () => {
    const { hospitalId } = await registerHospital(registration(), meta)

    await approveHospital({
      hospitalId,
      actor: { userId: '507f1f77bcf86cd799439011', role: 'SUPER_ADMIN' },
      meta,
    })

    const entries = await (AuditLogModel as never as {
      find: (input: unknown) => { lean: () => { exec: () => Promise<Record<string, unknown>[]> } }
    }).find({ action: 'hospital.approved' }).lean().exec()

    expect(entries).toHaveLength(1)
    // Stored as an ObjectId, so compare on its string form.
    expect(String(entries[0]?.['hospitalId'])).toBe(hospitalId)
  })
})