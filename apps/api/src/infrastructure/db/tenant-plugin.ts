import { AsyncLocalStorage } from 'node:async_hooks'
import { Schema, Types } from 'mongoose'
// A Mongoose query has many generic parameters; alias the loose shape used by hooks so
// the signatures below stay readable and do not break when generics change.
type Query = {
  getFilter: () => unknown
  setQuery: (filter: Record<string, unknown>) => void
  getUpdate: () => unknown
  pipeline: () => unknown[]
}

import { getTenantContext } from './tenant-context.js'

/**
 * Tenant-scoping Mongoose plugin.
 *
 * This is the primary defence against cross-tenant data access
 * (docs/SECURITY.md R1). A developer writing an unscoped query gets one of two
 * safe outcomes instead of a data leak:
 *
 *  1. **Inside a tenant request** — `hospitalId` is injected into the filter
 *     automatically, so `Patient.find({ name })` only ever matches the caller's
 *     own hospital.
 *  2. **Outside a tenant request** — the query THROWS. There is no "no context
 *     means all tenants" path, because that default is exactly how a leak happens.
 *
 * Register on every tenant-scoped schema via `tenantScopedSchema()` below.
 */

/** Query operations that carry a filter we must scope. */
const FILTERED_OPERATIONS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'findById',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
  'exists',
] as const

/**
 * Platform-level operations (tenant approval, plan management) may read across
 * hospitals.
 *
 * Backed by `AsyncLocalStorage`, NOT a module-level flag. A plain boolean would be
 * shared across concurrent requests, so while one request ran a platform query,
 * an unrelated in-flight request would silently inherit bypass access. Storage per
 * async execution context makes the grant incapable of leaking sideways.
 *
 * Every use must produce an audit-log entry.
 */
const platformScopeStorage = new AsyncLocalStorage<boolean>()

export function isPlatformScopeActive(): boolean {
  return platformScopeStorage.getStore() === true
}

/**
 * Run `callback` with tenant scoping disabled.
 *
 * The grant is bound to the current async execution, so concurrent requests are
 * unaffected. Nested use is rejected: if platform code already has full visibility,
 * re-entering would suggest a control-flow misunderstanding.
 *
 * The scope only permits the CALL to proceed — it grants no authority on its own.
 * Every caller must still sit behind `requirePlatformPermission`, and must record a
 * `PLATFORM_SCOPE_USED` audit entry, because reading across hospitals is exactly the
 * capability that must always leave a trace (docs/SECURITY.md R1).
 */
export function withPlatformScope<T>(callback: () => T): T {
  if (isPlatformScopeActive()) {
    throw new Error(
      'withPlatformScope() is already active in this execution context. Platform operations must not nest.',
    )
  }

  return platformScopeStorage.run(true, callback)
}

function tenantFilterFor(modelName: string, filter: unknown): Record<string, unknown> {
  const context = getTenantContext()
  if (!context) {
    throw new Error(
      `Tenant context is required to query "${modelName}", but none was bound to this ` +
        'execution. Wrap the call in a request context, or use withPlatformScope() for an ' +
        'audited platform-level operation.',
    )
  }

  // A caller-supplied hospitalId must never override the injected one. Honouring it
  // is precisely how a cross-tenant read would be attempted, so it is discarded
  // (docs/ARCHITECTURE.md 6.1).
  const safeFilter = { ...((filter ?? {}) as Record<string, unknown>) }
  delete safeFilter['hospitalId']

  return { ...safeFilter, hospitalId: context.hospitalId }
}

/**
 * These hooks are registered WITHOUT a `next` parameter, i.e. they are promise-style
 * hooks. Mongoose then awaits the returned value.
 *
 * Why not the callback style: empirically, against mongoose 9.11.1, a query hook
 * declared with `(next)` or `(this, next)` receives `argc = 0` — the callback is never
 * delivered — so calling `next()` throws "next is not a function". Promise-style hooks
 * are both the correct and the reliable choice.
 */
function injectTenantScope(schema: Schema, modelName: string): void {
  for (const operation of FILTERED_OPERATIONS) {
    schema.pre(
      operation as never,
      { query: true, document: false } as never,
      function (this: Query) {
        if (isPlatformScopeActive()) return

        const filter = typeof this.getFilter === 'function' ? this.getFilter() : {}
        const scoped = tenantFilterFor(modelName, filter)

        // Verified empirically against mongoose 9.11.1:
        //  - there is NO `setFilter()` on a query;
        //  - `Query.set({...})` does NOT affect the filter — `getFilter()` still returns
        //    `{}` afterwards, because `set()` builds an update document, not conditions;
        //  - `setQuery(filter)` DOES replace `_conditions`, which `getFilter()` returns.
        //
        // The earlier `set()` attempt silently no-opped, so every "tenant-scoped" read
        // returned every tenant's rows. That is precisely the leak this plugin exists to
        // prevent, and it passed a naive unit test because the test used the raw driver.
        this.setQuery(scoped as Record<string, unknown>)
      },
    )
  }

  schema.pre(
    'aggregate' as never,
    { query: true, document: false } as never,
    function (this: Query) {
      if (isPlatformScopeActive()) return

      const context = getTenantContext()
      if (!context) {
        throw new Error(
          `Tenant context is required to aggregate on "${modelName}", but none was bound.`,
        )
      }

      // Prepend the match so a later pipeline stage cannot remove the restriction.
      //
      // `hospitalId` must be a real ObjectId here, NOT the string carried on the context.
      // An aggregation is handed to the driver as-is and gets no casting, so
      // `{ hospitalId: '6acb…' }` never matches the stored ObjectId. That failure is
      // silent and total — the query succeeds, returns nothing, and looks exactly like an
      // empty table. The Query path above is immune because Mongoose casts string ids for
      // typed paths, which is why only the aggregate routes were affected.
      if (!Types.ObjectId.isValid(context.hospitalId)) {
        throw new Error(
          `Tenant context for "${modelName}" carries a hospitalId that is not an ObjectId.`,
        )
      }

      const pipeline = this.pipeline() as unknown[]
      pipeline.unshift({ $match: { hospitalId: new Types.ObjectId(context.hospitalId) } })
    },
  )
}

/**
 * Strip `hospitalId` from update payloads so a write cannot move a document to
 * another tenant.
 */
function stripTenantFromUpdates(schema: Schema): void {
  const updateOperations = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'] as const

  for (const operation of updateOperations) {
    schema.pre(
      operation as never,
      { query: true, document: false } as never,
      function (this: Query) {
        const update = this.getUpdate() as Record<string, unknown> | undefined

        if (update && typeof update === 'object') {
          const set = update['$set'] as Record<string, unknown> | undefined
          if (set && 'hospitalId' in set) delete set['hospitalId']

          if ('hospitalId' in update) delete update['hospitalId']
        }
      },
    )
  }
}

/** Refuse to save a tenant document with no bound context. */
function requireTenantOnCreate(schema: Schema): void {
  // Document pre-hooks are invoked with NO arguments and must throw rather than call
  // `next`. A thrown error aborts the save; a missing `next` throws
  // "next is not a function" and masks the real message.
  //
  // Verified empirically against mongoose 9.11.1: a document hook receives argc = 1
  // (an object that is not a callable callback), while a query hook with a declared
  // `next` parameter does receive a usable callback.
  schema.pre(
    'save',
    { document: true, query: false },
    function (this: { constructor: { modelName?: string } }) {
      if (isPlatformScopeActive()) return
      if (getTenantContext()) return

      // `this` is the document; its constructor carries the model name. The closed-over
      // `schema.modelName` is undefined at document-hook time.
      const modelName = this?.constructor?.modelName ?? 'unknown'

      throw new Error(
        `Tenant context is required to save a "${modelName}" document, but none was bound.`,
      )
    },
  )
}

/**
 * Creates a schema with tenant scoping applied.
 *
 * @example
 * const PatientSchema = tenantScopedSchema('Patient', { uhid: { type: String, required: true } })
 */
export function tenantScopedSchema<T = unknown>(
  modelName: string,
  definition: Record<string, unknown> = {},
  // `strictQuery` is included so tenant-scoped schemas can reject query fields that do
  // not exist, matching the identity models. Without it a typo in a filter is silently
  // ignored and the query returns MORE rows than intended, not fewer.
  options: { timestamps?: boolean; strict?: boolean; strictQuery?: boolean } = {},
): Schema<T> {
  const schema = new Schema<T>(
    {
      ...definition,
      hospitalId: {
        type: Schema.Types.ObjectId,
        required: true,
        immutable: true,
        index: true,
      },
    },
    {
      strict: options.strict ?? true,
      strictQuery: true,
      ...(options.timestamps === false ? {} : { timestamps: true }),
    },
  )

  if (!schema.path('hospitalId')) {
    throw new Error(`Schema "${modelName}" is missing the tenant discriminator`)
  }

  injectTenantScope(schema, modelName)
  stripTenantFromUpdates(schema)
  requireTenantOnCreate(schema)

  // `hospitalId` leads every compound index so a tenant-scoped query is answered
  // from the index rather than by filtering after a scan.
  schema.index({ hospitalId: 1, createdAt: -1 })

  return schema
}

/**
 * Throws when a query on a tenant-scoped schema has not been given a tenant filter.
 *
 * Called from repository code as a final assertion. This exists because the
 * auto-injection above is a safety net, not a substitute for explicit scoping: if the
 * injection hook is ever removed, mis-registered, or bypassed by a raw driver call,
 * this check turns a silent cross-tenant read into a loud failure.
 */
export function assertTenantFilter(modelName: string, filter: unknown): void {
  if (isPlatformScopeActive()) return

  if (!getTenantContext()) {
    throw new Error(
      `Tenant context is required to query "${modelName}", but none was bound to this execution.`,
    )
  }

  const hasTenantFilter =
    typeof filter === 'object' && filter !== null && 'hospitalId' in (filter as object)

  if (!hasTenantFilter) {
    throw new Error(
      `Query on "${modelName}" is missing an explicit hospitalId filter. Relying on implicit ` +
        'injection is not acceptable in repository code — pass the tenant filter explicitly.',
    )
  }
}

export { FILTERED_OPERATIONS }
