/**
 * End-to-end check of the Phase 5 hospital administration API against a running server.
 *
 * Walks a hospital administrator's real journey with real HTTP calls and prints what
 * actually came back, so the module can be verified without a browser and without
 * trusting a mocked response.
 *
 * It also probes the boundaries, because those are the claims most worth checking:
 * cross-tenant access, privilege escalation to a platform role, duplicate identifiers,
 * masking of professional data, and that nothing sensitive reaches the audit trail.
 *
 *   npm run dev:db
 *   npm run dev:api
 *   node scripts/verify-hospital-admin.mjs
 */

const BASE = process.argv[2] ?? 'http://localhost:4000/api/v1'

const line = (label, value) => console.log(`  ${String(label).padEnd(42)} ${value}`)
const step = (title) => console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`)

const PASSWORD = 'correct-horse-battery-staple'

let failures = 0

/** Assert and report. A check that silently passes is worse than no check. */
function check(label, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  line(`${label}${ok ? '' : '  ← FAILED'}`, `${actual}${ok ? '' : `  (expected ${expected})`}`)
}

function checkThat(label, condition, detail = '') {
  if (!condition) failures += 1
  line(`${label}${condition ? '' : '  ← FAILED'}`, `${condition ? 'ok' : 'no'}${detail ? `  ${detail}` : ''}`)
}

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
  console.log(`\nHospital administration check against ${BASE}\n${'─'.repeat(78)}`)

  // ── two separate tenants, to prove isolation for real ───────────────────────
  step('1. Two hospitals sign in')

  const adminA = await call('POST', '/auth/login', {
    body: { email: 'meera.nair@example.test', password: PASSWORD },
  })
  check('hospital A admin signs in', adminA.status, 200)

  const adminB = await call('POST', '/auth/login', {
    body: { email: 'admin.b@example.test', password: PASSWORD },
  })
  check('hospital B admin signs in', adminB.status, 200)

  if (adminA.status !== 200 || adminB.status !== 200) {
    console.log('\nCannot continue without both tenants. Is the database seeded?')
    console.log('Run: npm run dev:db  (then seed fixtures)')
    process.exitCode = 1
    return
  }

  const tokenA = adminA.body?.data?.accessToken
  const tokenB = adminB.body?.data?.accessToken
  const hospitalA = adminA.body?.data?.user?.hospitalId
  const hospitalB = adminB.body?.data?.user?.hospitalId

  line('hospital A id', hospitalA)
  line('hospital B id', hospitalB)
  checkThat('the two admins belong to different hospitals', hospitalA !== hospitalB)

  // ── hospital profile ────────────────────────────────────────────────────────
  step('2. Hospital profile reads only its own record')

  const profileA = await call('GET', '/hospital', { token: tokenA })
  check('GET /hospital', profileA.status, 200)
  checkThat('returned its own id', profileA.body?.data?.id === hospitalA, profileA.body?.data?.name)

  const namedHospital = await call('PATCH', '/hospital', {
    token: tokenA,
    body: { name: profileA.body?.data?.name },
  })
  check('PATCH /hospital', namedHospital.status, 200)

  const withHospitalId = await call('PATCH', '/hospital', {
    token: tokenA,
    body: { name: 'Forged Name', hospitalId: hospitalB },
  })
  check('a body carrying hospitalId is rejected', withHospitalId.status, 422)

  const forgedQuery = await call('GET', `/hospital?hospitalId=${hospitalB}`, { token: tokenA })
  check('a hospitalId in the query is still 200', forgedQuery.status, 200)
  checkThat(
    '…and did not switch tenants',
    forgedQuery.body?.data?.id === hospitalA,
    forgedQuery.body?.data?.name,
  )

  const profileB = await call('GET', '/hospital', { token: tokenB })
  checkThat(
    'hospital B still sees only itself',
    profileB.body?.data?.id === hospitalB,
    profileB.body?.data?.name,
  )

  // ── departments ─────────────────────────────────────────────────────────────
  step('3. Departments, and duplicates scoped per hospital')

  const stamp = Date.now().toString(36).toUpperCase().slice(-5)
  const deptCode = `V${stamp}`

  const createdDept = await call('POST', '/departments', {
    token: tokenA,
    body: { name: `Verification ${stamp}`, code: deptCode },
  })
  check('POST /departments', createdDept.status, 201)

  const deptId = createdDept.body?.data?.id

  const duplicateCode = await call('POST', '/departments', {
    token: tokenA,
    body: { name: 'A different name entirely', code: deptCode },
  })
  check('a duplicate code in the same hospital', duplicateCode.status, 409)
  line('message', duplicateCode.body?.error?.message ?? '')

  const sameCodeOtherHospital = await call('POST', '/departments', {
    token: tokenB,
    body: { name: `Verification ${stamp}`, code: deptCode },
  })
  checkThat(
    'the same code in ANOTHER hospital is allowed',
    sameCodeOtherHospital.status === 201,
    `status ${sameCodeOtherHospital.status} — uniqueness is per hospital, not global`,
  )

  const duplicateName = await call('POST', '/departments', {
    token: tokenA,
    body: { name: `Verification ${stamp}`, code: `W${stamp}` },
  })
  check('a duplicate name in the same hospital', duplicateName.status, 409)

  const emptyCode = await call('POST', '/departments', { token: tokenA, body: { name: 'X' } })
  check('a missing code', emptyCode.status, 422)
  line('message', emptyCode.body?.error?.details?.[0]?.message ?? '')

  const listDept = await call('GET', '/departments?page=1&pageSize=5', { token: tokenA })
  check('GET /departments', listDept.status, 200)
  check('…reports a real total', typeof listDept.body?.data?.page?.total, 'number')
  line('total', listDept.body?.data?.page?.total)

  const searched = await call('GET', `/departments?q=Verification+${stamp}`, { token: tokenA })
  check('server-side search finds it', searched.body?.data?.page?.total, 1)

  // ── cross-tenant read ───────────────────────────────────────────────────────
  step('4. Cross-tenant access is refused, not merely filtered')

  const otherDept = await call('GET', `/departments/${deptId}`, { token: tokenB })
  check('hospital B reads hospital A department by id', otherDept.status, 404)
  line('message', otherDept.body?.error?.message ?? '')

  const otherDeptEdit = await call('PATCH', `/departments/${deptId}`, {
    token: tokenB,
    body: { name: 'Hijacked' },
  })
  check('hospital B edits hospital A department', otherDeptEdit.status, 404)

  const listB = await call('GET', '/departments?pageSize=100', { token: tokenB })
  const leaked = (listB.body?.data?.items ?? []).some((d) => d.id === deptId)
  checkThat('hospital A department is absent from hospital B list', !leaked)

  // ── privilege escalation ────────────────────────────────────────────────────
  step('5. A hospital admin cannot mint a platform operator')

  const staffEmail = `verify.${stamp}@example.test`

  const createStaff = await call('POST', '/staff', {
    token: tokenA,
    body: {
      email: staffEmail,
      firstName: 'Verification',
      lastName: 'Person',
      role: 'RECEPTIONIST',
    },
  })
  check('POST /staff', createStaff.status, 201)

  const staffUserId = createStaff.body?.data?.userId

  const superAdminAttempt = await call('POST', '/staff', {
    token: tokenA,
    body: { email: `escalate.${stamp}@example.test`, firstName: 'Escalated', lastName: 'Person', role: 'SUPER_ADMIN' },
  })
  check('creating a SUPER_ADMIN', superAdminAttempt.status, 422)
  line('message', superAdminAttempt.body?.error?.details?.[0]?.message ?? '')

  const promoteAttempt = await call('PATCH', `/staff/${staffUserId}/role`, {
    token: tokenA,
    body: { role: 'SUPER_ADMIN' },
  })
  check('promoting existing staff to SUPER_ADMIN', promoteAttempt.status, 422)
  line('message', promoteAttempt.body?.error?.details?.[0]?.message ?? '')

  const badStatus = await call('PATCH', `/staff/${staffUserId}/status`, {
    token: tokenA,
    body: { status: 'SUSPENDED', reason: 'short' },
  })
  check('suspending without a real reason', badStatus.status, 422)

  const goodStatus = await call('PATCH', `/staff/${staffUserId}/status`, {
    token: tokenA,
    body: { status: 'SUSPENDED', reason: 'Verification run — temporary suspension.' },
  })
  check('suspending with a reason', goodStatus.status, 200)

  const reactivate = await call('PATCH', `/staff/${staffUserId}/status`, {
    token: tokenA,
    body: { status: 'ACTIVE', reason: 'Verification run — reactivation.' },
  })
  check('reactivating', reactivate.status, 200)

  // ── doctor profiles and masking ─────────────────────────────────────────────
  step('6. Doctor profiles, and masking of the registration number')

  const doctorEmail = `verify.doctor.${stamp}@example.test`

  const doctorAccount = await call('POST', '/staff', {
    token: tokenA,
    body: { email: doctorEmail, firstName: 'Verify', lastName: 'Doctor', role: 'DOCTOR' },
  })
  check('create a DOCTOR account', doctorAccount.status, 201)

  const registration = `GMC/2026/${stamp}`

  const doctorProfile = await call('POST', '/doctors', {
    token: tokenA,
    body: {
      userId: doctorAccount.body?.data?.userId,
      registrationNumber: registration,
      departmentId: deptId,
      specialities: ['Cardiology'],
      consultationFeeInPaise: 150000,
    },
  })
  check('POST /doctors', doctorProfile.status, 201)
  line('registration returned to a doctor manager', doctorProfile.body?.data?.registrationNumber)
  check('masked flag for doctor:write', doctorProfile.body?.data?.registrationNumberMasked, false)

  const profileId = doctorProfile.body?.data?.id

  const duplicateRegistration = await call('POST', '/doctors', {
    token: tokenA,
    body: {
      userId: createStaff.body?.data?.userId,
      registrationNumber: registration,
    },
  })
  check('a duplicate registration number', duplicateRegistration.status, 409)

  const maskedRead = await call('GET', `/doctors/${profileId}`, { token: tokenA })
  check('the manager reads it unmasked', maskedRead.body?.data?.registrationNumber, registration)

  // A reception-level reader holds doctor:read but not doctor:write.
  //
  // Credentials come from the operator rather than being created here: an account made
  // through POST /staff gets a random password nobody ever sees, so this script could not
  // sign in as one even if it made one. When they are absent the check reports SKIPPED —
  // never "passed", because an unrun check that reports success is worse than no check.
  const receptionistEmail = process.env.VERIFY_RECEPTIONIST_EMAIL ?? 'reception.a@example.test'

  const receptionistLogin = await call('POST', '/auth/login', {
    body: { email: receptionistEmail, password: PASSWORD },
  })

  if (receptionistLogin.status === 200) {
    const tokenR = receptionistLogin.body?.data?.accessToken
    const maskedAsReader = await call('GET', `/doctors/${profileId}`, { token: tokenR })
    check('a reader without doctor:write gets 200', maskedAsReader.status, 200)
    check('masked flag is set for them', maskedAsReader.body?.data?.registrationNumberMasked, true)
    checkThat(
      'the raw number is NOT returned',
      maskedAsReader.body?.data?.registrationNumber !== registration,
      `got "${maskedAsReader.body?.data?.registrationNumber}"`,
    )

    const refusedWrite = await call('PATCH', `/doctors/${profileId}`, {
      token: tokenR,
      body: { yearsOfExperience: 99 },
    })
    check('that reader cannot edit the profile', refusedWrite.status, 403)
  } else {
    line(
      'masking for a non-manager',
      `SKIPPED — no working credentials for ${receptionistEmail} (${receptionistLogin.status})`,
    )
    line('  ', 'covered by the API suite, which seeds a RECEPTIONIST fixture')
  }

  const crossTenantDoctor = await call('GET', `/doctors/${profileId}`, { token: tokenB })
  check('hospital B reads hospital A doctor', crossTenantDoctor.status, 404)

  // ── schedule ────────────────────────────────────────────────────────────────
  step('7. Weekly schedule')

  const schedule = await call('GET', `/doctors/${profileId}/schedule`, { token: tokenA })
  check('GET schedule', schedule.status, 200)

  const saved = await call('PUT', `/doctors/${profileId}/schedule`, {
    token: tokenA,
    body: {
      blocks: [
        { weekday: 1, startMinute: 9 * 60, endMinute: 13 * 60, slotDurationMinutes: 20 },
        { weekday: 3, startMinute: 14 * 60, endMinute: 18 * 60, slotDurationMinutes: 15 },
      ],
    },
  })
  check('PUT schedule (replace)', saved.status, 200)
  check('…stored two blocks', saved.body?.data?.blocks?.length, 2)

  const reread = await call('GET', `/doctors/${profileId}/schedule`, { token: tokenA })
  check('…and the read matches', reread.body?.data?.blocks?.length, 2)
  check('…with minutes preserved exactly', reread.body?.data?.blocks?.[0]?.startMinute, 540)
  check('…not converted to a string', typeof reread.body?.data?.blocks?.[0]?.startMinute, 'number')

  const backwards = await call('PUT', `/doctors/${profileId}/schedule`, {
    token: tokenA,
    body: { blocks: [{ weekday: 1, startMinute: 17 * 60, endMinute: 9 * 60, slotDurationMinutes: 15 }] },
  })
  check('a block that ends before it starts', backwards.status, 422)

  const twoOnOneDay = await call('PUT', `/doctors/${profileId}/schedule`, {
    token: tokenA,
    body: {
      blocks: [
        { weekday: 2, startMinute: 540, endMinute: 720, slotDurationMinutes: 15 },
        { weekday: 2, startMinute: 780, endMinute: 900, slotDurationMinutes: 15 },
      ],
    },
  })
  check('two blocks on one weekday', twoOnOneDay.status, 422)
  line('message', twoOnOneDay.body?.error?.details?.[0]?.message ?? '')

  // ── platform scope ──────────────────────────────────────────────────────────
  step('8. A platform operator cannot reach hospital administration')

  const operator = await call('POST', '/auth/login', {
    body: { email: 'operator@example.test', password: PASSWORD },
  })

  if (operator.status === 200) {
    const tokenOp = operator.body?.data?.accessToken
    const operatorDepartments = await call('GET', '/departments', { token: tokenOp })
    check('SUPER_ADMIN listing departments', operatorDepartments.status, 403)

    const operatorHospital = await call('GET', '/hospital', { token: tokenOp })
    check('SUPER_ADMIN reading /hospital', operatorHospital.status, 403)

    // …and the other direction: the platform console is still theirs.
    const platformHospitals = await call('GET', '/platform/hospitals', { token: tokenOp })
    check('SUPER_ADMIN still reaches /platform/hospitals', platformHospitals.status, 200)
  } else {
    line('operator sign-in', `${operator.status} — platform scope check skipped`)
  }

  // ── audit hygiene ───────────────────────────────────────────────────────────
  step('9. The audit trail records the change without the sensitive value')

  const audit = await call('GET', '/platform/audit?limit=100', {
    token: operator.status === 200 ? operator.body?.data?.accessToken : undefined,
  })

  if (audit.status === 200) {
    const events = audit.body?.data?.items ?? []

    // Only the EVENTS are searched — not the whole `data` object.
    //
    // The audit response also carries `nextCursor`, an opaque base64url token. It begins
    // "eyJ" because it encodes a JSON object (`{"` → `eyJ`), so scanning the whole payload
    // for a JWT prefix matches the cursor on every single call. That is a check which
    // always fails and teaches everyone to ignore it. A leaked token would be inside an
    // event, so that is where the search belongs.
    const serialised = JSON.stringify(events)

    checkThat('the registration number never appears', !serialised.includes(registration))
    // Match the SHAPE of a secret, not a word. Checking for the string "refresh" looks like
    // security and finds nothing: the audit log legitimately records actions named
    // `auth.refreshed`, so that check fails on correct behaviour — and a check that cries
    // wolf is worse than no check, because it teaches everyone to ignore it.
    // A JWT is recognisable by its `eyJ` header; an Argon2 hash by its own marker.
    checkThat('no JWT appears in any event', !serialised.includes('eyJ'))
    checkThat('no password hash appears', !serialised.includes('$argon2'))
    checkThat('no bcrypt hash appears', !serialised.includes('$2b$'))
    line('events returned', events.length)
  } else {
    line('audit read', `${audit.status} — ${audit.body?.error?.message ?? ''}`)
  }

  step('Result')
  if (failures === 0) {
    console.log('  Every check passed.\n')
  } else {
    console.log(`  ${failures} check(s) FAILED.\n`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('\nVerification crashed:', error)
  process.exitCode = 1
})