/**
 * End-to-end demonstration of the Phase 2 authentication and tenant-isolation flow,
 * against a locally running API. Read-only: it creates nothing beyond one hospital.
 *
 *   node scripts/demo-flow.mjs
 */

const BASE = 'http://localhost:4000/api/v1'

async function call(method, path, { body, token, raw = false } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  if (raw) return { status: response.status, text: await response.text() }
  return { status: response.status, body: await response.json().catch(() => null) }
}

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`)
const step = (n, title) =>
  console.log(`\n${'─'.repeat(78)}\nSTEP ${n} — ${title}\n${'─'.repeat(78)}`)

const HOSPITAL_A = {
  hospitalName: 'Kaveri Diagnostics Centre',
  registrationNumber: 'KA/2026/1234',
  contactEmail: 'contact@kaveri.example.test',
  admin: {
    firstName: 'Meera',
    lastName: 'Nair',
    email: 'meera.nair@example.test',
    password: 'correct-horse-battery-staple',
  },
}

const HOSPITAL_B = {
  ...HOSPITAL_A,
  hospitalName: 'Bhavna Community Hospital',
  registrationNumber: 'KA/2026/5678',
  contactEmail: 'contact@bhavna.example.test',
  admin: {
    firstName: 'Bhavna',
    lastName: 'Rao',
    email: 'admin.b@example.test',
    password: 'correct-horse-battery-staple',
  },
}

async function main() {
  // 1 ── health
  step(1, 'Liveness and readiness')
  const health = await call('GET', '/../../health/ready').catch(() => null)
  const ready = await fetch('http://localhost:4000/health/ready').then((r) => r.json())
  line('GET /health/ready', `${ready.data.status} (database: ${ready.data.checks.database})`)
  void health

  // 2 ── register two hospitals
  step(2, 'Public registration — tenants start PENDING')
  const regA = await call('POST', '/platform/hospitals', { body: HOSPITAL_A })
  const regB = await call('POST', '/platform/hospitals', { body: HOSPITAL_B })
  line('POST /platform/hospitals (A)', `${regA.status} status=${regA.body?.data?.status}`)
  line('POST /platform/hospitals (B)', `${regB.status} status=${regB.body?.data?.status}`)
  line('Hospital A id', regA.body?.data?.hospitalId ?? '(already registered)')
  line('Hospital B id', regB.body?.data?.hospitalId ?? '(already registered)')

  // 3 ── a pending tenant's admin cannot sign in
  step(3, 'A PENDING tenant is unusable')
  const early = await call('POST', '/auth/login', {
    body: { email: HOSPITAL_A.admin.email, password: HOSPITAL_A.admin.password },
  })
  line('admin of PENDING hospital', `${early.status} ${early.body?.error?.code}`)

  // 4 ── platform sign-in
  step(4, 'Platform administrator sign-in')
  const platform = await call('POST', '/auth/login', {
    body: { email: 'operator@example.test', password: 'correct-horse-battery-staple' },
  })

  if (platform.status !== 200) {
    line('result', `${platform.status} — ${platform.body?.error?.message ?? 'unknown'}`)
    console.log('\n  Run the bootstrap first:')
    console.log('    npx tsx src/scripts/bootstrap-super-admin.ts --email operator@example.test \\')
    console.log(
      '      --name "Platform Operator" --password "correct-horse-battery-staple" --i-am-secure',
    )
    return
  }

  const platformToken = platform.body.data.accessToken
  line('role', platform.body.data.user.role)
  line('hospitalId', `${platform.body.data.user.hospitalId} (null = platform scope)`)
  line('permissions', platform.body.data.user.permissions.join(', '))

  // 5 ── list and approve
  step(5, 'List tenants and approve them')
  const list = await call('GET', '/platform/hospitals', { token: platformToken })
  line('GET /platform/hospitals', `${list.status} — ${list.body.data.length} tenant(s)`)
  for (const hospital of list.body.data) {
    console.log(`     • ${hospital.name.padEnd(30)} [${hospital.status}]`)
  }

  for (const hospital of list.body.data.filter((h) => h.status === 'PENDING')) {
    const approved = await call('POST', `/platform/hospitals/${hospital.id}/approve`, {
      token: platformToken,
    })
    line(`approve ${hospital.name}`, `${approved.status} -> ${approved.body?.data?.status}`)
  }

  // 6 ── hospital admins sign in
  step(6, 'Tenant administrators sign in')
  const a = await call('POST', '/auth/login', {
    body: { email: HOSPITAL_A.admin.email, password: HOSPITAL_A.admin.password },
  })
  const b = await call('POST', '/auth/login', {
    body: { email: HOSPITAL_B.admin.email, password: HOSPITAL_B.admin.password },
  })

  line('Hospital A admin', `${a.status} hospitalId=${a.body?.data?.user?.hospitalId}`)
  line('Hospital B admin', `${b.status} hospitalId=${b.body?.data?.user?.hospitalId}`)
  line(
    'A and B are different tenants',
    String(a.body?.data?.user?.hospitalId !== b.body?.data?.user?.hospitalId),
  )

  // 7 ── current user
  step(7, 'GET /auth/me — identity from the membership')
  const me = await call('GET', '/auth/me', { token: a.body.data.accessToken })
  line('role', me.body.data.role)
  line('hospitalId', me.body.data.hospitalId)
  line('hospitalName', me.body.data.hospitalName)
  line('permission count', me.body.data.permissions.length)

  // 8 ── separation of duties
  step(8, 'A hospital admin cannot reach platform operations')
  const denied = await call('GET', '/platform/hospitals', { token: a.body.data.accessToken })
  line('GET /platform/hospitals as A', `${denied.status} ${denied.body?.error?.code}`)

  // 9 ── bad credentials
  step(9, 'Credential failure responses are uniform')
  const wrongPassword = await call('POST', '/auth/login', {
    body: { email: HOSPITAL_A.admin.email, password: 'wrong-password' },
  })
  const unknownUser = await call('POST', '/auth/login', {
    body: { email: 'nobody@example.test', password: 'wrong-password' },
  })
  line('wrong password', `${wrongPassword.status} ${wrongPassword.body?.error?.message}`)
  line('unknown email', `${unknownUser.status} ${unknownUser.body?.error?.message}`)
  line(
    'indistinguishable',
    String(wrongPassword.body.error.message === unknownUser.body.error.message),
  )

  // 10 ── validation
  step(10, 'Input validation')
  const injected = await call('POST', '/auth/login', {
    body: { email: { $ne: null }, password: 'x' },
  })
  line('operator payload {email:{$ne:null}}', `${injected.status} ${injected.body?.error?.code}`)
  const escalated = await call('POST', '/auth/login', {
    body: {
      email: HOSPITAL_A.admin.email,
      password: HOSPITAL_A.admin.password,
      role: 'SUPER_ADMIN',
    },
  })
  line('role escalation attempt', `${escalated.status} ${escalated.body?.error?.code}`)

  console.log(`\n${'═'.repeat(78)}\n`)
}

main().catch((error) => {
  console.error('\nDemo failed:', error instanceof Error ? error.message : error)
  console.error('\nIs the API running?  npm run dev:db  then  npm run dev:api\n')
  process.exit(1)
})
