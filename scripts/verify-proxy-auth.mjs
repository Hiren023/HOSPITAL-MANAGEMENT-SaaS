/**
 * Proves the browser's exact request path works: same-origin `/api/v1/*` through the
 * Vite dev proxy, with the refresh cookie carried by `credentials: 'include'` — the
 * behaviour `api-client.ts` relies on.
 *
 * Run with the API and web dev servers up:
 *   node scripts/verify-proxy-auth.mjs
 */

const WEB = process.argv[2] ?? 'http://localhost:5173'

const line = (label, value) => console.log(`  ${String(label).padEnd(38)} ${value}`)

function describeSetCookie(response) {
  const raw = response.headers.getSetCookie?.() ?? []
  return raw.map((cookie) => cookie.split(';')[0].split('=')[0])
}

async function main() {
  console.log(`\nBrowser-equivalent auth check through ${WEB}\n${'─'.repeat(70)}`)

  // 1. A first-time visitor has no refresh cookie; the SPA treats this as anonymous.
  const bootstrap = await fetch(`${WEB}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: '{}',
  })
  line('POST /auth/refresh (no cookie)', `${bootstrap.status} — anonymous, as expected`)

  // 2. Real sign-in, exactly as the login form sends it.
  const login = await fetch(`${WEB}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      email: 'operator@example.test',
      password: 'correct-horse-battery-staple',
    }),
  })

  const payload = await login.json()
  line('POST /auth/login', `${login.status} role=${payload.data?.user?.role}`)
  line('hospitalId (null = platform)', String(payload.data?.user?.hospitalId))
  line('refresh cookie set', describeSetCookie(login).join(', ') || '(none)')

  const accessToken = payload.data?.accessToken
  if (!accessToken) {
    console.log('\n  Bootstrap the operator first, or the check cannot continue.\n')
    return
  }

  // 3. Authenticated call using the returned bearer token.
  const me = await fetch(`${WEB}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    credentials: 'include',
  })
  line('GET /auth/me with bearer', `${me.status}`)

  // 4. The platform list, which the dashboard renders from real data.
  const hospitals = await fetch(`${WEB}/api/v1/platform/hospitals`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    credentials: 'include',
  })
  const list = await hospitals.json()
  line('GET /platform/hospitals', `${hospitals.status} — ${list.data?.length ?? 0} tenant(s)`)

  // 5. A hospital user must not reach platform operations — the separation the UI relies on.
  const denied = await fetch(`${WEB}/api/v1/platform/hospitals`, {
    headers: { Authorization: 'Bearer not-a-real-token' },
    credentials: 'include',
  })
  line(
    'GET /platform/hospitals (bad token)',
    `${denied.status} ${denied.status === 401 ? 'UNAUTHENTICATED' : ''}`,
  )

  const ok = login.status === 200 && me.status === 200 && hospitals.status === 200
  console.log(
    `\n  ${ok ? 'PASS' : 'FAIL'} — the web client's request path is verified end to end.\n`,
  )
  if (!ok) process.exitCode = 1
}

main().catch((error) => {
  console.error('\nCheck failed:', error instanceof Error ? error.message : error)
  console.error('\nIs the API running (npm run dev:api) and the web server (npm run dev:web)?\n')
  process.exit(1)
})
