/**
 * Committed-credential scan.
 *
 * Part of the Phase 10 production-readiness evidence, kept in the repository so the check
 * can be re-run and so a reviewer can see how the "no secrets committed" claim was
 * established rather than taking it on trust.
 *
 * ── What it is ─────────────────────────────────────────────────────────────────
 * A pattern scan over `apps`, `packages` and `scripts`. It catches a *literal* credential
 * — a real key, a URI with a password, a JWT, an assignment to something named
 * `password`. It is a review aid, not a security control: `gitleaks` runs in CI and is the
 * real control. This exists because gitleaks' output is harder to read while working.
 *
 * ── What it is not ─────────────────────────────────────────────────────────────
 * It does not detect a secret that is base64-encoded, split across lines, computed at
 * runtime, or committed under an unexpected variable name. A clean result here means "no
 * obvious literal found", not "no secret present".
 *
 * ── Why fixtures are reported rather than filtered ──────────────────────────────
 * Test fixtures legitimately contain passwords — that is what a fixture is, and a fixed
 * value is the point of asserting on one. Silently filtering them would also hide a real
 * hit in the same file, so they are counted and printed separately for a human to dismiss.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.tmp-test-storage', 'build'])
const SCAN_ROOTS = ['apps', 'packages', 'scripts']

const RULES = [
  { id: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { id: 'github-token', re: /\bgh[pousr]_[0-9A-Za-z]{20,}/ },
  { id: 'jwt-literal', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'mongodb-uri-creds', re: /mongodb(\+srv)?:\/\/[^/\s:@]+:[^/\s:@]{4,}@/ },
  {
    id: 'hardcoded-secret-assign',
    re: /(?:password|passwd|secret|api[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
]

/** Test fixtures and the harness that seeds them. */
function isFixture(path) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.includes('harness')
}

const findings = []

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)

    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }

    if (stats.isDirectory()) {
      walk(full)
      continue
    }
    if (!/\.(ts|tsx|mjs|js|cjs|json|env|ya?ml)$/.test(entry)) continue

    const lines = readFileSync(full, 'utf8').split(/\r?\n/)

    for (const rule of RULES) {
      lines.forEach((line, index) => {
        if (!rule.re.test(line)) return
        // Skip comment lines describing a pattern rather than using one.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return

        findings.push({
          rule: rule.id,
          file: relative(ROOT, full),
          line: index + 1,
          fixture: isFixture(full),
          excerpt: line.trim().slice(0, 140),
        })
      })
    }
  }
}

for (const root of SCAN_ROOTS) walk(join(ROOT, root))

const real = findings.filter((f) => !f.fixture)
const fixtures = findings.filter((f) => f.fixture)

console.log(`Scanned: ${SCAN_ROOTS.join(', ')}`)
console.log(`Total matches: ${findings.length}`)
console.log(`Non-fixture:   ${real.length}`)
console.log(`Fixture:       ${fixtures.length}`)

if (real.length > 0) {
  console.log('\nNON-FIXTURE MATCHES — each needs review:')
  for (const f of real) {
    console.log(`  [${f.rule}] ${f.file}:${f.line}`)
    console.log(`      ${f.excerpt}`)
  }
}

if (fixtures.length > 0) {
  const byRule = {}
  for (const f of fixtures) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
  console.log('\nFIXTURE MATCHES — expected, review and dismiss:')
  for (const [rule, count] of Object.entries(byRule)) console.log(`  ${rule}: ${count}`)
}

console.log(
  '\nThis scan is a review aid, not a control. gitleaks runs in CI. A clean result here ' +
    'means "no obvious literal found", not "no secret present".',
)

process.exit(0)