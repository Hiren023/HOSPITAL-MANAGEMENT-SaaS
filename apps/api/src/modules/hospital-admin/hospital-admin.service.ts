import {
  HOSPITAL_ASSIGNABLE_ROLES,
  planDefinition,
  resolvePermissions,
  type Permission,
  type Role,
} from '@infinigrow/shared'
import { randomBytes } from 'node:crypto'

import { Types, type Model } from 'mongoose'

import { ApiError } from '../../infrastructure/api-error.js'
import { withPlatformScope } from '../../infrastructure/db/tenant-plugin.js'
import { buildPageMeta } from '../../utilities/pagination.js'
import {
  countViaAggregate,
  findManyViaAggregate,
  findPageViaAggregate,
} from '../../utilities/mongo-compat.js'
import { AUDIT_ACTIONS } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'
import { hashPassword } from '../identity/password.util.js'
import {
  HospitalModel,
  MembershipModel,
  UserModel,
} from '../identity/models.js'
import {
  DepartmentModel,
  DoctorProfileModel,
  ScheduleModel,
} from './hospital-admin.models.js'

/**
 * Hospital administration services.
 *
 * ── The tenant rule ────────────────────────────────────────────────────────────
 *
 * **No function here accepts a `hospitalId` from the caller.** The tenant comes from
 * `actor.hospitalId`, which the middleware derived from the signed session. Every read
 * of a tenant-scoped collection therefore runs inside the tenant context and the
 * isolation plugin adds the filter; the ones that need an explicit id use
 * `actor.hospitalId` and never a request parameter.
 *
 * This is why there is no "get department by id" that could be pointed at another
 * hospital: the query is already filtered, so another tenant's id simply matches nothing
 * and the response is 404 — which is also the correct answer, since confirming that an id
 * exists elsewhere would itself be a disclosure (docs/SECURITY.md R11).
 *
 * ── The privilege rule ─────────────────────────────────────────────────────────
 *
 * `SUPER_ADMIN` cannot be created or assigned here, and cannot be reached through this
 * API at all. The role enum for staff operations is `HOSPITAL_ASSIGNABLE_ROLES`, which
 * omits it; and `assertAssignableRole` rejects it again at the service layer so a future
 * caller cannot bypass the schema.
 */

type Row = Record<string, unknown>

const hospitalModel = () => HospitalModel as unknown as Model<Row>
const userModel = () => UserModel as unknown as Model<Row>
const membershipModel = () => MembershipModel as unknown as Model<Row>
const departmentModel = () => DepartmentModel as unknown as Model<Row>
const doctorProfileModel = () => DoctorProfileModel as unknown as Model<Row>
const scheduleModel = () => ScheduleModel as unknown as Model<Row>

export interface Actor {
  userId: string
  role: string
  hospitalId: string
  permissions: Permission[]
}

export interface Meta {
  ip: string
  requestId: string
}

// ────────────────────────────── helpers ──────────────────────────────

/** Escapes regex metacharacters so a search term is matched literally. */
function escapeRegex(term: string): RegExp {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

/**
 * Resolves explicit permission grants for a membership.
 *
 * Returns the NARROWED set as a plain array, or `[]` when no grants were requested —
 * which already means "inherit the role ceiling" at resolution time. Materialising the
 * ceiling into every membership would freeze it at creation, so widening a role later
 * would silently fail to reach the people who already hold it.
 */
function narrowGrants(role: Role, grants: unknown): string[] {
  if (!Array.isArray(grants) || grants.length === 0) return []
  return [...resolvePermissions(role, grants as string[])]
}

/**
 * Rejects a role a hospital administrator may not assign.
 *
 * Belt and braces: the Zod enum already excludes `SUPER_ADMIN`, but this is the
 * function every path through this service calls before writing a role, so widening a
 * schema later cannot silently grant platform access.
 */
export function assertAssignableRole(role: unknown): Role {
  if (
    typeof role !== 'string' ||
    !(HOSPITAL_ASSIGNABLE_ROLES as readonly string[]).includes(role)
  ) {
    throw ApiError.validation([
      {
        path: 'role',
        message:
          'That role cannot be assigned within a hospital. Platform roles are provisioned separately.',
      },
    ])
  }
  return role as Role
}

/**
 * Masks a professional registration number.
 *
 * A medical council registration number is a licence identifier. It is shown to
 * identities that manage doctors, and masked everywhere else — a receptionist booking an
 * appointment needs to know who the doctor is, not their council number. Masking keeps
 * the last few characters so a person can still recognise a record they are looking at.
 */
function maskRegistration(value: unknown, actor: Actor): string {
  const raw = String(value ?? '')
  if (actor.permissions.includes('doctor:write')) return raw
  if (raw.length <= 4) return '••••'
  return `${'•'.repeat(Math.max(0, raw.length - 4))}${raw.slice(-4)}`
}

/** Loads the caller's own hospital. Always by the session's id, never by parameter. */
async function requireOwnHospital(actor: Actor): Promise<Row> {
  const hospital = await withPlatformScope(() =>
    hospitalModel().findById(actor.hospitalId).lean().exec(),
  )

  if (!hospital) throw ApiError.notFound()
  if (String(hospital['status']) !== 'APPROVED') {
    throw ApiError.forbidden('This hospital is not currently active.')
  }

  return hospital
}

// ────────────────────────────── hospital profile ──────────────────────────────

export async function readHospitalProfile(actor: Actor, meta: Meta) {
  const hospital = await requireOwnHospital(actor)

  await recordAudit({
    action: AUDIT_ACTIONS.HOSPITAL_VIEWED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Hospital',
    resourceId: actor.hospitalId,
    ip: meta.ip,
    requestId: meta.requestId,
  })

  const plan = String(hospital['plan'] ?? 'STARTER')

  return {
    id: String(hospital['_id']),
    name: hospital['name'],
    slug: hospital['slug'],
    status: hospital['status'],
    plan,
    planLabel: planDefinition(plan).label,
    seatLimit: planDefinition(plan).seatLimit,
    registrationNumber: hospital['registrationNumber'] ?? null,
    contactEmail: hospital['contactEmail'] ?? null,
    contactPhone: hospital['contactPhone'] ?? null,
    address: hospital['address'] ?? null,
    settings: hospital['settings'] ?? null,
    approvedAt: hospital['approvedAt'] ?? null,
    createdAt: hospital['createdAt'],
  }
}

export async function updateHospitalProfile(
  actor: Actor,
  input: Record<string, unknown>,
  meta: Meta,
) {
  const before = await requireOwnHospital(actor)

  // `slug` and `status` are deliberately not updatable here. The slug is the tenant's
  // public identity and changing it would break every link ever issued; the status is a
  // platform decision, not a hospital one.
  const update: Row = {}
  for (const field of [
    'name',
    'registrationNumber',
    'contactEmail',
    'contactPhone',
    'address',
  ] as const) {
    if (input[field] !== undefined) update[field] = input[field]
  }

  if (Object.keys(update).length === 0) throw ApiError.badRequest('Nothing to update.')

  const updated = await withPlatformScope(() =>
    hospitalModel()
      .findByIdAndUpdate(actor.hospitalId, { $set: update }, { returnDocument: 'after' })
      .lean()
      .exec(),
  )

  if (!updated) throw ApiError.notFound()

  await recordAudit({
    action: AUDIT_ACTIONS.HOSPITAL_PROFILE_UPDATED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Hospital',
    resourceId: actor.hospitalId,
    ip: meta.ip,
    requestId: meta.requestId,
    // Field NAMES only. A profile update carries contact details, and copying values
    // into the audit trail would duplicate personal data into a second store.
    metadata: { fields: Object.keys(update) },
  })

  void before
  return readHospitalProfile(actor, meta)
}

export async function updateHospitalSettings(
  actor: Actor,
  input: Record<string, unknown>,
  meta: Meta,
) {
  await requireOwnHospital(actor)

  const update: Row = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) update[`settings.${key}`] = value
  }

  if (Object.keys(update).length === 0) throw ApiError.badRequest('Nothing to update.')

  await withPlatformScope(() =>
    hospitalModel()
      .findByIdAndUpdate(actor.hospitalId, { $set: update }, { returnDocument: 'after' })
      .lean()
      .exec(),
  )

  await recordAudit({
    action: AUDIT_ACTIONS.HOSPITAL_SETTINGS_UPDATED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Hospital',
    resourceId: actor.hospitalId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { fields: Object.keys(input) },
  })

  const hospital = await requireOwnHospital(actor)
  return { settings: hospital['settings'] ?? null }
}

// ────────────────────────────── departments ──────────────────────────────

function toDepartment(row: Row) {
  return {
    id: String(row['_id']),
    name: row['name'],
    code: row['code'],
    description: row['description'] ?? null,
    headUserId: row['headUserId'] ? String(row['headUserId']) : null,
    isActive: Boolean(row['isActive']),
    sortOrder: Number(row['sortOrder'] ?? 0),
    createdAt: row['createdAt'],
    updatedAt: row['updatedAt'],
  }
}

export async function listDepartments(actor: Actor, query: ListQuery, meta: Meta) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20

  const filter: Row = {}
  if (query.isActive !== undefined) filter['isActive'] = query.isActive
  if (query.q) {
    const pattern = escapeRegex(query.q)
    filter['$or'] = [{ name: pattern }, { code: pattern }, { description: pattern }]
  }

  const [total, rows] = await Promise.all([
    countViaAggregate(departmentModel(), filter),
    findPageViaAggregate<Row>(departmentModel(), {
      match: filter,
      sort: { sortOrder: 1 },
      skip: (page - 1) * pageSize,
      limit: pageSize,
    }),
  ])

  void actor
  void meta

  return {
    items: rows.map(toDepartment),
    page: buildPageMeta({ requestId: meta.requestId, page, pageSize, total }),
  }
}

export async function readDepartment(actor: Actor, departmentId: string) {
  // Tenant-scoped: the plugin adds `hospitalId` from the session, so another hospital's
  // department simply does not match.
  const row = await departmentModel().findById(departmentId).lean().exec()
  if (!row) throw ApiError.notFound()

  void actor
  return toDepartment(row)
}

export async function createDepartment(actor: Actor, input: Row, meta: Meta) {
  const code = String(input['code']).toUpperCase()

  // Checked before the write so the failure is a clear 409 rather than a raw duplicate
  // key error, and so the message can name what clashed.
  const existing = await departmentModel()
    .findOne({ $or: [{ code }, { name: input['name'] }] })
    .lean()
    .exec()

  if (existing) {
    const field = String(existing['code']) === code ? 'code' : 'name'
    throw ApiError.conflict(
      field === 'code'
        ? `Department code ${code} is already used in this hospital.`
        : `A department named "${String(existing['name'])}" already exists in this hospital.`,
    )
  }

  const created = await departmentModel().create({
    ...input,
    code,
    hospitalId: new Types.ObjectId(actor.hospitalId),
  })

  const departmentId = String(created['_id'])

  await recordAudit({
    action: AUDIT_ACTIONS.DEPARTMENT_CREATED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Department',
    resourceId: departmentId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { code, name: input['name'] },
  })

  void actor
  return toDepartment(created.toObject() as Row)
}

export async function updateDepartment(
  actor: Actor,
  departmentId: string,
  input: Row,
  meta: Meta,
) {
  const existing = await departmentModel().findById(departmentId).lean().exec()
  if (!existing) throw ApiError.notFound()

  const update: Row = {}
  for (const field of ['name', 'code', 'description', 'headUserId', 'isActive', 'sortOrder']) {
    if (input[field] !== undefined) update[field] = input[field]
  }
  if (update['code'] !== undefined) update['code'] = String(update['code']).toUpperCase()

  if (update['code'] !== undefined || update['name'] !== undefined) {
    const clash = await departmentModel()
      .findOne({
        _id: { $ne: new Types.ObjectId(departmentId) },
        $or: [
          ...(update['code'] !== undefined ? [{ code: update['code'] }] : []),
          ...(update['name'] !== undefined ? [{ name: update['name'] }] : []),
        ],
      })
      .lean()
      .exec()

    if (clash) {
      throw ApiError.conflict(
        update['code'] !== undefined && String(clash['code']) === String(update['code'])
          ? `Department code ${String(update['code'])} is already used in this hospital.`
          : `A department named "${String(clash['name'])}" already exists in this hospital.`,
      )
    }
  }

  const updated = await departmentModel()
    .findByIdAndUpdate(departmentId, { $set: update }, { returnDocument: 'after' })
    .lean()
    .exec()

  if (!updated) throw ApiError.notFound()

  await recordAudit({
    action: AUDIT_ACTIONS.DEPARTMENT_UPDATED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Department',
    resourceId: departmentId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { fields: Object.keys(update) },
  })

  void actor
  return toDepartment(updated)
}

// ────────────────────────────── doctors ──────────────────────────────

/**
 * Resolves a doctor by the user id supplied, verifying the membership belongs to the
 * caller's hospital.
 *
 * The membership check is the important half. A `userId` is a global identity, so
 * "is this user a doctor here?" cannot be answered from the user document — it has to
 * be answered from a membership in THIS hospital. Without that check, a hospital
 * administrator could attach a professional profile to any user in the system.
 */
async function requireDoctorMembership(actor: Actor, userId: string): Promise<Row> {
  const membership = await membershipModel()
    .findOne({ userId: new Types.ObjectId(userId), hospitalId: new Types.ObjectId(actor.hospitalId) })
    .lean()
    .exec()

  if (!membership) {
    throw ApiError.validation([
      { path: 'userId', message: 'That person is not a member of this hospital.' },
    ])
  }

  return membership
}

function toDoctor(row: Row, user: Row | undefined, actor: Actor, schedule?: Row[]) {
  return {
    id: String(row['_id']),
    userId: String(row['userId']),
    fullName: user ? `${String(user['firstName'])} ${String(user['lastName'])}` : null,
    email: user?.['email'] ?? null,
    phone: user?.['phone'] ?? null,
    accountStatus: user?.['status'] ?? null,
    departmentId: row['departmentId'] ? String(row['departmentId']) : null,
    // Masked unless the caller manages doctors.
    registrationNumber: maskRegistration(row['registrationNumber'], actor),
    registrationNumberMasked: !actor.permissions.includes('doctor:write'),
    specialities: row['specialities'] ?? [],
    qualifications: row['qualifications'] ?? [],
    yearsOfExperience: Number(row['yearsOfExperience'] ?? 0),
    consultationFeeInPaise: Number(row['consultationFeeInPaise'] ?? 0),
    bio: row['bio'] ?? null,
    isAcceptingNewPatients: Boolean(row['isAcceptingNewPatients']),
    schedule: schedule ?? [],
    createdAt: row['createdAt'],
    updatedAt: row['updatedAt'],
  }
}

/** Attaches names for a page of doctors without an N+1 query. */
async function attachUsers(rows: Row[]): Promise<Map<string, Row>> {
  const userIds = rows.map((row) => String(row['userId'])).filter(Boolean)
  if (userIds.length === 0) return new Map()

  // `aggregate`, not `find`: an `$in` on `_id` throws a CastError in a Query filter
  // under Mongoose 9 (see `utilities/mongo-compat.ts`). This bites the plain `User`
  // model too, not only tenant-scoped schemas.
  const users = await findManyViaAggregate<Row>(
    userModel(),
    { _id: { $in: userIds.map((id) => new Types.ObjectId(id)) } },
    1_000,
    { _id: 1, firstName: 1, lastName: 1, email: 1, phone: 1, status: 1 } as unknown as Record<
      string,
      0 | 1
    >,
  )

  return new Map(users.map((user) => [String(user['_id']), user]))
}

export async function listDoctors(actor: Actor, query: ListQuery, meta: Meta) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20

  const filter: Row = {}
  if (query.departmentId) filter['departmentId'] = new Types.ObjectId(query.departmentId)
  if (query.isAcceptingNewPatients !== undefined) {
    filter['isAcceptingNewPatients'] = query.isAcceptingNewPatients
  }

  if (query.q) {
    // Only non-sensitive fields are searchable. Searching by registration number would
    // let anyone with `doctor:read` confirm a licence number by probing, defeating the
    // masking above.
    const pattern = escapeRegex(query.q)
    filter['$or'] = [{ specialities: pattern }, { bio: pattern }]
  }

  const [total, rows] = await Promise.all([
    countViaAggregate(doctorProfileModel(), filter),
    findPageViaAggregate<Row>(doctorProfileModel(), {
      match: filter,
      sort: { createdAt: -1 },
      skip: (page - 1) * pageSize,
      limit: pageSize,
    }),
  ])

  const users = await attachUsers(rows)

  return {
    items: rows.map((row) => toDoctor(row, users.get(String(row['userId'])), actor)),
    page: buildPageMeta({ requestId: meta.requestId, page, pageSize, total }),
  }
}

export async function readDoctor(actor: Actor, profileId: string) {
  const row = await doctorProfileModel().findById(profileId).lean().exec()
  if (!row) throw ApiError.notFound()

  const users = await attachUsers([row])
  const schedule = await scheduleModel()
    .find({ doctorUserId: new Types.ObjectId(String(row['userId'])) })
    .sort({ weekday: 1, startMinute: 1 })
    .lean()
    .exec()

  return toDoctor(row, users.get(String(row['userId'])), actor, schedule as Row[])
}

export async function createDoctorProfile(actor: Actor, input: Row, meta: Meta) {
  const userId = String(input['userId'])
  await requireDoctorMembership(actor, userId)

  const registrationNumber = String(input['registrationNumber']).toUpperCase()

  const clash = await doctorProfileModel()
    .findOne({
      $or: [
        { userId: new Types.ObjectId(userId) },
        { registrationNumber },
      ],
    })
    .lean()
    .exec()

  if (clash) {
    throw ApiError.conflict(
      String(clash['userId']) === userId
        ? 'This person already has a doctor profile in this hospital.'
        : `Registration number ${registrationNumber} is already registered in this hospital.`,
    )
  }

  if (input['departmentId'] !== undefined) {
    const department = await departmentModel()
      .findById(String(input['departmentId']))
      .lean()
      .exec()
    if (!department) throw ApiError.validation([{ path: 'departmentId', message: 'Unknown department.' }])
  }

  const created = await doctorProfileModel().create({
    ...input,
    registrationNumber,
    userId: new Types.ObjectId(userId),
    hospitalId: new Types.ObjectId(actor.hospitalId),
  })

  await recordAudit({
    action: AUDIT_ACTIONS.DOCTOR_PROFILE_CREATED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'DoctorProfile',
    resourceId: String(created['_id']),
    ip: meta.ip,
    requestId: meta.requestId,
    // The registration number itself is NOT copied into the audit trail — it is
    // sensitive, and the audit log is a second store of personal data.
    metadata: { userId, hasRegistrationNumber: true },
  })

  return readDoctor(actor, String(created['_id']))
}

export async function updateDoctorProfile(
  actor: Actor,
  profileId: string,
  input: Row,
  meta: Meta,
) {
  const existing = await doctorProfileModel().findById(profileId).lean().exec()
  if (!existing) throw ApiError.notFound()

  const update: Row = {}
  for (const field of [
    'departmentId',
    'registrationNumber',
    'specialities',
    'qualifications',
    'yearsOfExperience',
    'consultationFeeInPaise',
    'bio',
    'isAcceptingNewPatients',
  ]) {
    if (input[field] !== undefined) update[field] = input[field]
  }

  if (update['registrationNumber'] !== undefined) {
    update['registrationNumber'] = String(update['registrationNumber']).toUpperCase()

    const clash = await doctorProfileModel()
      .findOne({
        _id: { $ne: new Types.ObjectId(profileId) },
        registrationNumber: update['registrationNumber'],
      })
      .lean()
      .exec()

    if (clash) {
      throw ApiError.conflict(
        `Registration number ${String(update['registrationNumber'])} is already registered in this hospital.`,
      )
    }
  }

  if (update['departmentId'] !== undefined && update['departmentId'] !== null) {
    const department = await departmentModel()
      .findById(String(update['departmentId']))
      .lean()
      .exec()
    if (!department) throw ApiError.validation([{ path: 'departmentId', message: 'Unknown department.' }])
  }

  await doctorProfileModel()
    .findByIdAndUpdate(profileId, { $set: update }, { returnDocument: 'after' })
    .lean()
    .exec()

  await recordAudit({
    action: AUDIT_ACTIONS.DOCTOR_PROFILE_UPDATED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'DoctorProfile',
    resourceId: profileId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { fields: Object.keys(update) },
  })

  return readDoctor(actor, profileId)
}

// ────────────────────────────── schedules ──────────────────────────────

function toBlock(row: Row) {
  return {
    weekday: Number(row['weekday']),
    startMinute: Number(row['startMinute']),
    endMinute: Number(row['endMinute']),
    slotDurationMinutes: Number(row['slotDurationMinutes'] ?? 15),
    isActive: Boolean(row['isActive']),
  }
}

export async function readSchedule(actor: Actor, profileId: string) {
  const profile = await doctorProfileModel().findById(profileId).lean().exec()
  if (!profile) throw ApiError.notFound()

  const rows = await scheduleModel()
    .find({ doctorUserId: new Types.ObjectId(String(profile['userId'])) })
    .sort({ weekday: 1, startMinute: 1 })
    .lean()
    .exec()

  void actor
  return {
    doctorProfileId: profileId,
    blocks: (rows as Row[]).map(toBlock),
  }
}

/**
 * Replaces a doctor's weekly schedule.
 *
 * Replace rather than merge: a form that submits the whole week should produce exactly
 * that week. Merging would leave blocks the person believed they had deleted.
 */
export async function replaceSchedule(
  actor: Actor,
  profileId: string,
  blocks: Row[],
  meta: Meta,
) {
  const profile = await doctorProfileModel().findById(profileId).lean().exec()
  if (!profile) throw ApiError.notFound()

  // One block per weekday, enforced here so the error names the day rather than
  // surfacing as an opaque duplicate-key failure from the index.
  const seen = new Set<number>()
  for (const block of blocks) {
    const weekday = Number(block['weekday'])
    if (seen.has(weekday)) {
      throw ApiError.validation([
        { path: `blocks.${weekday}`, message: 'Only one working block per weekday.' },
      ])
    }
    seen.add(weekday)
  }

  const doctorUserId = String(profile['userId'])

  await scheduleModel().deleteMany({ doctorUserId: new Types.ObjectId(doctorUserId) }).exec()

  if (blocks.length > 0) {
    await scheduleModel().insertMany(
      blocks.map((block) => ({
        ...block,
        hospitalId: new Types.ObjectId(actor.hospitalId),
        doctorUserId: new Types.ObjectId(doctorUserId),
      })),
    )
  }

  await recordAudit({
    action: AUDIT_ACTIONS.SCHEDULE_UPDATED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Schedule',
    resourceId: profileId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { blockCount: blocks.length, activeDays: blocks.filter((b) => b['isActive'] !== false).length },
  })

  return readSchedule(actor, profileId)
}

// ────────────────────────────── staff ──────────────────────────────

export async function listStaff(actor: Actor, query: ListQuery, meta: Meta) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const hospitalObjectId = new Types.ObjectId(actor.hospitalId)

  const membershipFilter: Row = { hospitalId: hospitalObjectId }
  if (query.role) membershipFilter['role'] = query.role
  if (query.membershipStatus) membershipFilter['status'] = query.membershipStatus

  const memberships = await membershipModel()
    .find(membershipFilter)
    .select({ userId: 1, role: 1, status: 1, joinedAt: 1, grantedPermissions: 1 })
    .lean()
    .exec()

  const membershipByUser = new Map<string, Row>()
  for (const membership of memberships as Row[]) {
    membershipByUser.set(String(membership['userId']), membership)
  }

  const userIds = [...membershipByUser.keys()]

  const userFilter: Row = { _id: { $in: userIds.map((id) => new Types.ObjectId(id)) } }
  if (query.q) {
    const pattern = escapeRegex(query.q)
    userFilter['$or'] = [{ email: pattern }, { firstName: pattern }, { lastName: pattern }]
  }

  const [total, users] = await Promise.all([
    countViaAggregate(userModel(), userFilter),
    findPageViaAggregate<Row>(userModel(), {
      match: userFilter,
      sort: { createdAt: 1 },
      skip: (page - 1) * pageSize,
      limit: pageSize,
      project: {
        _id: 1,
        email: 1,
        firstName: 1,
        lastName: 1,
        phone: 1,
        status: 1,
        lastLoginAt: 1,
      } as unknown as Record<string, 0 | 1>,
    }),
  ])

  return {
    items: users.map((user) => {
      const membership = membershipByUser.get(String(user['_id']))
      return {
        userId: String(user['_id']),
        fullName: `${String(user['firstName'])} ${String(user['lastName'])}`,
        email: user['email'],
        phone: user['phone'] ?? null,
        accountStatus: user['status'],
        lastLoginAt: user['lastLoginAt'] ?? null,
        role: membership?.['role'] ?? null,
        membershipStatus: membership?.['status'] ?? null,
        grantedPermissions: membership?.['grantedPermissions'] ?? [],
        joinedAt: membership?.['joinedAt'] ?? null,
      }
    }),
    page: buildPageMeta({ requestId: meta.requestId, page, pageSize, total }),
  }
}

export async function createStaffAccount(actor: Actor, input: Row, meta: Meta) {
  const role = assertAssignableRole(input['role'])
  const email = String(input['email']).toLowerCase()

  const existing = await userModel().findOne({ email }).lean().exec()
  if (existing) {
    throw ApiError.conflict('An account already exists with that email address.')
  }

  const user = await userModel().create({
    email,
    firstName: input['firstName'],
    lastName: input['lastName'],
    phone: input['phone'],
    // Generated here, never supplied by the caller. The person is emailed a reset link;
    // nobody types a password on another person's behalf.
    passwordHash: await hashPassword(randomPassword()),
    status: 'PENDING_VERIFICATION',
    emailVerified: false,
    failedLoginCount: 0,
  })

  const userId = String(user['_id'])

  try {
    await membershipModel().create({
      userId: new Types.ObjectId(userId),
      hospitalId: new Types.ObjectId(actor.hospitalId),
      role,
      // Grants NARROW the role's ceiling; `resolvePermissions` enforces that and
      // discards anything platform-level.
      //
      // Stored as `[]` when the caller supplies nothing, because an empty grant list
      // already means "inherit the role ceiling". Materialising the whole ceiling into
      // every membership would freeze it at creation time, so a later widening of a
      // role's permissions would silently fail to reach existing members.
      grantedPermissions: narrowGrants(role, input['grantedPermissions']),
      status: 'ACTIVE',
      invitedBy: new Types.ObjectId(actor.userId),
      joinedAt: new Date(),
    })
  } catch (error) {
    // Never leave an orphaned global identity behind if the membership fails.
    await userModel().deleteOne({ _id: new Types.ObjectId(userId) }).exec()
    throw error
  }

  await recordAudit({
    action: AUDIT_ACTIONS.MEMBERSHIP_CREATED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Membership',
    resourceId: userId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { role, userId },
  })

  return {
    userId,
    email,
    fullName: `${String(input['firstName'])} ${String(input['lastName'])}`,
    role,
    accountStatus: 'PENDING_VERIFICATION',
  }
}

/**
 * Changes a member's role or explicit grants.
 *
 * Cannot change their own role: an administrator who demotes themselves can lock
 * themselves out of the only interface that could restore them.
 */
export async function changeStaffRole(
  actor: Actor,
  userId: string,
  role: string,
  grantedPermissions: string[] | undefined,
  meta: Meta,
) {
  const assignable = assertAssignableRole(role)

  if (userId === actor.userId) {
    throw ApiError.badRequest('You cannot change your own role.')
  }

  const membership = await membershipModel()
    .findOne({
      userId: new Types.ObjectId(userId),
      hospitalId: new Types.ObjectId(actor.hospitalId),
    })
    .lean()
    .exec()

  if (!membership) throw ApiError.notFound()

  const previous = String(membership['role'])

  await membershipModel()
    .updateOne({ _id: new Types.ObjectId(String(membership['_id'])) }, {
      $set: {
        role: assignable,
        grantedPermissions: narrowGrants(assignable, grantedPermissions),
      },
    })
    .exec()

  await recordAudit({
    action: AUDIT_ACTIONS.PERMISSIONS_CHANGED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Membership',
    resourceId: userId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { previousRole: previous, newRole: assignable, userId },
  })

  void actor
  return { userId, role: assignable }
}

/**
 * Activates or suspends a member's account.
 *
 * Deactivation is refused for the last active administrator: a hospital with no one able
 * to administer it cannot be recovered by anyone inside the hospital, and the only way
 * back would be the platform console — which is not a self-service escape.
 */
export async function setStaffStatus(
  actor: Actor,
  userId: string,
  status: 'ACTIVE' | 'SUSPENDED',
  reason: string,
  meta: Meta,
) {
  if (userId === actor.userId) {
    throw ApiError.badRequest('You cannot change the status of your own account.')
  }

  const membership = await membershipModel()
    .findOne({
      userId: new Types.ObjectId(userId),
      hospitalId: new Types.ObjectId(actor.hospitalId),
    })
    .lean()
    .exec()

  if (!membership) throw ApiError.notFound()

  if (String(membership['role']) === 'HOSPITAL_ADMIN' && status === 'SUSPENDED') {
    const activeAdmins = await membershipModel()
      .countDocuments({
        hospitalId: new Types.ObjectId(actor.hospitalId),
        role: 'HOSPITAL_ADMIN',
        status: 'ACTIVE',
      })
      .exec()

    if (activeAdmins <= 1) {
      throw ApiError.conflict(
        'This is the only active hospital administrator. Appoint another before suspending them.',
      )
    }
  }

  await membershipModel()
    .updateOne({ _id: new Types.ObjectId(String(membership['_id'])) }, { $set: { status } })
    .exec()

  await userModel()
    .updateOne(
      { _id: new Types.ObjectId(userId) },
      // A reactivated account must not stay locked out by a stale failure counter.
      status === 'ACTIVE' ? { $set: { status: 'ACTIVE', lockedUntil: null, failedLoginCount: 0 } } : { $set: { status: 'SUSPENDED' } },
    )
    .exec()

  await recordAudit({
    action: AUDIT_ACTIONS.MEMBERSHIP_STATUS_CHANGED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId: actor.hospitalId,
    resourceType: 'Membership',
    resourceId: userId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { previousStatus: membership['status'], newStatus: status, reason, userId },
  })

  return { userId, status }
}

/** A long, random password. The holder must reset it; nobody ever sees this. */
function randomPassword(): string {
  return randomBytes(24).toString('base64url')
}

export interface ListQuery {
  page?: number
  pageSize?: number
  q?: string
  isActive?: boolean
  departmentId?: string
  isAcceptingNewPatients?: boolean
  role?: string
  membershipStatus?: string
}