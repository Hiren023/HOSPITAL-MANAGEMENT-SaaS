import { connectToDatabase, disconnectFromDatabase } from '../infrastructure/db/connection.js'
import { UserModel } from '../modules/identity/models.js'

/**
 * DEVELOPMENT ONLY — delete a user by email so bootstrap can be re-run after a
 * schema change. Refuses to run when NODE_ENV=production.
 */

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to delete a user in production.')
  }

  const index = process.argv.indexOf('--email')
  const email = index >= 0 ? process.argv[index + 1]?.trim().toLowerCase() : undefined
  if (!email) throw new Error('--email is required')

  await connectToDatabase()

  const result = await (
    UserModel as never as {
      deleteOne: (f: unknown) => { exec: () => Promise<{ deletedCount: number }> }
    }
  )
    .deleteOne({ email })
    .exec()

  process.stdout.write(`\n  Deleted ${result.deletedCount} user(s) for ${email}\n\n`)

  await disconnectFromDatabase()
}

main().catch(async (error: unknown) => {
  process.stderr.write(`\nFailed: ${error instanceof Error ? error.message : String(error)}\n\n`)
  await disconnectFromDatabase().catch(() => undefined)
  process.exit(1)
})
