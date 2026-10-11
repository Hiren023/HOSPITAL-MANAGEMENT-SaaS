/**
 * End-to-end check of the Phase 4 platform console against a running API.
 *
 * Walks the whole operator journey with real HTTP calls and prints what actually came
 * back, so the console can be verified without opening a browser. Read-mostly: it
 * creates one hospital, which it then approves, suspends and reactivates.
 *
 *   npm run dev:db
 *   npm run dev:api
 *   node scripts/verify-platform-console.mjs
 */

const BASE = process.argv[2] ?? 'http://localhost:4000/api/v1'

const line = (label, value) => console.log(`  ${String(label).padEnd(40)} ${value}`)
const step = (title) => console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`)

const PASSWORD = 'correct-horse-battery-staple'

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* leave null; the status is the signal */
  }

  return { status: response.status, body: json, raw: text }
}

async function main() {
  console.log(`\nPlatform console check against ${BASE}\n${'─'.repeat(78)}`)

  // ── operator signs in ───────────────────────────────────────────────────────
  step('1. Platform operator signs in')

  const login = await call('POST', '/auth/login', {
    body: { email: 'operator@example.test', password: PASSWORD },
  })

  if (login.status !== 200) {
    line('result', `${login.status} ${login.body?.error?.message ?? ''}`)

    if (login.status === 429) {
      // The login limiter allows 10 attempts per 15 minutes and this script spends three
      // of them. Telling the reader to bootstrap an operator would send them hunting for
      // a missing account when the account is present and fine.
      console.log(
        '\n  Rate limited, not misconfigured. The login limiter allows 10 attempts per\n' +
          '  15 minutes; this script uses three of them. Wait for the window, or restart\n' +
          '  the API — the limiter store is in memory and a restart clears it.\n',
      )
    } else {
      console.log('\n  Bootstrap the operator first. See docs/SUPERADMIN-BOOTSTRAP.md\n')
    }

    process.exitCode = 1
    return
  }

  const token = login.body.data.accessToken
  line('role', login.body.data.user.role)
  line('hospitalId', `${login.body.data.user.hospitalId} (null = platform scope)`)
  line('permissions', `${login.body.data.user.permissions.length} granted`)
  line(
    'has report access',
    login.body.data.user.permissions.includes('platform:report:read') ? 'yes' : 'NO — PROBLEM',
  )
  line(
    'has user management',
    login.body.data.user.permissions.includes('platform:user:manage') ? 'yes' : 'NO — PROBLEM',
  )

  // ── overview ───────────────────────────────────────────────────────────────
  step('2. Platform overview')
  const overview = await call('GET', '/platform/overview', { token })
  line('status', `${overview.status}`)
  line('tenants', JSON.stringify(overview.body?.data?.tenants ?? {}))
  line('identity', JSON.stringify(overview.body?.data?.identity ?? {}))
  line(
    'contains patient data?',
    JSON.stringify(overview.body)
      .toLowerCase()
      .match(/patient|diagnos/)
      ? 'YES — PROBLEM'
      : 'no',
  )

  // ── register a hospital ─────────────────────────────────────────────────────
  step('3. Register a hospital (public, no auth)')
  // Unique per run: the email is a unique index, so reusing it returns 409 and every
  // later step would then operate on an undefined hospital id.
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const adminEmail = `admin-${stamp}@console-check.example.test`
  const name = `Console Check Hospital ${stamp}`
  const registration = await call('POST', '/platform/hospitals', {
    body: {
      hospitalName: name,
      registrationNumber: `CC/${stamp}`,
      contactEmail: adminEmail,
      admin: { firstName: 'Console', lastName: 'Check', email: adminEmail, password: PASSWORD },
    },
  })
  const hospitalId = registration.body?.data?.hospitalId
  line('status', `${registration.status} (${registration.body?.data?.status})`)
  line('hospitalId', hospitalId ?? '(none)')

  if (!hospitalId) {
    console.log(`\n  Could not create a tenant: ${registration.body?.error?.message}`)
    console.log('  Later steps cannot run without one.\n')
    process.exitCode = 1
    return
  }

  // ── list, filtered and paged ────────────────────────────────────────────────
  step('4. Tenant list — server-side search and pagination')
  const list = await call('GET', '/platform/hospitals?page=1&pageSize=5&q=Console', { token })
  line('status', `${list.status}`)
  line('returned', `${list.body?.data?.items?.length} of ${list.body?.data?.page?.total} matching`)
  line('totalPages', String(list.body?.data?.page?.totalPages))

  const filtered = await call('GET', '/platform/hospitals?status=PENDING', { token })
  line('status=PENDING', `${filtered.body?.data?.items?.length} pending`)

  const badFilter = await call('GET', '/platform/hospitals?status=NOPE', { token })
  line('status=NOPE', `${badFilter.status} (rejected, not silently ignored)`)

  // ── detail ──────────────────────────────────────────────────────────────────
  step('5. Tenant detail')
  const detail = await call('GET', `/platform/hospitals/${hospitalId}`, { token })
  line('status', `${detail.status}`)
  line('plan', `${detail.body?.data?.plan} (${detail.body?.data?.planLabel})`)
  line('seatLimit', String(detail.body?.data?.seatLimit))

  // ── approve ─────────────────────────────────────────────────────────────────
  step('6. Approve')
  const approve = await call('POST', `/platform/hospitals/${hospitalId}/approve`, { token })
  line('status', `${approve.status} -> ${approve.body?.data?.status}`)

  const tenantLogin = await call('POST', '/auth/login', {
    body: { email: adminEmail, password: PASSWORD },
  })
  line('tenant admin can now sign in', `${tenantLogin.status} (200 = approved correctly)`)

  // ── plan assignment ─────────────────────────────────────────────────────────
  step('7. Assign a subscription plan')
  const plan = await call('PUT', `/platform/hospitals/${hospitalId}/plan`, {
    token,
    body: { plan: 'HOSPITAL', reason: 'Console verification' },
  })
  line('status', `${plan.status} -> ${plan.body?.data?.plan} (${plan.body?.data?.planLabel})`)
  line('seatLimit', String(plan.body?.data?.seatLimit))

  const billing = await call('PUT', `/platform/hospitals/${hospitalId}/plan`, {
    token,
    body: { plan: 'STARTER', cardNumber: '4111111111111111' },
  })
  line('rejects card fields', `${billing.status} (no payment gateway exists)`)

  // ── suspend ─────────────────────────────────────────────────────────────────
  step('8. Suspend — a reason is mandatory')
  const noReason = await call('POST', `/platform/hospitals/${hospitalId}/suspend`, {
    token,
    body: {},
  })
  line('no reason', `${noReason.status} (rejected)`)

  const suspend = await call('POST', `/platform/hospitals/${hospitalId}/suspend`, {
    token,
    body: { reason: 'Console verification of the suspension workflow' },
  })
  line('status', `${suspend.status} -> ${suspend.body?.data?.status}`)

  const blocked = await call('POST', '/auth/login', {
    body: { email: adminEmail, password: PASSWORD },
  })

  // This script signs in repeatedly, so the login rate limiter can fire and answer 429
  // before the suspension check is reached. That is the limiter working, not the
  // suspension — and it means this line proves nothing either way. The behaviour is
  // covered deterministically by `platform.test.ts` -> "stops a suspended hospital from
  // signing in", which asserts 403.
  line(
    'tenant admin sign-in after suspend',
    blocked.status === 429
      ? '429 rate limited — inconclusive here, covered by platform.test.ts'
      : `${blocked.status} (403 = suspension works)`,
  )

  // ── reactivate ──────────────────────────────────────────────────────────────
  step('9. Reactivate')
  const reactivate = await call('POST', `/platform/hospitals/${hospitalId}/reactivate`, {
    token,
    body: { note: 'Console verification complete' },
  })
  line('status', `${reactivate.status} -> ${reactivate.body?.data?.status}`)

  // ── users ───────────────────────────────────────────────────────────────────
  step('10. Tenant user management')
  const users = await call('GET', `/platform/hospitals/${hospitalId}/users`, { token })
  line('status', `${users.status} — ${users.body?.data?.items?.length} staff`)
  line(
    'password hash present?',
    JSON.stringify(users.body).includes('passwordHash') ? 'YES — PROBLEM' : 'no',
  )

  // ── audit ───────────────────────────────────────────────────────────────────
  step('11. Audit trail')
  const audit = await call('GET', '/platform/audit?limit=5', { token })
  line('status', `${audit.status} — ${audit.body?.data?.items?.length} events`)
  for (const event of audit.body?.data?.items?.slice(0, 5) ?? []) {
    line(`  ${event.action}`, event.createdAt)
  }
  const corrupt = await call('GET', '/platform/audit?cursor=not-a-cursor', { token })
  line('corrupt cursor', `${corrupt.status} (degrades to page one, not 500)`)

  // ── reports ─────────────────────────────────────────────────────────────────
  step('12. Operational report')
  const report = await call('GET', '/platform/reports/operational?days=30', { token })
  line('status', `${report.status}`)
  line('tenants', JSON.stringify(report.body?.data?.tenants?.byStatus ?? {}))
  line(
    'contains patient data?',
    JSON.stringify(report.body)
      .toLowerCase()
      .match(/patient|diagnos/)
      ? 'YES — PROBLEM'
      : 'no',
  )
  const tooLong = await call('GET', '/platform/reports/operational?days=99999', { token })
  line('days=99999', `${tooLong.status} (rejected)`)

  // ── the boundary ────────────────────────────────────────────────────────────
  step('13. A hospital user cannot reach any of it')
  const hospitalToken = tenantLogin.body?.data?.accessToken

  if (!hospitalToken) {
    line('result', 'skipped — tenant sign-in failed earlier')
  } else {
    const paths = [
      ['GET', '/platform/overview'],
      ['GET', '/platform/hospitals'],
      ['GET', `/platform/hospitals/${hospitalId}`],
      ['GET', `/platform/hospitals/${hospitalId}/users`],
      ['GET', '/platform/audit'],
      ['GET', '/platform/reports/operational'],
      ['POST', `/platform/hospitals/${hospitalId}/suspend`],
      ['PUT', `/platform/hospitals/${hospitalId}/plan`],
      ['PATCH', '/platform/users/507f1f77bcf86cd799439011/status'],
    ]

    let denied = 0
    for (const [method, path] of paths) {
      // A GET must not carry a body; fetch rejects it outright.
      const response = await call(method, path, {
        token: hospitalToken,
        body:
          method === 'GET'
            ? undefined
            : { reason: 'Attempting a platform action as a hospital user' },
      })
      if (response.status === 403) denied += 1
      else line('LEAK', `${method} ${path} -> ${response.status}`)
    }
    line('routes refused (403)', `${denied} / ${paths.length}`)
  }

  const anon = await call('GET', '/platform/hospitals')
  line('anonymous', `${anon.status} (401 expected)`)

  console.log(`\n${'═'.repeat(78)}\n`)
}

main().catch((error) => {
  console.error('\nCheck failed:', error instanceof Error ? error.message : error)
  console.error('\nIs the API running?  npm run dev:db  then  npm run dev:api\n')
  process.exit(1)
})
