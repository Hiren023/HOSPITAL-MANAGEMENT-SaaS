/**
 * Guards against running the toolchain from a workspace path that contains spaces.
 *
 * Many tools (Docker bind mounts, some shell scripts, CI path handling) misbehave when
 * the repository lives under a directory such as `C:\HOSPITAL MANAGEMENT SaaS`.
 * This script warns early rather than failing mysteriously later.
 *
 * IMPORTANT — why this is plain `.mjs` and not TypeScript:
 * it is invoked from `preinstall`, which npm runs BEFORE dependencies are installed.
 * A `tsx`-based script would therefore fail on a fresh clone, because tsx would not
 * exist yet. Plain Node means zero dependencies and no bootstrap problem.
 *
 * Usage:
 *   node scripts/check-workspace-path.mjs           # warn only
 *   node scripts/check-workspace-path.mjs --strict  # exit non-zero if the path has spaces
 *   node scripts/check-workspace-path.mjs --warn    # always exit 0 (used by preinstall)
 */

import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const STRICT = process.argv.includes('--strict')
const ALWAYS_OK = process.argv.includes('--warn')

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const hasSpaces = /\s/.test(repositoryRoot)

const MESSAGE =
  `Repository path contains spaces: "${repositoryRoot}"\n` +
  `Docker bind mounts, some shell scripts and CI path handling can misbehave with spaces.\n` +
  `Recommended location: C:\\dev\\infinigrow-hospital-cloud`

if (hasSpaces) {
  if (ALWAYS_OK) {
    // Written to stdout, not stderr: `npm install` shells this as `preinstall`, and a
    // stderr write makes PowerShell report the entire install as failed.
    console.log(`[check-workspace-path] WARNING — ${MESSAGE}`)
    process.exit(0)
  }

  if (STRICT) {
    console.error(`[check-workspace-path] ERROR\n${MESSAGE}`)
    process.exit(1)
  }

  console.log(`[check-workspace-path] WARNING — ${MESSAGE}`)
  process.exit(0)
}

console.log(`[check-workspace-path] OK — ${repositoryRoot}`)