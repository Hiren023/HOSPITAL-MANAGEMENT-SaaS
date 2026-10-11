import type { Model } from 'mongoose'

/**
 * MongoDB / Mongoose 9 compatibility shims.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 *
 * In Mongoose 9.11.1, **a Query filter containing an operator object on a typed path
 * throws a `CastError`.** Verified empirically against a real `mongod`, every one of
 * these fails:
 *
 * ```ts
 * model.countDocuments({ createdAt: { $gte: date } })   // CastError
 * model.find({ createdAt: { $gte: date } })             // CastError
 * model.where('createdAt').gte(date)                    // CastError
 * model.countDocuments({ _id: { $in: ids } })           // CastError
 * model.find({ _id: { $in: ids } })                     // CastError
 * model.where('_id').in(ids)                            // CastError
 * ```
 *
 * while all of these work:
 *
 * ```ts
 * model.aggregate([{ $match: { createdAt: { $gte: date } } }, { $count: 'n' }])  // OK
 * model.countDocuments({ status: 'ACTIVE' })                                     // OK
 * model.find({ name: /pattern/i })                                               // OK
 * model.find({ $or: [{ name: /a/ }, { slug: /b/ }] })                            // OK
 * ```
 *
 * The failure is at `Query.cast`, before the driver is reached, so it is not a data
 * problem and no amount of correcting the operand helps — passing real `ObjectId`s
 * instead of strings fails identically.
 *
 * This is easy to misdiagnose. The `CastError` is mapped to a 422 by
 * `infrastructure/mongo-error-mapper.ts`, so the API answers "Invalid value for
 * createdAt" for a filter the operator never supplied and never sees. That reads as a
 * client validation problem, and it was genuinely mistaken for one during Phase 4 —
 * which is why the behaviour is recorded here rather than rediscovered later.
 *
 * **Rule: any filter using an operator on a typed path goes through `aggregate`.**
 * Equality filters and top-level `$or` are fine in a Query and should stay there.
 *
 * This applies to PLAIN schemas too, not only tenant-scoped ones — `User.find({_id:
 * {$in: ids}})` fails identically. It is a Mongoose 9 behaviour, not something the
 * isolation plugin introduces.
 */

type Document = Record<string, unknown>

/** Counts documents matching a `$match` stage. */
export async function countViaAggregate(model: Model<Document>, match: Document): Promise<number> {
  const [result] = await model
    .aggregate<{ count: number }>([{ $match: match }, { $count: 'count' }])
    .exec()

  return result?.count ?? 0
}

/**
 * One page of documents, via `aggregate`.
 *
 * `$sort`, `$skip` and `$limit` behave exactly as their Query counterparts. The sort
 * carries an `_id` tie-breaker so rows sharing a sort key are neither skipped nor
 * repeated across pages — the same guarantee `utilities/pagination.ts` gives the cursor
 * helpers.
 */
export async function findPageViaAggregate<T = Document>(
  model: Model<Document>,
  options: {
    match: Document
    sort: Record<string, 1 | -1>
    skip: number
    limit: number
    /** Fields to return; omit to return the whole document. */
    project?: Record<string, 0 | 1>
  },
): Promise<T[]> {
  let stage = model.aggregate<T>([{ $match: options.match }])

  // A stable sort needs a unique tie-breaker, or two rows with the same key can swap
  // places between page requests and appear twice.
  const sort = { ...options.sort, _id: options.sort['_id'] ?? options.sort['createdAt'] ?? 1 }
  stage = stage.sort(sort as Record<string, 1 | -1>)

  // Only project when asked. Defaulting to `{ _id: 1 }` here silently returned
  // documents stripped to their id, which is indistinguishable from "the filter matched
  // nothing" further up the stack.
  if (options.project) stage = stage.project(options.project)

  return stage.skip(options.skip).limit(options.limit).exec()
}

/** The newest document matching a filter, or `null`. */
export async function findNewestViaAggregate<T = Document>(
  model: Model<Document>,
  match: Document,
): Promise<T | null> {
  const [result] = await model
    .aggregate<T>([{ $match: match }])
    .sort({ createdAt: -1, _id: -1 })
    .limit(1)
    .exec()
  return result ?? null
}

/** The newest `createdAt` matching a filter, or `null`. */
export async function newestTimestampViaAggregate(
  model: Model<Document>,
  match: Document,
): Promise<string | null> {
  const [result] = await model
    .aggregate<{ createdAt?: Date }>([{ $match: match }])
    .sort({ createdAt: -1, _id: -1 })
    .limit(1)
    .project({ createdAt: 1, _id: 0 })
    .exec()

  return result?.createdAt ? new Date(result.createdAt).toISOString() : null
}

/**
 * Every document matching a filter, up to `limit`.
 *
 * For the small, bounded lookups a Query would otherwise do — a handful of hospitals
 * behind a user's memberships, for instance. Note that `aggregate` performs **no**
 * casting: an ObjectId path needs a real `ObjectId` in `match`, not a string, or it
 * silently matches nothing. That silent miss is the trap in this file — a string
 * `_id` returns zero rows rather than an error.
 */
export async function findManyViaAggregate<T = Document>(
  model: Model<Document>,
  match: Document,
  limit = 1000,
  project?: Record<string, 0 | 1>,
): Promise<T[]> {
  let stage = model.aggregate<T>([{ $match: match }]).limit(limit)

  // Only project when asked. Defaulting to `{ _id: 1 }` silently returns documents
  // stripped to their id, so every field the caller then reads is `undefined` — which
  // surfaces far from the cause, as a BSONError from a later `new ObjectId('')`. This is
  // the same trap `findPageViaAggregate` had; it is fixed in both.
  if (project) stage = stage.project(project)

  return stage.exec()
}
