import { planDefinition, type Plan } from '@infinigrow/shared'
import { Types, type Model } from 'mongoose'

import { ApiError } from '../../infrastructure/api-error.js'
import { withPlatformScope } from '../../infrastructure/db/tenant-plugin.js'
import {
  buildPageMeta,
  cursorFilter,
  decodeCursor,
  encodeCursor,
} from '../../utilities/pagination.js'
import {
  countViaAggregate,
  findPageViaAggregate,
  newestTimestampViaAggregate,
} from '../../utilities/mongo-compat.js'
import { AUDIT_ACTIONS } from '../audit/audit.model.js'
import { recordAudit } from '../audit/audit.service.js'
import { HospitalModel, MembershipModel, UserModel } from '../identity/models.js'

/**
 * Platform (SaaS operator) services.
 *
 * ── A rule that shapes this whole file ──────────────────────────────────────────
 *
 * **Nothing here may return patient data.** A `SUPER_ADMIN` is the operator of the
 * SaaS, not a clinician: they can see which hospitals exist, whether they are active,
 * how many staff accounts they have and what happened in the audit log. They can never
 * see a patient, an appointment or a consultation — and no permission exists anywhere in
 * this product that would grant it (docs/SECURITY.md R14).
 *
 * That is why the overview and reports below are built from `countDocuments` and
 * `aggregate` over `hospitals`, `users` and `memberships` only. There is deliberately no
 * code path that queries a clinical collection, so there is nothing to misconfigure.
 * `platform-no-phi.test.ts` asserts that the platform models module imports no clinical
 * model and that its responses carry no field name resembling patient content.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────────
 *
 * Every read runs inside `withPlatformScope`. Hospital collections are tenant-scoped by
 * default and would silently return *zero rows* under platform scope; forgetting the
 * wrapper would look like "no data yet" rather than an error, which is a genuinely
 * dangerous failure mode for a console whose job is to show reality.
 */

type Row = Record<string, unknown>

const hospitalModel = () => HospitalModel as unknown as Model<Row>
const userModel = () => UserModel as unknown as Model<Row>
const membershipModel = () => MembershipModel as unknown as Model<Row>

/** Fields the platform list returns. Explicit, so a schema addition cannot leak by accident. */
function toHospitalSummary(row: Row) {
  const plan = String(row['plan'] ?? 'STARTER')
  const definition = planDefinition(plan)

  return {
    id: String(row['_id']),
    name: row['name'],
    slug: row['slug'],
    status: row['status'],
    plan,
    planLabel: definition.label,
    seatLimit: definition.seatLimit,
    registrationNumber: row['registrationNumber'] ?? null,
    contactEmail: row['contactEmail'] ?? null,
    city: (row['address'] as Row | undefined)?.['city'] ?? null,
    state: (row['address'] as Row | undefined)?.['state'] ?? null,
    createdAt: row['createdAt'],
    approvedAt: row['approvedAt'] ?? null,
    suspendedAt: row['suspendedAt'] ?? null,
    suspensionReason: row['suspensionReason'] ?? null,
  }
}

// ───────────────────────────────────────── overview ─────────────────────────────────────────

/**
 * Platform operational metrics.
 *
 * Counts and timestamps only. There is no patient, appointment or consultation figure
 * anywhere in this payload — deliberately. A tenant's patient volume is its business
 * data and is none of the platform operator's concern; the operator needs to know that
 * a hospital is *active and healthy*, not what is inside it.
 */
export async function platformOverview(actor: Actor, meta: Meta) {
  const [byStatus, totalHospitals, totalUsers, activeMemberships, plans, recentAudit] =
    await withPlatformScope(() =>
      Promise.all([
        hospitalModel()
          .aggregate<{ _id: string; count: number }>([
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
          .exec(),
        hospitalModel().countDocuments().exec(),
        userModel().countDocuments().exec(),
        membershipModel().countDocuments({ status: 'ACTIVE' }).exec(),
        hospitalModel()
          .aggregate<{ _id: string; count: number }>([
            { $group: { _id: '$plan', count: { $sum: 1 } } },
          ])
          .exec(),
        countRecentAudit(),
      ]),
    )

  const statusCounts: Record<string, number> = {}
  for (const entry of byStatus) statusCounts[String(entry._id)] = entry.count

  const planCounts: Record<string, number> = {}
  for (const entry of plans) planCounts[String(entry._id)] = entry.count

  await recordAudit({
    action: AUDIT_ACTIONS.PLATFORM_SCOPE_USED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    resourceType: 'Platform',
    resourceId: 'overview',
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { operation: 'platform_overview' },
  })

  return {
    tenants: {
      total: totalHospitals,
      pending: statusCounts['PENDING'] ?? 0,
      approved: statusCounts['APPROVED'] ?? 0,
      suspended: statusCounts['SUSPENDED'] ?? 0,
      rejected: statusCounts['REJECTED'] ?? 0,
    },
    identity: {
      /** Global accounts, across all tenants. Never a patient. */
      totalUsers,
      activeMemberships,
    },
    plans: planCounts,
    recentActivity: recentAudit,
  }
}

/**
 * Count of audit events in the last 24 hours, and the timestamp of the newest.
 * A volume figure only — never the events themselves, which may reference a tenant.
 *
 * Uses `aggregate` because `$gte` on a typed `createdAt` path throws a CastError in a
 * Query filter under Mongoose 9 (see `utilities/mongo-compat.ts`).
 */
async function countRecentAudit(): Promise<{ last24h: number; mostRecentAt: string | null }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const auditModel = await auditModelRef()
  if (!auditModel) return { last24h: 0, mostRecentAt: null }

  const [last24h, mostRecentAt] = await Promise.all([
    countViaAggregate(auditModel, { createdAt: { $gte: since } }),
    newestTimestampViaAggregate(auditModel, {}),
  ])

  return { last24h, mostRecentAt }
}

/** Resolved lazily so this module does not create an import cycle at load time. */
let cachedAuditModel: Model<Row> | null | undefined

async function auditModelRef(): Promise<Model<Row> | null> {
  if (cachedAuditModel !== undefined) return cachedAuditModel
  const module = await import('../audit/audit.model.js')
  cachedAuditModel = (module['AuditLogModel'] as Model<Row> | undefined) ?? null
  return cachedAuditModel
}

// ───────────────────────────────────────── tenant list ────────────────────────────────────────

/**
 * Paginated, searchable, filterable tenant list.
 *
 * Filtering and pagination happen in MongoDB, not in JavaScript. The previous
 * implementation fetched up to 100 rows and let the browser filter them, which silently
 * produced wrong answers the moment a platform had more than 100 hospitals: page 2
 * would be empty while the header still said "100 hospitals".
 */
export async function listHospitals(actor: Actor, query: HospitalListQuery, meta: Meta) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20

  const filter: Row = {}

  if (query.status) filter['status'] = query.status
  if (query.plan) filter['plan'] = query.plan

  if (query.q) {
    // Escaped: a user typing `C++` or `a.b` must not produce a regex error or, worse, a
    // wildcard search they did not ask for.
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped, 'i')
    filter['$or'] = [{ name: pattern }, { slug: pattern }, { registrationNumber: pattern }]
  }

  const sortDirection = query.sort === 'name' ? 1 : -1
  const sortField = query.sort === 'name' ? 'name' : 'createdAt'

  const [total, rows] = await withPlatformScope(() =>
    Promise.all([
      hospitalModel().countDocuments(filter).exec(),
      hospitalModel()
        .find(filter)
        .sort({ [sortField]: sortDirection, _id: sortDirection })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
    ]),
  )

  await recordAudit({
    action: AUDIT_ACTIONS.PLATFORM_SCOPE_USED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    resourceType: 'Hospital',
    resourceId: 'collection',
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: {
      operation: 'list_hospitals',
      page,
      pageSize,
      total,
      filters: { status: query.status ?? null, plan: query.plan ?? null, q: query.q ?? null },
    },
  })

  return {
    items: (rows as Row[]).map(toHospitalSummary),
    page: buildPageMeta({ requestId: meta.requestId, page, pageSize, total }),
  }
}

// ───────────────────────────────────────── tenant detail ───────────────────────────────────────

export async function hospitalDetail(actor: Actor, hospitalId: string, meta: Meta) {
  const row = await withPlatformScope(() => hospitalModel().findById(hospitalId).lean().exec())

  if (!row) throw ApiError.notFound()

  const hospitalObjectId = new Types.ObjectId(String(row['_id']))

  const [membershipCounts, totalUsers] = await withPlatformScope(() =>
    Promise.all([
      membershipModel()
        .aggregate<{ _id: string; count: number }>([
          // A real ObjectId, not a string: `aggregate` does no casting, so a string
          // here would match nothing and report a hospital as having no staff.
          { $match: { hospitalId: hospitalObjectId } },
          { $group: { _id: '$role', count: { $sum: 1 } } },
        ])
        .exec(),
      // Counted from the memberships collection, which is where tenant membership
      // actually lives. There is no `memberships` array on the user document.
      countViaAggregate(membershipModel(), { hospitalId: hospitalObjectId }),
    ]),
  )

  const usersByRole: Record<string, number> = {}
  for (const entry of membershipCounts) usersByRole[String(entry._id)] = entry.count

  const definition = planDefinition(String(row['plan'] ?? 'STARTER'))

  // Reading a tenant record is itself auditable: an operator browsing tenants at scale
  // is precisely the access pattern a hospital wants to be able to review afterwards.
  await recordAudit({
    action: AUDIT_ACTIONS.HOSPITAL_VIEWED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId,
    resourceType: 'Hospital',
    resourceId: hospitalId,
    ip: meta.ip,
    requestId: meta.requestId,
  })

  return {
    ...toHospitalSummary(row),
    planLabel: definition.label,
    seatLimit: definition.seatLimit,
    departmentLimit: definition.departmentLimit,
    indicativeMonthlyPriceInr: definition.indicativeMonthlyPriceInr,
    approvedBy: row['approvedBy'] ? String(row['approvedBy']) : null,
    reactivatedAt: row['reactivatedAt'] ?? null,
    planChangedAt: row['planChangedAt'] ?? null,
    address: row['address'] ?? null,
    usersByRole,
    totalUsers,
  }
}

// ───────────────────────────────────────── lifecycle ────────────────────────────────────────────

export async function suspendHospital(
  actor: Actor,
  hospitalId: string,
  reason: string,
  meta: Meta,
) {
  const hospital = await withPlatformScope(() => hospitalModel().findById(hospitalId).lean().exec())
  if (!hospital) throw ApiError.notFound()

  const current = String(hospital['status'])
  if (current === 'SUSPENDED') {
    throw ApiError.conflict('This hospital is already suspended.')
  }

  const updated = await withPlatformScope(() =>
    hospitalModel()
      .findByIdAndUpdate(
        hospitalId,
        {
          $set: { status: 'SUSPENDED', suspendedAt: new Date(), suspensionReason: reason },
        },
        { returnDocument: 'after' },
      )
      .lean()
      .exec(),
  )

  if (!updated) throw ApiError.notFound()

  await recordAudit({
    action: AUDIT_ACTIONS.HOSPITAL_SUSPENDED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId,
    resourceType: 'Hospital',
    resourceId: hospitalId,
    ip: meta.ip,
    requestId: meta.requestId,
    // The reason is included: a hospital locked out of its own data has no other way to
    // find out why, and this is the record it will be judged against.
    metadata: { reason, previousStatus: current },
  })

  return { hospitalId, status: 'SUSPENDED' as const, suspensionReason: reason }
}

export async function reactivateHospital(
  actor: Actor,
  hospitalId: string,
  note: string | undefined,
  meta: Meta,
) {
  const hospital = await withPlatformScope(() => hospitalModel().findById(hospitalId).lean().exec())
  if (!hospital) throw ApiError.notFound()

  if (String(hospital['status']) !== 'SUSPENDED') {
    throw ApiError.conflict('Only a suspended hospital can be reactivated.')
  }

  const updated = await withPlatformScope(() =>
    hospitalModel()
      .findByIdAndUpdate(
        hospitalId,
        {
          $set: { status: 'APPROVED', reactivatedAt: new Date() },
          $unset: { suspendedAt: '', suspensionReason: '' },
        },
        { returnDocument: 'after' },
      )
      .lean()
      .exec(),
  )

  if (!updated) throw ApiError.notFound()

  await recordAudit({
    action: AUDIT_ACTIONS.HOSPITAL_REACTIVATED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId,
    resourceType: 'Hospital',
    resourceId: hospitalId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { note: note ?? null },
  })

  return { hospitalId, status: 'APPROVED' as const }
}

// ───────────────────────────────────────── plan assignment ─────────────────────────────────────

/**
 * Assign a subscription plan.
 *
 * Plan assignment ONLY — no payment gateway, no invoicing, no proration, no automatic
 * suspension for non-payment. Nothing here charges anyone or talks to a payment provider,
 * and a plan change is not evidence that any money has moved (docs/SECURITY.md R16).
 */
export async function assignPlan(
  actor: Actor,
  hospitalId: string,
  plan: Plan,
  reason: string | undefined,
  meta: Meta,
) {
  const hospital = await withPlatformScope(() => hospitalModel().findById(hospitalId).lean().exec())
  if (!hospital) throw ApiError.notFound()

  const previous = String(hospital['plan'] ?? 'STARTER')
  if (previous === plan) {
    throw ApiError.conflict(`This hospital is already on the ${planDefinition(plan).label} plan.`)
  }

  const updated = await withPlatformScope(() =>
    hospitalModel()
      .findByIdAndUpdate(
        hospitalId,
        { $set: { plan, planChangedAt: new Date(), planChangedBy: actor.userId } },
        { returnDocument: 'after' },
      )
      .lean()
      .exec(),
  )

  if (!updated) throw ApiError.notFound()

  await recordAudit({
    action: AUDIT_ACTIONS.HOSPITAL_PLAN_CHANGED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId,
    resourceType: 'Hospital',
    resourceId: hospitalId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { previousPlan: previous, newPlan: plan, reason: reason ?? null },
  })

  return {
    hospitalId,
    plan,
    planLabel: planDefinition(plan).label,
    seatLimit: planDefinition(plan).seatLimit,
  }
}

// ───────────────────────────────────────── tenant users ────────────────────────────────────────

/**
 * Staff accounts belonging to one tenant.
 *
 * Only identity and role — never clinical data, and never the password hash. The
 * projection is explicit so a future field on the user schema cannot surface here by
 * default.
 */
export async function listTenantUsers(
  actor: Actor,
  hospitalId: string,
  query: TenantUserQuery,
  meta: Meta,
) {
  const hospital = await withPlatformScope(() => hospitalModel().findById(hospitalId).lean().exec())
  if (!hospital) throw ApiError.notFound()

  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const hospitalObjectId = new Types.ObjectId(String(hospital['_id']))

  const membershipFilter: Row = { hospitalId: hospitalObjectId }
  if (query.role) membershipFilter['role'] = query.role
  if (query.status) membershipFilter['status'] = query.status

  const memberships = await withPlatformScope(() =>
    membershipModel()
      .find(membershipFilter)
      .select({ userId: 1, role: 1, status: 1 })
      .lean()
      .exec(),
  )

  const membershipByUser = new Map<string, Row>()
  for (const membership of memberships as Row[]) {
    membershipByUser.set(String(membership['userId']), membership)
  }

  const userIds = [...membershipByUser.keys()]

  const userFilter: Row = {
    // Real ObjectIds: `aggregate` performs no casting, so strings would match nothing
    // and the console would report a hospital as having no staff.
    _id: { $in: userIds.map((id) => new Types.ObjectId(id)) },
  }
  if (query.q) {
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped, 'i')
    userFilter['$or'] = [{ email: pattern }, { firstName: pattern }, { lastName: pattern }]
  }

  // Users are a global identity collection, so this is an explicit cross-tenant read
  // rather than a tenant-scoped one. The `hospitalId` here comes from the URL the
  // operator chose, not from their token — which is legitimate here and only here,
  // because the whole purpose of a platform console is to look across tenants. Every
  // other route in the product derives scope from the token instead.
  const [total, users] = await Promise.all([
    // `aggregate`, not `countDocuments`: `_id: { $in: userIds }` throws a CastError in a
    // Query filter under Mongoose 9 (see `utilities/mongo-compat.ts`).
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
        status: 1,
        emailVerified: 1,
        lastLoginAt: 1,
      } as unknown as Record<string, 0 | 1>,
    }),
  ])

  const items = users.map((user) => {
    const membership = membershipByUser.get(String(user['_id']))
    return {
      userId: String(user['_id']),
      email: user['email'],
      firstName: user['firstName'],
      lastName: user['lastName'],
      status: user['status'],
      emailVerified: Boolean(user['emailVerified']),
      lastLoginAt: user['lastLoginAt'] ?? null,
      role: membership?.['role'] ?? null,
      membershipStatus: membership?.['status'] ?? null,
    }
  })

  await recordAudit({
    action: AUDIT_ACTIONS.HOSPITAL_USER_VIEWED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    hospitalId,
    resourceType: 'Membership',
    resourceId: 'collection',
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { operation: 'list_tenant_users', rowsReturned: items.length },
  })

  return {
    items,
    page: buildPageMeta({ requestId: meta.requestId, page, pageSize, total }),
  }
}

/**
 * Activate or suspend a tenant's user account.
 *
 * This changes the GLOBAL account state, so it locks the person out of every hospital
 * they belong to — not just the one whose console the operator used. That asymmetry is
 * deliberate and stated in the audit action name (`user.status_changed` rather than
 * `membership.revoked`), because a support agent acting on a "suspicious staff member"
 * ticket needs to understand the blast radius before clicking.
 *
 * Refuses to act on the operator's own account. A platform administrator who suspends
 * themselves is locked out of the only interface that can undo it, and — depending on
 * deployment — possibly out of the platform entirely.
 */
export async function changeUserStatus(
  actor: Actor,
  userId: string,
  status: 'ACTIVE' | 'SUSPENDED',
  reason: string,
  meta: Meta,
) {
  if (userId === actor.userId) {
    throw ApiError.badRequest('You cannot change the status of your own account.')
  }

  const user = await userModel().findById(userId).select({ status: 1 }).lean().exec()

  if (!user) throw ApiError.notFound()

  const previous = String(user['status'])
  if (previous === status) {
    throw ApiError.conflict(`This account is already ${status.toLowerCase()}.`)
  }

  const update: Row = { status }
  // A suspended account must not stay locked out forever by a stale timer.
  if (status === 'ACTIVE') update['lockedUntil'] = null

  const updated = await userModel()
    .findByIdAndUpdate(userId, { $set: update }, { returnDocument: 'after' })
    .select({ email: 1, status: 1 })
    .lean()
    .exec()

  if (!updated) throw ApiError.notFound()

  await recordAudit({
    action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    resourceType: 'User',
    resourceId: userId,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { previousStatus: previous, newStatus: status, reason },
  })

  return { userId, status, email: updated['email'] }
}

// ───────────────────────────────────────── audit viewer ────────────────────────────────────────

/**
 * Platform audit log.
 *
 * "Safe filtering" means three specific things:
 *
 *  1. **Every filter is validated against a strict schema.** `action` and `actorUserId`
 *     cannot carry an operator-supplied Mongo expression — the free-text search builds a
 *     *escaped* `RegExp` from a string, so `.*` or `$where` is inert text, not a query.
 *  2. **Cursor pagination.** The trail is append-only and unbounded; `skip`/`offset`
 *     would let a concurrent write shift the window and produce an audit view with gaps
 *     or duplicates, which reads as tampering even when it is a pagination artefact.
 *  3. **Metadata is re-redacted on read.** `recordAudit` redacts on write, so this is
 *     defence in depth against a value that reached the collection by another route.
 *
 * No patient identifiers are stored in the audit metadata to begin with — the writer
 * enforces that — so nothing sensitive can surface here.
 */
export async function listAuditEvents(actor: Actor, query: AuditQuery, meta: Meta) {
  const model = await auditModelRef()
  if (!model) throw ApiError.internal('The audit store is unavailable.')

  const filter: Row = {}

  if (query.action) {
    // Exact match against a known action code, not a pattern: a filter that accepts a
    // partial action string invites an operator to believe they narrowed the trail when
    // they did not.
    filter['action'] = query.action
  }
  if (query.actorUserId) filter['actorUserId'] = new Types.ObjectId(query.actorUserId)
  if (query.hospitalId) filter['hospitalId'] = new Types.ObjectId(query.hospitalId)

  if (query.from || query.to) {
    const range: Row = {}
    if (query.from) range['$gte'] = new Date(query.from)
    if (query.to) range['$lte'] = new Date(query.to)
    filter['createdAt'] = range
  }

  if (query.q) {
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped, 'i')
    filter['$or'] = [{ action: pattern }, { resourceType: pattern }]
  }

  const cursor = decodeCursor(query.cursor)
  const limit = query.limit ?? 20

  const combined: Row = { ...filter }
  const after = cursorFilter(cursor, 'createdAt') as Row
  if (Object.keys(after).length > 0) {
    combined['$and'] = [{ ...filter }, after]
  }

  // Audit is a global collection, not tenant-scoped, so no platform-scope wrapper here.
  // `aggregate` because the cursor's `$lt`/`$lte` on `createdAt` would throw a CastError
  // in a Query filter under Mongoose 9 — see `utilities/mongo-compat.ts`.
  const fetched = await findPageViaAggregate<Row>(model, {
    match: combined,
    sort: { createdAt: -1 },
    skip: 0,
    limit: limit + 1,
  })

  const hasMore = fetched.length > limit
  const page = hasMore ? fetched.slice(0, limit) : fetched

  const items = page.map((row) => ({
    id: String(row['_id']),
    action: row['action'],
    actorUserId: row['actorUserId'] ? String(row['actorUserId']) : null,
    actorRole: row['actorRole'] ?? null,
    hospitalId: row['hospitalId'] ? String(row['hospitalId']) : null,
    resourceType: row['resourceType'] ?? null,
    resourceId: row['resourceId'] ?? null,
    outcome: row['outcome'] ?? null,
    ip: row['ip'] ?? null,
    createdAt: row['createdAt'],
    metadata: redactOnRead(row['metadata']),
  }))

  const last = page.at(-1)
  const nextCursor =
    hasMore && last ? encodeCursor(String(last['createdAt']), String(last['_id'])) : null

  await recordAudit({
    action: AUDIT_ACTIONS.PLATFORM_SCOPE_USED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    resourceType: 'AuditLog',
    resourceId: 'collection',
    ip: meta.ip,
    requestId: meta.requestId,
    // The filter set is recorded, not the free-text term, so an operator's searches are
    // reviewable without their queries themselves becoming a searchable record.
    metadata: { operation: 'list_audit_events', rowsReturned: items.length },
  })

  return { items, nextCursor, limit }
}

/** Redact keys that must never be rendered in a viewer, even if they reached storage. */
const NEVER_SHOW = /password|token|secret|otp|pan|card|dob|diagnos|prescription|patient/i

function redactOnRead(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]'
  if (value === null || typeof value !== 'object') return value

  if (Array.isArray(value)) return value.map((entry) => redactOnRead(entry, depth + 1))

  const result: Row = {}
  for (const [key, entry] of Object.entries(value as Row)) {
    result[key] = NEVER_SHOW.test(key) ? '[redacted]' : redactOnRead(entry, depth + 1)
  }
  return result
}

// ───────────────────────────────────────── reports ─────────────────────────────────────────────

/**
 * Operational report: tenant growth and account activity over a window.
 *
 * Aggregate counts over `hospitals`, `users` and `memberships`. A platform operator
 * needs to answer "is the platform growing, and are tenants healthy" — not what any
 * hospital does inside it. The clinical question is answered by that hospital's own
 * console, where the operator has no access at all.
 */
export async function operationalReport(actor: Actor, days: number, meta: Meta) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const [growth, statuses, plans, recentRegistrations, activeTenants] = await withPlatformScope(
    () =>
      Promise.all([
        hospitalModel()
          .aggregate<{ _id: string; count: number }>([
            { $match: { createdAt: { $gte: since } } },
            {
              $group: {
                _id: { year: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ])
          .exec(),
        hospitalModel()
          .aggregate<{ _id: string; count: number }>([
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
          .exec(),
        hospitalModel()
          .aggregate<{ _id: string; count: number }>([
            { $group: { _id: '$plan', count: { $sum: 1 } } },
          ])
          .exec(),
        countViaAggregate(hospitalModel(), { createdAt: { $gte: since } }),
        hospitalModel().countDocuments({ status: 'APPROVED' }).exec(),
      ]),
  )

  await recordAudit({
    action: AUDIT_ACTIONS.PLATFORM_SCOPE_USED,
    actorUserId: actor.userId,
    actorRole: actor.role,
    resourceType: 'Report',
    resourceId: 'operational',
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: { operation: 'operational_report', days },
  })

  return {
    windowDays: days,
    since,
    tenants: {
      active: activeTenants,
      registeredInWindow: recentRegistrations,
      byStatus: Object.fromEntries(statuses.map((s) => [String(s._id), s.count])),
      byPlan: Object.fromEntries(plans.map((p) => [String(p._id), p.count])),
    },
    /** One point per day with at least one registration; empty days are omitted. */
    growth: growth.map((entry) => ({ date: String(entry._id), count: entry.count })),
  }
}

// ───────────────────────────────────────── shared types ────────────────────────────────────────

export interface Actor {
  userId: string
  role: string
}

export interface Meta {
  ip: string
  requestId: string
}

export interface HospitalListQuery {
  page?: number
  pageSize?: number
  q?: string
  status?: string
  plan?: string
  sort?: 'createdAt' | 'name'
}

export interface TenantUserQuery {
  page?: number
  pageSize?: number
  q?: string
  role?: string
  status?: string
}

export interface AuditQuery {
  cursor?: string
  limit?: number
  q?: string
  action?: string
  actorUserId?: string
  hospitalId?: string
  from?: string
  to?: string
}
