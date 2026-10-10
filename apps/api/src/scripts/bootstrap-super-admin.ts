import process from 'node:process'

import { connectToDatabase, disconnectFromDatabase } from '../infrastructure/db/connection.js'
import { hashPassword } from '../modules/identity/password.util.js'
import { UserModel } from '../modules/identity/models.js'
import { AUDIT_ACTIONS } from '../modules/audit/audit.model.js'
import { recordAudit } from '../modules/audit/audit.service.js'

/**
 * Bootstrap the FIRST platform administrator.
 *
 * WHY THIS EXISTS: a `SUPER_ADMIN` holds `platform:*` permissions and deliberately has
 * NO hospital membership, so no public endpoint can create one — otherwise anyone could
 * simply register themselves as a platform operator. But the product still has to be
 * bootstrapped somehow, so this is an explicit, offline, operator-run command.
 *
 * SAFETY:
 *  - Refuses to run when NODE_ENV=production.
 *  - Refuses to run without an explicit confirmation flag.
 *  - Idempotent: refuses to overwrite an existing account.
 *  - Requires a strong password; nothing is printed in plaintext except what the
 *    operator supplied themselves.
 *
 * Usage:
 *   npx tsx src/scripts/bootstrap-super-admin.ts \
 *     --email you@example.com --name "Your Name" --password "a-long-passphrase" --i-am-secure
 */

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'Refusing to bootstrap a platform administrator in production. Provision the first ' +
        'SUPER_ADMIN through an audited runbook procedure instead.',
    )
  }

  if (!process.argv.includes('--i-am-secure')) {
    throw new Error(
      'Refusing to run without the --i-am-secure flag. This creates an account that can ' +
        'approve, suspend and list every hospital on the platform.',
    )
  }

  const email = arg('--email')?.trim().toLowerCase()
  const name = arg('--name')?.trim()
  const password = arg('--password')

  if (!email || !email.includes('@')) throw new Error('--email is required and must be valid')
  if (!name) throw new Error('--name is required')
  if (!password || password.length < 12) {
    throw new Error('--password is required and must be at least 12 characters')
  }

  await connectToDatabase()

  const existing = await (UserModel as never as {
    findOne: (input: unknown) => { lean: () => { exec: () => Promise<Record<string, unknown> | null> } }
  }).findOne({ email }).lean().exec()

  if (existing) {
    throw new Error(`A user already exists for ${email}. Nothing was changed.`)
  }

  const user = await (
    UserModel as never as { create: (input: unknown) => Promise<Record<string, unknown>> }
  ).create({
    email,
    firstName: name.split(' ')[0] ?? name,
    lastName: name.split(' ').slice(1).join(' ') || '-',
    passwordHash: await hashPassword(password),
    status: 'ACTIVE',
    emailVerified: true,
    failedLoginCount: 0,
    // Recorded so the platform role is visible in the account record itself.
    platformRole: 'SUPER_ADMIN',
  })

  const userId = String(user['_id'])

  // No membership is created: a platform role has no hospital scope by design.
  await recordAudit({
    action: AUDIT_ACTIONS.MEMBERSHIP_CREATED,
    actorUserId: userId,
    actorRole: 'SUPER_ADMIN',
    resourceType: 'User',
    resourceId: userId,
    ip: 'bootstrap',
    requestId: 'bootstrap-super-admin',
    metadata: { note: 'First platform administrator created', email },
  })

  process.stdout.write(
    `\n  Platform administrator created.\n` +
      `    id    : ${userId}\n` +
      `    email : ${email}\n` +
      `    role  : SUPER_ADMIN\n` +
      `    scope : platform (no hospital membership)\n\n` +
      `  Sign in at POST /api/v1/auth/login.\n` +
      `  Rotate this password before using the account anywhere real.\n\n`,
  )

  await disconnectFromDatabase()
}

main().catch(async (error: unknown) => {
  process.stderr.write(
    `\nBootstrap failed: ${error instanceof Error ? error.message : String(error)}\n\n`,
  )
  await disconnectFromDatabase().catch(() => undefined)
  process.exit(1)
})