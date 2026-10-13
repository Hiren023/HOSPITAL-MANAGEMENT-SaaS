import { generateKeyPairSync } from 'node:crypto'
import type { Express } from 'express'
import supertest from 'supertest'
import mongoose, { Types, type Model } from 'mongoose'

import { createApp } from '../app.js'
import { connectToDatabase } from '../infrastructure/db/connection.js'
import { ensureIndexes } from '../infrastructure/db/indexes.js'
import { withPlatformScope } from '../infrastructure/db/tenant-plugin.js'
import { hashPassword } from '../modules/identity/password.util.js'
import { SubscriptionModel } from '../modules/subscriptions/subscription.models.js'
import {
  HospitalModel,
  MembershipModel,
  RefreshSessionModel,
  UserModel,
} from '../modules/identity/models.js'
import * as auditModelModule from '../modules/audit/audit.model.js'

/**
 * Auth + tenant-isolation test harness.
 *
 * Creates TWO fictional hospitals, each with its own administrator, plus a platform
 * SUPER_ADMIN. Every fixture value is invented: no real person, hospital or patient
 * data appears anywhere in this suite.
 *
 *   Hospital A  "Aarav Memorial Hospital"     admin-a@example.test
 *   Hospital B  "Bhavna Community Hospital"   admin-b@example.test
 *
 * The password is shared so a test can sign in as either admin without special-casing.
 */

export const TEST_PASSWORD = 'correct-horse-battery-staple'

export const HOSPITAL_A_NAME = 'Aarav Memorial Hospital'
export const HOSPITAL_B_NAME = 'Bhavna Community Hospital'

export interface Fixture {
  app: Express
  hospitalA: { id: string; name: string }
  hospitalB: { id: string; name: string }
  adminA: { id: string; email: string }
  adminB: { id: string; email: string }
  doctorA: { id: string; email: string }
  receptionistA: { id: string; email: string }
  superAdmin: { id: string; email: string }
}

/**
 * Generate an Ed25519 key pair and install it in the environment.
 *
 * `authenticate` calls `keysFromEnv(process.env)` per request, so the keys must be
 * present before any protected route is exercised.
 */
export function installTestJwtKeys(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })

  process.env['JWT_PRIVATE_KEY'] = privateKey as unknown as string
  process.env['JWT_PUBLIC_KEY'] = publicKey as unknown as string
  process.env['JWT_ISSUER'] = 'https://api.test.invalid'
  process.env['JWT_AUDIENCE'] = 'infinigrow-test'

  return {
    privateKeyPem: privateKey as unknown as string,
    publicKeyPem: publicKey as unknown as string,
  }
}

async function createUser(input: {
  email: string
  firstName: string
  lastName: string
  status?: string
  emailVerified?: boolean
}): Promise<string> {
  const user = await (UserModel as Model<Record<string, unknown>>).create({
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    passwordHash: await hashPassword(TEST_PASSWORD),
    status: input.status ?? 'ACTIVE',
    emailVerified: input.emailVerified ?? true,
    failedLoginCount: 0,
  })

  return String(user['_id'])
}

async function createHospital(name: string, slug: string): Promise<string> {
  const hospital = await (HospitalModel as Model<Record<string, unknown>>).create({
    name,
    slug,
    status: 'APPROVED',
    contactEmail: `contact@${slug}.example.test`,
  })

  const hospitalId = String(hospital['_id'])

  // ── Every approved hospital has a subscription ─────────────────────────────────
  //
  // This mirrors what `approveHospital` does in production. Without it every tenant
  // route is refused: the entitlement gate fails closed when there is no subscription
  // row, which is the correct behaviour and is asserted directly in
  // `phase9-subscriptions.test.ts`.
  //
  // Seeding it here rather than in each test file is deliberate. Eight suites were
  // individually failing with "subscription has expired" before this existed, and the
  // error names a subscription — so a reader debugging it would go looking at billing
  // rather than at the fixture. The fixture should look like production.
  await withPlatformScope(async () => {
    await (SubscriptionModel as Model<Record<string, unknown>>).create({
      hospitalId: new Types.ObjectId(hospitalId),
      plan: 'HOSPITAL',
      status: 'ACTIVE',
      currentPeriodStartsAt: new Date(),
      currentPeriodEndsAt: new Date(Date.now() + 30 * 86_400_000),
      paymentState: 'NONE',
      history: [],
    })
  })

  return hospitalId
}

async function createMembership(input: {
  userId: string
  hospitalId: string
  role: string
  /**
   * An explicit narrowing of the role's ceiling.
   *
   * Empty by default, which is the normal case: a membership with no explicit grants gets
   * its role's full ceiling. Supplying this is how a test creates a user who deliberately
   * holds LESS than their role normally would — someone who can read a patient list but
   * not edit one. The server caps any grant at the role's ceiling, so a test cannot
   * accidentally mint a super-privileged membership here.
   */
  grantedPermissions?: string[]
}): Promise<string> {
  const membership = await (MembershipModel as Model<Record<string, unknown>>).create({
    userId: input.userId,
    hospitalId: input.hospitalId,
    role: input.role,
    grantedPermissions: input.grantedPermissions ?? [],
    status: 'ACTIVE',
    joinedAt: new Date(),
  })
  return String(membership['_id'])
}

/**
 * Seed two hospitals, their staff, and a platform administrator.
 *
 * Note the SUPER_ADMIN has NO membership in either hospital — that is what gives it a
 * PlatformContext with no tenant scope.
 */
export async function seedFixtures(): Promise<Fixture> {
  const hospitalAId = await createHospital(HOSPITAL_A_NAME, 'aarav-memorial')
  const hospitalBId = await createHospital(HOSPITAL_B_NAME, 'bhavna-community')

  const adminAId = await createUser({
    email: 'admin-a@example.test',
    firstName: 'Aditi',
    lastName: 'Sharma',
  })
  const adminBId = await createUser({
    email: 'admin-b@example.test',
    firstName: 'Bhavna',
    lastName: 'Rao',
  })
  const doctorAId = await createUser({
    email: 'doctor-a@example.test',
    firstName: 'Dev',
    lastName: 'Menon',
  })
  const receptionistAId = await createUser({
    email: 'reception-a@example.test',
    firstName: 'Kavya',
    lastName: 'Iyer',
  })
  const superAdminId = await createUser({
    email: 'platform-admin@example.test',
    firstName: 'Platform',
    lastName: 'Operator',
  })

  await createMembership({ userId: adminAId, hospitalId: hospitalAId, role: 'HOSPITAL_ADMIN' })
  await createMembership({ userId: adminBId, hospitalId: hospitalBId, role: 'HOSPITAL_ADMIN' })
  await createMembership({ userId: doctorAId, hospitalId: hospitalAId, role: 'DOCTOR' })
  await createMembership({
    userId: receptionistAId,
    hospitalId: hospitalAId,
    role: 'RECEPTIONIST',
  })

  // SUPER_ADMIN is a platform role with no hospital membership, by design.

  return {
    app: createApp(),
    hospitalA: { id: hospitalAId, name: HOSPITAL_A_NAME },
    hospitalB: { id: hospitalBId, name: HOSPITAL_B_NAME },
    adminA: { id: adminAId, email: 'admin-a@example.test' },
    adminB: { id: adminBId, email: 'admin-b@example.test' },
    doctorA: { id: doctorAId, email: 'doctor-a@example.test' },
    receptionistA: { id: receptionistAId, email: 'reception-a@example.test' },
    superAdmin: { id: superAdminId, email: 'platform-admin@example.test' },
  }
}

/**
 * Typed model accessor for tests.
 *
 * The models are exported untyped (`Model<Record<string, unknown>>`) because they are
 * registered conditionally at import time. This wrapper gives tests a real query
 * builder, so they read as `modelOf('User').findOne({...}).lean().exec()` instead of
 * needing a chain of casts.
 */
export function modelOf<TRaw extends Record<string, unknown> = Record<string, unknown>>(
  name: 'User' | 'Membership' | 'AuditLog' | 'Hospital' | 'RefreshSession',
): Model<TRaw> {
  switch (name) {
    case 'User':
      return UserModel as Model<TRaw>
    case 'Membership':
      return MembershipModel as Model<TRaw>
    case 'AuditLog':
      return auditModelModule.AuditLogModel as Model<TRaw>
    case 'Hospital':
      return HospitalModel as Model<TRaw>
    case 'RefreshSession':
      return RefreshSessionModel as Model<TRaw>
    default:
      throw new Error(`Unknown model: ${name}`)
  }
}

/** Remove every document, keeping the connection alive. */
export async function resetDatabase(): Promise<void> {
  const collections = await mongoose.connection.db?.collections()
  await Promise.all((collections ?? []).map((collection) => collection.deleteMany({})))
}

/**
 * Connect, then build the indexes.
 *
 * `autoIndex` defaults to false because index creation is meant to be an explicit,
 * verifiable step — but no migration runner exists yet, so without this the database has
 * only its `_id` index. Every UNIQUE constraint declared in a schema would be absent, and
 * anything relying on one would pass its tests while being unenforceable in practice.
 *
 * That is not hypothetical. The duplicate-booking tests were returning 201 for two
 * simultaneous requests to the same slot, because the unique index they depend on did not
 * exist. `syncIndexes` builds exactly what the schemas declare, so these tests exercise
 * the real constraints instead of a fiction of them.
 */
export async function connectTestDatabase(uri: string): Promise<void> {
  await connectToDatabase(uri, 'infinigrow_auth_test')
  await ensureIndexes()
}

export { mongoose }

// ───────────────────────── platform console fixtures (Phase 4) ─────────────────────────

export interface PlatformFixture extends Fixture {
  /** Signs in as the SUPER_ADMIN and returns its bearer token. */
  platformToken: () => Promise<string>
  /** Signs in as any seeded user and returns its bearer token. */
  signIn: (email: string, password?: string) => Promise<string>
  password: string
}

/**
 * Builds a platform-console fixture: the two seeded hospitals, a SUPER_ADMIN, and the
 * sign-in helpers the console tests need.
 *
 * The SUPER_ADMIN is created with `platformRole: 'SUPER_ADMIN'` — the flag `login` reads
 * to recognise a platform operator. It exists precisely because a SUPER_ADMIN has no
 * hospital membership, so sign-in cannot resolve it through a membership the way every
 * other role does.
 */
export async function createPlatformFixture(): Promise<PlatformFixture> {
  const base = await seedFixtures()

  await (UserModel as Model<Record<string, unknown>>)
    .updateOne({ email: base.superAdmin.email }, { $set: { platformRole: 'SUPER_ADMIN' } })
    .exec()

  const signIn = async (email: string, password = TEST_PASSWORD): Promise<string> => {
    const response = await supertest(base.app).post('/api/v1/auth/login').send({ email, password })

    if (response.status !== 200) {
      throw new Error(
        `Fixture sign-in failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`,
      )
    }

    return String(response.body.data.accessToken)
  }

  return {
    ...base,
    password: TEST_PASSWORD,
    signIn,
    platformToken: () => signIn(base.superAdmin.email),
  }
}

/**
 * Adds extra tenants so pagination and status filters have something to work with.
 *
 * All fictional. The names are chosen to be searchable and distinguishable so a
 * server-side search test can assert on a real result rather than "at least one row".
 */
export async function seedPlatformData(): Promise<{ id: string; name: string }[]> {
  const seeds: ReadonlyArray<readonly [string, string, string]> = [
    ['Charak Diagnostics Centre', 'charak-diagnostics', 'APPROVED'],
    ['Dhanvantari Multispeciality', 'dhanvantari-multi', 'PENDING'],
    ['Gangotri Health Institute', 'gangotri-health', 'APPROVED'],
    ['Himalayan Care Hospital', 'himalayan-care', 'SUSPENDED'],
  ]

  const created: { id: string; name: string }[] = []

  for (const [name, slug, status] of seeds) {
    const hospital = await (HospitalModel as Model<Record<string, unknown>>).create({
      name,
      slug,
      status,
      plan: 'STARTER',
      contactEmail: `contact@${slug}.example.test`,
    })
    created.push({ id: String(hospital['_id']), name })
  }

  return created
}
