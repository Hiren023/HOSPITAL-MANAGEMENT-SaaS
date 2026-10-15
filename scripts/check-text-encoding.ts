import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.tmp-test-storage'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|html|json|md|mjs|yml|yaml|css)$/.test(entry)) out.push(full)
  }
  return out
}

// Assembled rather than written literally, so this file does not match itself.
const STALE_BRAND = ['Infinigrow', 'Hospital Cloud'].join(' ')

const files = walk(process.argv[2] ?? '.')
let damaged = 0
let stale = 0

for (const file of files) {
  const text = readFileSync(file, 'utf8')

  // U+FFFD is what a mis-decoded byte becomes. It is a real corruption, not a console
  // artefact — a console artefact is not in the bytes.
  text.split('\n').forEach((line, i) => {
    if (line.includes('\uFFFD')) {
      console.log(`  CORRUPT  ${file}:${i + 1}  ${line.trim().slice(0, 90)}`)
      damaged += 1
    }
  })

  if (text.includes(STALE_BRAND)) {
    console.log(`  STALE    ${file}`)
    stale += 1
  }
}

console.log(`\n${files.length} files scanned. ${damaged} corrupt lines, ${stale} stale files.`)
process.exit(damaged > 0 ? 1 : 0)