import { generateKeyPairSync } from 'node:crypto'
import type { Express } from 'express'
import mongoose, { type Model } from 'mongoose'

import { createApp } from '../app.js'
import { connectToDatabase } from '../infrastructure/db/connection.js'
import { hashPassword } from '../modules/identity/password.util.js'
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
  return String(hospital['_id'])
}

async function createMembership(input: {
  userId: string
  hospitalId: string
  role: string
}): Promise<string> {
  const membership = await (MembershipModel as Model<Record<string, unknown>>).create({
    userId: input.userId,
    hospitalId: input.hospitalId,
    role: input.role,
    grantedPermissions: [],
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

export async function connectTestDatabase(uri: string): Promise<void> {
  await connectToDatabase(uri, 'infinigrow_auth_test')
}

export { mongoose }
