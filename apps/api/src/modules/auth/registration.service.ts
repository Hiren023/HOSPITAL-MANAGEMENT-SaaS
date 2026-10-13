import { Types, type Model } from 'mongoose'
import { DEFAULT_PLAN } from '@infinigrow/shared'

import { ApiError } from '../../infrastructure/api-error.js'
import { hashPassword } from '../identity/password.util.js'
import { HospitalModel, MembershipModel, UserModel } from '../identity/models.js'
import { AUDIT_ACTIONS } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'
import { newFamilyId } from '../identity/token.util.js'
import type { HospitalRegistrationInput } from './auth.schemas.js'

/**
 * Hospital (tenant) registration.
 *
 * SAFE TENANT-CREATION WORKFLOW — the important properties:
 *
 *  1. **A new tenant starts PENDING.** It cannot be used until a `SUPER_ADMIN`
 *     approves it. Registration alone grants no access to any clinical data.
 *  2. **The administrator is created with the role the schema assigns**, never from
 *     the request. `hospital_admin` is hard-coded here, so a client cannot smuggle
 *     `role: 'SUPER_ADMIN'` in the payload (which `.strict()` would also reject).
 *  3. **The creator gets a scoped membership**, so the tenant context is derived from
 *     a real membership rather than from anything the client asserted.
 *  4. **A hospital's administrator is global-first**: the `User` may already exist
 *     (a consultant at two hospitals); only the membership is new.
 *  5. **Slug collisions are rejected, not silently suffixed** — an attacker must not
 *     be able to register `aarav-memorial` and receive traffic meant for another
 *     tenant.
 */

export interface RegistrationResult {
  hospitalId: string
  hospitalSlug: string
  hospitalStatus: 'PENDING'
  adminUserId: string
  adminEmail: string
  emailVerificationRequired: true
}

/** Lowercase, URL-safe, human-readable identifier. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

function uniqueSlug(base: string): Promise<string> {
  // Appends a short suffix only on collision. The base is preserved where possible so
  // the URL stays recognisable.
  return (async () => {
    const Model = HospitalModel as Model<Record<string, unknown>>
    const candidate = base || 'hospital'

    const existing = await Model.findOne({ slug: candidate }).lean().exec()
    if (!existing) return candidate

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const suffix = newFamilyId().slice(0, 6)
      const attemptSlug = `${candidate}-${suffix}`
      const clash = await Model.findOne({ slug: attemptSlug }).lean().exec()
      if (!clash) return attemptSlug
    }

    throw ApiError.conflict('Could not allocate a unique hospital identifier. Please try again.')
  })()
}

export async function registerHospital(
  input: HospitalRegistrationInput,
  meta: { ip: string; requestId: string },
): Promise<RegistrationResult> {
  const User = UserModel as Model<Record<string, unknown>>
  const Memberships = MembershipModel as Model<Record<string, unknown>>
  const Hospitals = HospitalModel as Model<Record<string, unknown>>

  const adminEmail = input.admin.email.trim().toLowerCase()

  const existingUser = await User.findOne({ email: adminEmail }).lean().exec()
  if (existingUser) {
    // Deliberately vague: reveals nothing about which emails are registered.
    throw ApiError.conflict('An account already exists for this email address')
  }

  const slug = await uniqueSlug(slugify(input.hospitalName))

  const hospital = await Hospitals.create({
    name: input.hospitalName,
    slug,
    registrationNumber: input.registrationNumber,
    contactEmail: input.contactEmail,
    contactPhone: input.contactPhone,
    address: input.address,
    // A tenant is unusable until explicitly approved.
    status: 'PENDING',
  })

  const hospitalId = String(hospital['_id'])

  const user = await User.create({
    email: adminEmail,
    phone: input.admin.phone,
    firstName: input.admin.firstName,
    lastName: input.admin.lastName,
    passwordHash: await hashPassword(input.admin.password),
    status: 'PENDING_VERIFICATION',
    emailVerified: false,
    failedLoginCount: 0,
  })

  const adminUserId = String(user['_id'])

  const membership = await Memberships.create({
    userId: adminUserId,
    hospitalId,
    // Hard-coded. Never read from the request.
    role: 'HOSPITAL_ADMIN',
    grantedPermissions: [],
    status: 'ACTIVE',
    joinedAt: new Date(),
  })

  await recordAudit({
    action: AUDIT_ACTIONS.HOSPITAL_REGISTERED,
    actorUserId: adminUserId,
    actorRole: 'HOSPITAL_ADMIN',
    hospitalId,
    resourceType: 'Hospital',
    resourceId: hospitalId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: {
      hospitalName: input.hospitalName,
      slug,
      // Field NAMES only — never the submitted values.
      fieldsProvided: Object.keys(input).filter((key) => key !== 'admin'),
    },
  })

  await recordAudit({
    action: AUDIT_ACTIONS.MEMBERSHIP_CREATED,
    actorUserId: adminUserId,
    actorRole: 'HOSPITAL_ADMIN',
    hospitalId,
    resourceType: 'Membership',
    resourceId: String(membership['_id']),
    ip: meta.ip,
    requestId: meta.requestId,
  })

  return {
    hospitalId,
    hospitalSlug: slug,
    hospitalStatus: 'PENDING',
    adminUserId,
    adminEmail,
    emailVerificationRequired: true,
  }
}

/** Approve a pending tenant. Platform-level operation, audited. */
export async function approveHospital(input: {
  hospitalId: string
  actor: { userId: string; role: string }
  meta: { ip: string; requestId: string }
}): Promise<{ hospitalId: string; status: string }> {
  const { withPlatformScope } = await import('../../infrastructure/db/tenant-plugin.js')

  const updated = await withPlatformScope(() =>
    (HospitalModel as Model<Record<string, unknown>>)
      .findByIdAndUpdate(
        input.hospitalId,
        {
          $set: {
            status: 'APPROVED',
            approvedAt: new Date(),
            approvedBy: input.actor.userId,
          },
        },
        // `returnDocument: 'after'` rather than the deprecated `{ new: true }`, which
        // Mongoose 9 warns about and a future major will remove.
        { returnDocument: 'after' },
      )
      .lean()
      .exec(),
  )

  if (!updated) throw ApiError.notFound()

  // Provision the subscription.
  //
  // Without this an approved hospital is immediately locked out of its own patients,
  // staff and appointments: every tenant route sits behind a plan entitlement that fails
  // closed, and there is no subscription row to satisfy it. A hospital that registers,
  // is approved, and then cannot add a single patient is not a pricing decision — it is a
  // broken product.
  //
  // The row is created on the default plan with a trial where the plan has one. It is
  // deliberately NOT created at registration time: a `PENDING` hospital has nobody who
  // could sign in to be confused by it, and creating a subscription for a tenant that
  // may never be approved leaves a billing record for a customer who never existed.
  //
  // The operator can change the plan from the platform console afterwards. What this
  // guarantees is only that an approved hospital has somewhere to start.
  const { assignPlan } = await import('../subscriptions/subscription.service.js')
  await assignPlan(
    { userId: input.actor.userId, role: input.actor.role, hospitalId: '', permissions: [] },
    {
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
    },
    input.hospitalId,
    {
      plan: DEFAULT_PLAN,
      startTrial: true,
      reason: 'Provisioned on approval',
    },
  )

  // Activate the owner's account so they can sign in.
  //
  // This updates one user at a time rather than using `{ _id: { $in: [...] } }`.
  // Mongoose's `sanitizeFilter` — enabled globally as defence against operator
  // injection — wraps `$`-prefixed VALUES in `$eq`, so an `$in` filter on an ObjectId
  // path throws CastError. Updating individually avoids that entirely and states the
  // intent plainly. See docs/SECURITY.md R3.
  const owners = await ownerIds(input.hospitalId)
  for (const ownerId of owners) {
    await withPlatformScope(() =>
      (UserModel as Model<Record<string, unknown>>)
        .updateOne({ _id: new Types.ObjectId(ownerId) }, { $set: { status: 'ACTIVE' } })
        .exec(),
    )
  }

  await recordAudit({
    action: AUDIT_ACTIONS.HOSPITAL_APPROVED,
    actorUserId: input.actor.userId,
    actorRole: input.actor.role,
    hospitalId: input.hospitalId,
    resourceType: 'Hospital',
    resourceId: input.hospitalId,
    ip: input.meta.ip,
    requestId: input.meta.requestId,
  })

  return { hospitalId: input.hospitalId, status: 'APPROVED' }
}

async function ownerIds(hospitalId: string): Promise<string[]> {
  const memberships = await (MembershipModel as Model<Record<string, unknown>>)
    .find({ hospitalId, role: 'HOSPITAL_ADMIN' })
    .lean()
    .exec()
  return memberships.map((membership) => String(membership['userId']))
}
