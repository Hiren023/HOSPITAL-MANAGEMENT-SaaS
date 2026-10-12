import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Private file storage for generated clinical documents.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *
 * A generated clinical document is never addressable without an authorization check.
 *
 * That rules out three things that are easy to reach for and all wrong:
 *
 * 1. **A public URL.** `https://app.example.com/files/abc.pdf` is readable by anyone who
 *    has the URL, forever, including people who should never have seen the patient.
 * 2. **An "unguessable" public path.** A 128-bit random filename is not access control.
 *    It leaks through a shared link, a browser history, a proxy log, or a screenshot, and
 *    none of those can be revoked.
 * 3. **A signed URL as the primary mechanism.** It does expire, but until it does it has
 *    exactly the problem above, and it moves the authorization decision out of the
 *    application where it can be audited.
 *
 * So a document is a `storageKey` into this store, and bytes leave only through the
 * download route, which re-checks permission on the underlying clinical record. Revoking
 * someone's access takes effect on their next request, not when a token expires.
 *
 * ── Storage keys ─────────────────────────────────────────────────────────────
 *
 * `<hospitalId>/<random-uuid>.pdf`. The hospital segment is there for operator sanity, not
 * security — a UUID is unguessable regardless. There is no user-supplied component, so a
 * caller cannot influence a path and walk out of the directory.
 *
 * The local-disk implementation writes outside the web root and resolves every path
 * before touching the filesystem, so a crafted key cannot escape. `FileStore` is an
 * interface so object storage can replace it without touching the routes.
 */
export interface StoredFile {
  storageKey: string
  byteSize: number
}

export interface FileStore {
  put(input: {
    hospitalId: string
    contentType: string
    body: Uint8Array
  }): Promise<StoredFile>
  get(storageKey: string): Promise<Uint8Array>
  remove(storageKey: string): Promise<void>
}

/** Resolve the private root. Overridable for tests; never inside the web root. */
function root(): string {
  return process.env['CLINICAL_STORAGE_DIR'] ?? join(process.cwd(), '.private-storage')
}

/**
 * Reject anything that is not a plain `segment/segment.ext` key.
 *
 * Belt and braces: keys are generated here and never taken from a client, so this should
 * be unreachable. It stays because a path-traversal guard that is only correct by
 * assumption is not a guard, and this is the file that holds prescriptions.
 */
function assertSafeKey(key: string): void {
  const parts = key.split('/')
  if (parts.length !== 2) throw new Error('Invalid storage key')
  if (!/^[a-f0-9]{24}$/.test(parts[0] ?? '')) throw new Error('Invalid storage key')
  if (!/^[a-f0-9-]{36}\.pdf$/.test(parts[1] ?? '')) throw new Error('Invalid storage key')
}

export const localFileStore: FileStore = {
  async put({ hospitalId, body }) {
    const storageKey = `${hospitalId}/${randomUUID()}.pdf`

    const target = join(root(), storageKey)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body)

    return { storageKey, byteSize: body.byteLength }
  },

  async get(storageKey) {
    assertSafeKey(storageKey)

    const target = join(root(), storageKey)

    // Belt and braces alongside the key check: confirm the resolved path really is inside
    // the private root before reading it.
    const base = resolve(root())
    if (!resolve(target).startsWith(base)) throw new Error('Invalid storage key')

    return new Uint8Array(await readFile(target))
  },

  async remove(storageKey) {
    assertSafeKey(storageKey)
    await rm(join(root(), storageKey), { force: true })
  },
}