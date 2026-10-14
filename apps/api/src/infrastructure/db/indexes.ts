import mongoose, { type Model } from 'mongoose'

/**
 * Index creation.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────
 *
 * Several correctness guarantees here are enforced by a UNIQUE index rather than by
 * application code, because an application check has a race window and an index does not.
 * Two that matter:
 *
 *  - `AppointmentSlot` on `{ hospitalId, doctorUserId, slotStart }` — the only thing that
 *    makes double booking impossible when two requests arrive at once.
 *  - `Patient` on `{ hospitalId, patientNumber }` — so two simultaneous registrations
 *    cannot receive the same patient number.
 *
 * `mongoose.connect` is called with `autoIndex: false`, on the reasoning that index builds
 * should be an explicit, verifiable step rather than a side effect of boot. That reasoning
 * is sound, but nothing was performing the explicit step: the comment in `connection.ts`
 * referred to a migration runner that was never written. The database therefore had only
 * its `_id` index — every unique constraint above was absent in development AND in
 * production, while the tests that assumed them passed anyway.
 *
 * So the explicit step exists now, and runs on boot in every environment. That is
 * deliberate: a database missing the constraint that prevents double booking is an
 * incident waiting to happen, and failing at startup beats discovering it when two
 * patients arrive at the same time.
 *
 * `syncIndexes` also drops indexes no longer declared in a schema. That is right for a
 * development database and for a fresh deployment; against a large production collection
 * it would be expensive, and is the eventual argument for a real migration tool with an
 * explicit, reviewable plan.
 */

let ensured: Promise<void> | null = null

/** Build every index the schemas declare. Safe to call repeatedly. */
export async function ensureIndexes(): Promise<void> {
  ensured ??= build().catch((error: unknown) => {
    // Clear the memo so a later attempt retries, rather than caching the failure forever
    // and leaving the process permanently without its constraints.
    ensured = null
    throw error
  })

  return ensured
}

async function build(): Promise<void> {
  // Importing the model modules registers every schema with Mongoose. These are dynamic
  // imports so that merely importing this file does not register models, which keeps the
  // registration order under the control of whoever starts the process.
  await Promise.all([
    import('../../modules/identity/models.js'),
    import('../../modules/audit/audit.model.js'),
    import('../../modules/hospital-admin/hospital-admin.models.js'),
    import('../../modules/patients/patients.models.js'),
    import('../../modules/appointments/appointments.models.js'),
    import('../../modules/subscriptions/subscription.models.js'),
    import('../../modules/notifications/notification.models.js'),
  ])

  for (const model of Object.values(mongoose.models) as Model<Record<string, unknown>>[]) {
    await model.syncIndexes()
  }
}