import supertest from 'supertest'
import type { Express } from 'express'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Types, type Model } from 'mongoose'

import {
  connectTestDatabase,
  createPlatformFixture,
  installTestJwtKeys,
  resetDatabase,
  type PlatformFixture,
} from './auth-harness.js'
import { tryStartTestDatabase } from './mongo.js'

const db = await tryStartTestDatabase()

/**
 * Phase 8 — billing and reporting.
 *
 * Two hospitals, so cross-tenant assertions are real rather than notional.
 *
 * Every record here is fictional. No real financial data, and no real patient data.
 *
 * What these tests are actually for:
 *
 * - **Calculations.** That a total is the sum of its own lines, that the server's figure
 *   wins over anything a client says, and that rounding does not move money between lines.
 * - **Duplicate requests.** That a retried payment is a replay and not a second charge, and
 *   that the same key with a DIFFERENT payload is refused rather than silently replayed.
 * - **Permissions.** That a doctor cannot reach revenue, that reception cannot record a
 *   payment, and that a second hospital cannot read this one's invoices.
 * - **Refunds and adjustments.** That a refund is a new signed record rather than a
 *   mutation, and that it cannot exceed what was actually taken.
 */

const TEST_PASSWORD = 'correct-horse-battery-staple'
const API = '/api/v1'

type Row = Record<string, unknown>

describe.skipIf(!db.uri)('billing and reporting', () => {
  let fixture: PlatformFixture
  let app: () => Express
  let patientId: string
  let serviceId: string

  const as = (email: string) => fixture.signIn(email, TEST_PASSWORD)
  /**
   * Seeding uses an ADMINISTRATOR on purpose.
   *
   * ACCOUNTANT holds `billing:*` and `payment:*` but NOT `patient:write` — billing staff
   * can attach a charge to the right person without being able to register new ones. Every
   * billing assertion below is therefore made as an accountant against data an
   * administrator created, which is the real division of work rather than a convenience.
   */
  const asAdmin = () => as('admin-a@example.test')

  /**
   * An ACCOUNTANT, which the shared fixture does not provide.
   *
   * It is worth creating rather than reusing the admin: ACCOUNTANT is the only role whose
   * billing permission set is deliberately different from HOSPITAL_ADMIN's in spirit —
   * money without control of the hospital. Testing billing only against an admin would
   * miss any place the two were conflated.
   */
  const asAccountant = () => fixture.signIn('accountant-a@example.test', TEST_PASSWORD)
  const asDoctor = () => as('doctor-a@example.test')
  const asReception = () => as('reception-a@example.test')
  const asOther = () => as('admin-b@example.test')

  beforeAll(async () => {
    installTestJwtKeys()
    await connectTestDatabase(db.uri as string)
    const mod = await import('../app.js')
    app = mod.createApp

    process.env['CLINICAL_STORAGE_DIR'] = process.env['CLINICAL_STORAGE_DIR'] ?? '.tmp-test-storage'
  })

  /** Create a user with a membership in hospital A. */
  async function makeMember(email: string, role: string, first: string): Promise<void> {
    const { hashPassword } = await import('../modules/identity/password.util.js')
    const { UserModel, MembershipModel } = await import('../modules/identity/models.js')

    const created = await (UserModel as unknown as Model<Row>).create({
      email,
      passwordHash: await hashPassword(TEST_PASSWORD),
      firstName: first,
      lastName: 'Fictional',
      status: 'ACTIVE',
      emailVerified: true,
      platformRole: null,
      locale: 'en-IN',
    })

    await (MembershipModel as unknown as Model<Row>).create({
      userId: created['_id'],
      hospitalId: fixture.hospitalA.id,
      role,
      grantedPermissions: [],
      status: 'ACTIVE',
      joinedAt: new Date(),
    })
  }

  beforeEach(async () => {
    await resetDatabase()
    fixture = await createPlatformFixture()
    await makeMember('accountant-a@example.test', 'ACCOUNTANT', 'Devika')

    const token = await asAdmin()

    const patient = await supertest(app())
      .post(`${API}/patients`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'Riya',
        lastName: 'Testpatient',
        dateOfBirth: '1988-03-11',
        phone: '+91 90000 00000',
      })
    if (patient.status !== 201) {
      throw new Error('seed patient -> ' + patient.status + ' ' + JSON.stringify(patient.body))
    }
    patientId = patient.body.data.id

    const service = await supertest(app())
      .post(`${API}/services`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'CONS',
        name: 'General consultation',
        category: 'CONSULTATION',
        unitPriceMinor: 50_000,
        taxBps: 1800,
      })
    if (service.status !== 201) {
      throw new Error('seed service -> ' + service.status + ' ' + JSON.stringify(service.body))
    }
    serviceId = service.body.data.id
  })

  /** Create and issue an invoice with the given lines. */
  async function invoice(token: string, lines?: Row[]) {
    const created = await supertest(app())
      .post(`${API}/invoices`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        patientId,
        lines:
          lines ?? [{ serviceId, quantity: 2 }],
      })

    expect(created.status, 'create invoice').toBe(201)

    const issued = await supertest(app())
      .post(`${API}/invoices/${created.body.data.id}/issue`)
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(issued.status, 'issue invoice').toBe(200)
    return issued.body.data as Row
  }

  // ───────────────────────── calculations ─────────────────────────

  describe('invoice arithmetic', () => {
    it('computes the total server-side from the lines', async () => {
      const bill = await invoice(await asAccountant(), [
        { serviceId, quantity: 2 }, // 1000.00
        { description: 'Dressing', unitPriceMinor: 12_345, quantity: 1 },
      ])

      // 2 × 500.00 = 1000.00, plus 123.45. Tax comes from the catalogue, so only the
      // consultation line carries 18% — the ad-hoc dressing line has no rate configured.
      expect(bill.subtotalMinor).toBe(112_345)
      expect(bill.taxMinor).toBe(18_000)
      expect(bill.totalMinor).toBe(130_345)
    })

    it('makes the total exactly the sum of its printed lines', async () => {
      const bill = await invoice(await asAccountant(), [
        { description: 'A', unitPriceMinor: 333, quantity: 3 },
        { description: 'B', unitPriceMinor: 101, quantity: 7 },
        { description: 'C', unitPriceMinor: 5, quantity: 11 },
      ])

      const sum = (bill.lines as Row[]).reduce((total, line) => total + Number(line.totalMinor), 0)

      // An invoice that does not add up to itself is not a credible document.
      expect(bill.totalMinor).toBe(sum)
    })

    it('applies a discount before tax, not after', async () => {
      const bill = await invoice(await asAccountant(), [
        { serviceId, quantity: 1, discountBps: 1000 }, // 10% off 500.00
      ])

      expect(bill.discountMinor).toBe(5_000)
      // Tax is charged on 450.00, not on 500.00.
      expect(bill.taxableMinor).toBe(45_000)
      expect(bill.taxMinor).toBe(8_100)
      expect(bill.totalMinor).toBe(53_100)
    })

    it('refuses a total sent by the client, because it cannot be sent', async () => {
      const res = await supertest(app())
        .post(`${API}/invoices`)
        .set('Authorization', `Bearer ${await asAccountant()}`)
        .send({
          patientId,
          lines: [{ serviceId, quantity: 1 }],
          totalMinor: 1,
        })

      // The strongest form of "never trust the frontend's total" is making it
      // unrepresentable. A schema that accepted and ignored it would invite somebody to
      // "fix" it by using the client's value.
      expect(res.status).toBe(422)
    })

    it('refuses a fractional or non-finite amount', async () => {
      const res = await supertest(app())
        .post(`${API}/invoices`)
        .set('Authorization', `Bearer ${await asAccountant()}`)
        .send({
          patientId,
          lines: [{ description: 'Float attempt', unitPriceMinor: 100.5, quantity: 1 }],
        })

      expect(res.status).toBe(422)
    })

    it('takes a price from the catalogue but records an explicit override', async () => {
      const bill = await invoice(await asAccountant(), [
        { serviceId, unitPriceMinor: 40_000, quantity: 1 },
      ])

      const line = (bill.lines as Row[])[0]!
      // The override is allowed — a hospital discounts — but it is not silent: the code
      // and description from the catalogue stay on the line so it still reconciles.
      expect(line.unitPriceMinor).toBe(40_000)
      expect(line.code).toBe('CONS')
      expect(line.description).toBe('General consultation')
    })

    it('refuses a service from another hospital', async () => {
      const res = await supertest(app())
        .post(`${API}/invoices`)
        .set('Authorization', `Bearer ${await asOther()}`)
        .send({
          patientId,
          lines: [{ serviceId, quantity: 1 }],
        })

      expect(res.status).toBe(404)
    })

    it('allocates invoice numbers in sequence', async () => {
      const token = await asAdmin()

      const first = await invoice(token)
      const second = await invoice(token)

      expect(first.number).toMatch(/^INV-\d{6}$/)
      expect(Number(String(second.number).slice(4))).toBeGreaterThan(Number(String(first.number).slice(4)))
    })

    it('does not reuse an invoice number across hospitals', async () => {
      const mine = await invoice(await asAccountant())

      const otherPatient = await supertest(app())
        .post(`${API}/patients`)
        .set('Authorization', `Bearer ${await asOther()}`)
        .send({ firstName: 'Other', lastName: 'Test', dateOfBirth: '1990-01-01', phone: '+919000000001' })

      const theirServiceId = await otherServiceId(await asOther())

      const theirs = await supertest(app())
        .post(`${API}/invoices`)
        .set('Authorization', `Bearer ${await asOther()}`)
        .send({
          patientId: otherPatient.body.data.id,
          lines: [{ serviceId: theirServiceId, quantity: 1 }],
        })

      // Each hospital has its own sequence. A global one would leak one hospital's
      // invoice volume to every other.
      expect(theirs.status).toBe(201)
      expect(theirs.body.data.number).toBe(mine.number)
    })
  })

  /** Hospital B needs its own catalogue entry. */
  async function otherServiceId(token: string): Promise<string> {
    const created = await supertest(app())
      .post(`${API}/services`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'CONS', name: 'Consultation', unitPriceMinor: 30_000 })

    return created.body.data.id as string
  }

  // ───────────────────────── payments ─────────────────────────

  describe('payments', () => {
    it('records a partial payment and leaves a balance', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()

      const paid = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ invoiceId: bill.id, amountMinor: 40_000, method: 'CASH' })

      expect(paid.status).toBe(201)
      expect(paid.body.data.paidMinor).toBe(40_000)
      expect(paid.body.data.balanceMinor).toBe(Number(bill.totalMinor) - 40_000)
      expect(paid.body.data.balanceMinor).toBeGreaterThan(0)
    })

    it('settles an invoice exactly', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()

      const paid = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ invoiceId: bill.id, amountMinor: Number(bill.totalMinor), method: 'UPI' })

      expect(paid.body.data.balanceMinor).toBe(0)
    })

    it('refuses a payment larger than the outstanding balance', async () => {
      const bill = await invoice(await asAccountant())

      const res = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${await asAccountant()}`)
        .send({ invoiceId: bill.id, amountMinor: Number(bill.totalMinor) + 1, method: 'CASH' })

      expect(res.status).toBe(422)
    })

    it('refuses a zero or negative payment', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()

      for (const amountMinor of [0, -100]) {
        const res = await supertest(app())
          .post(`${API}/payments`)
          .set('Authorization', `Bearer ${token}`)
          .send({ invoiceId: bill.id, amountMinor, method: 'CASH' })

        expect(res.status, `amount ${amountMinor}`).toBe(422)
      }
    })

    it('marks a manual payment unverified and a gateway payment pending', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()

      const manual = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ invoiceId: bill.id, amountMinor: 1_000, method: 'CASH', source: 'MANUAL' })

      // A person asserting cash changed hands is not a confirmed settlement, and calling
      // it one would be dishonest.
      expect(manual.body.data.payment.verification).toBe('UNVERIFIED')

      const gateway = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          invoiceId: bill.id,
          amountMinor: 1_000,
          method: 'CARD',
          source: 'GATEWAY',
          reference: 'TXN-88213',
        })

      expect(gateway.body.data.payment.verification).toBe('PENDING')
    })

    it('records who verified a gateway payment, and only when asked', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()

      const created = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          invoiceId: bill.id,
          amountMinor: 5_000,
          method: 'CARD',
          source: 'GATEWAY',
          reference: 'TXN-88214',
        })

      const paymentId = created.body.data.payment.id

      const verified = await supertest(app())
        .post(`${API}/payments/${paymentId}/verify`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reference: 'SETTLED-BATCH-9' })

      expect(verified.status).toBe(200)
      expect(verified.body.data.verification).toBe('VERIFIED')
      expect(verified.body.data.verifiedByUserId).toBeTruthy()
      expect(verified.body.data.verifiedAt).toBeTruthy()

      const again = await supertest(app())
        .post(`${API}/payments/${paymentId}/verify`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
      expect(again.status).toBe(409)
    })

    // ───────────────────── the credentials that must not exist ─────────────────────

    it('stores no card number, CVV or other payment credential', async () => {
      const bill = await invoice(await asAccountant())

      for (const field of ['cardNumber', 'cvv', 'cvc', 'expiry', 'pan', 'accountNumber', 'cardToken']) {
        const res = await supertest(app())
          .post(`${API}/payments`)
          .set('Authorization', `Bearer ${await asAccountant()}`)
          .send({
            invoiceId: bill.id,
            amountMinor: 1_000,
            method: 'CARD',
            [field]: '4111111111111111',
          })

        // Refused outright. There is no field for one anywhere in this module, and the
        // strict schema means sending one is rejected rather than quietly dropped —
        // storing card data would turn a breach into a PCI-DSS scope problem.
        expect(res.status, `${field} must be refused`).toBe(422)
      }

      // Read the stored rows back through the API rather than the model directly: a
      // direct query runs outside a tenant context and is refused by the very plugin that
      // makes the storage safe.
      const token = await asAccountant()
      const listed = await supertest(app())
        .get(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .query({ pageSize: 100 })

      const serialised = JSON.stringify(listed.body.data.items)

      expect(serialised).not.toContain('4111111111111111')
      for (const banned of ['cardNumber', 'cvv', 'cvc', 'pan', 'accountNumber', 'cardToken']) {
        expect(serialised, `${banned} must not be stored`).not.toContain(banned)
      }

      // And the schema itself offers no place to put one.
      const schema = (
        await import('../modules/billing/billing.models.js')
      ).PaymentModel.schema.paths as Record<string, unknown>

      for (const banned of ['cardNumber', 'cvv', 'cvc', 'pan', 'accountNumber', 'cardToken']) {
        expect(Object.keys(schema), `${banned} must not exist on the schema`).not.toContain(banned)
      }
    })

    it('keeps a receipt reference, which is what reconciliation actually needs', async () => {
      const bill = await invoice(await asAccountant())

      const res = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${await asAccountant()}`)
        .send({
          invoiceId: bill.id,
          amountMinor: 1_000,
          method: 'UPI',
          reference: 'UPI/2026/09/99812',
        })

      expect(res.status).toBe(201)
      expect(res.body.data.payment.reference).toBe('UPI/2026/09/99812')
    })
  })

  // ───────────────────── idempotency ─────────────────────

  describe('duplicate payment requests', () => {
    it('replays a repeated request instead of charging twice', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()
      const key = 'reception-desk-1-2026-10-12-0001'

      const body = { invoiceId: bill.id, amountMinor: 25_000, method: 'CASH' as const }

      const first = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(body)

      expect(first.status).toBe(201)
      expect(first.body.data.replayed).toBe(false)

      const second = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(body)

      // A network retry must not become a second charge. This is the difference.
      expect(second.status).toBe(200)
      expect(second.body.data.replayed).toBe(true)
      expect(second.body.data.payment.id).toBe(first.body.data.payment.id)

      // And the money moved exactly once.
      expect(second.body.data.paidMinor).toBe(25_000)
    })

    it('refuses the same key with a DIFFERENT payload', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()
      const key = 'reception-desk-2-2026-10-12-0001'

      await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({ invoiceId: bill.id, amountMinor: 25_000, method: 'CASH' })

      const res = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send({ invoiceId: bill.id, amountMinor: 30_000, method: 'CASH' })

      // Silently replaying would tell a receptionist "recorded" about money that was
      // never taken. A different payload under the same key is a client bug.
      expect(res.status).toBe(409)
    })

    it('charges twice when no key is supplied, because that is what was asked', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()

      const body = { invoiceId: bill.id, amountMinor: 5_000, method: 'CASH' }

      await supertest(app()).post(`${API}/payments`).set('Authorization', `Bearer ${token}`).send(body)
      const second = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send(body)

      expect(second.status).toBe(201)
      expect(second.body.data.paidMinor).toBe(10_000)
    })

    it('does not double-charge under a genuine concurrent retry', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()
      const key = 'concurrent-retry-0001'

      const body = { invoiceId: bill.id, amountMinor: 7_500, method: 'CASH' }

      const [a, b] = await Promise.all([
        supertest(app())
          .post(`${API}/payments`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send(body),
        supertest(app())
          .post(`${API}/payments`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', key)
          .send(body),
      ])

      // The unique index decides the winner; the loser replays rather than failing or
      // charging again.
      expect([a.status, b.status].sort()).toEqual([200, 201])

      const final = await supertest(app())
        .get(`${API}/invoices/${bill.id}`)
        .set('Authorization', `Bearer ${token}`)

      expect(final.body.data.paidMinor).toBe(7_500)
    })
  })

  // ───────────────────── refunds ─────────────────────

  describe('refunds', () => {
    it('records a refund as a new record and restores the balance', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()

      const paid = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ invoiceId: bill.id, amountMinor: 30_000, method: 'CASH' })

      const paymentId = paid.body.data.payment.id

      const refund = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          invoiceId: bill.id,
          amountMinor: 10_000,
          method: 'CASH',
          kind: 'REFUND',
          refundsPaymentId: paymentId,
        })

      expect(refund.status).toBe(201)
      expect(refund.body.data.refundedMinor).toBe(10_000)
      expect(refund.body.data.paidMinor).toBe(20_000)
      expect(refund.body.data.balanceMinor).toBe(Number(bill.totalMinor) - 20_000)

      // The original payment is untouched. A refund that edited its original would make
      // "how much was taken" unanswerable after the fact.
      const listed = await supertest(app())
        .get(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .query({ invoiceId: bill.id })

      const original = (listed.body.data.items as Row[]).find((row) => row.id === paymentId)
      expect(original?.amountMinor).toBe(30_000)
      expect(original?.kind).toBe('PAYMENT')
    })

    it('refuses a refund larger than the payment it reverses', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()

      const paid = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ invoiceId: bill.id, amountMinor: 5_000, method: 'CASH' })

      const res = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          invoiceId: bill.id,
          amountMinor: 6_000,
          method: 'CASH',
          kind: 'REFUND',
          refundsPaymentId: paid.body.data.payment.id,
        })

      expect(res.status).toBe(422)
    })

    it('requires a refund to name the payment it reverses', async () => {
      const bill = await invoice(await asAccountant())

      const res = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${await asAccountant()}`)
        .send({ invoiceId: bill.id, amountMinor: 1_000, method: 'CASH', kind: 'REFUND' })

      // An unlinked refund cannot be reconciled against anything.
      expect(res.status).toBe(422)
    })
  })

  // ───────────────────── workflow ─────────────────────

  describe('invoice lifecycle', () => {
    it('refuses to issue twice', async () => {
      const bill = await invoice(await asAccountant())

      const res = await supertest(app())
        .post(`${API}/invoices/${bill.id}/issue`)
        .set('Authorization', `Bearer ${await asAccountant()}`)
        .send({})

      expect(res.status).toBe(409)
    })

    it('requires a reason to void', async () => {
      const bill = await invoice(await asAccountant())

      const res = await supertest(app())
        .post(`${API}/invoices/${bill.id}/void`)
        .set('Authorization', `Bearer ${await asAccountant()}`)
        .send({ reason: 'oops' })

      expect(res.status).toBe(422)
    })

    it('refuses to void an invoice that has money on it', async () => {
      const bill = await invoice(await asAccountant())
      const token = await asAdmin()

      await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ invoiceId: bill.id, amountMinor: 1_000, method: 'CASH' })

      const res = await supertest(app())
        .post(`${API}/invoices/${bill.id}/void`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Charged the wrong patient for this.' })

      // Voiding an invoice with money on it would leave the payment pointing at nothing.
      expect(res.status).toBe(409)
    })

    it('refuses to void a draft, which was never issued', async () => {
      const token = await asAdmin()
      const created = await supertest(app())
        .post(`${API}/invoices`)
        .set('Authorization', `Bearer ${token}`)
        .send({ patientId, lines: [{ serviceId, quantity: 1 }] })

      const res = await supertest(app())
        .post(`${API}/invoices/${created.body.data.id}/void`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Changed my mind about this one.' })

      expect(res.status).toBe(409)
    })

    it('serves a printable invoice as a private, authorized download', async () => {
      const bill = await invoice(await asAccountant())

      const res = await supertest(app())
        .get(`${API}/invoices/${bill.id}/document`)
        .set('Authorization', `Bearer ${await asAccountant()}`)

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('application/pdf')
      expect(res.headers['cache-control']).toContain('no-store')
      expect(res.headers['content-disposition']).toContain('attachment')
      expect(res.headers['x-content-type-options']).toBe('nosniff')

      const body = res.body as Buffer
      expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(body.toString('latin1')).toContain('%%EOF')

      // The currency is printed, because a symbol on a photocopied invoice is ambiguous.
      expect(body.toString('latin1')).toContain('INR')
    })
  })

  // ───────────────────── permissions ─────────────────────

  describe('who may do what with money', () => {
    it('keeps a doctor out of billing entirely', async () => {
      const doctorToken = await asDoctor()

      for (const [method, path] of [
        ['get', `${API}/invoices`],
        ['get', `${API}/services`],
        ['get', `${API}/payments`],
      ] as const) {
        // supertest's `.set()` only exists once a method has been chosen, so the
        // method comes first rather than being applied to a shared agent.
        const res = await supertest(app())
          .get(path)
          .set('Authorization', `Bearer ${doctorToken}`)

        expect(res.status, `${method.toUpperCase()} ${path}`).toBe(403)
      }
    })

    it('keeps reception out of recording a payment', async () => {
      const bill = await invoice(await asAccountant())

      const res = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${await asReception()}`)
        .send({ invoiceId: bill.id, amountMinor: 1_000, method: 'CASH' })

      // `billing:write` and `payment:write` are different permissions on purpose, so a
      // role can raise an invoice without being able to write off a balance by marking
      // it settled.
      expect(res.status).toBe(403)
    })

    it('restricts revenue to report:financial', async () => {
      const query = { from: '2026-10-01', to: '2026-10-12' }

      const asAccountantRes = await supertest(app())
        .get(`${API}/reports/revenue`)
        .set('Authorization', `Bearer ${await asAccountant()}`)
        .query(query)
      expect(asAccountantRes.status).toBe(200)

      // A doctor holds report:read but not report:financial, and must not be able to
      // derive a hospital's turnover from operational data and arithmetic.
      const asDoctorRes = await supertest(app())
        .get(`${API}/reports/revenue`)
        .set('Authorization', `Bearer ${await asDoctor()}`)
        .query(query)
      expect(asDoctorRes.status).toBe(403)

      const asReceptionRes = await supertest(app())
        .get(`${API}/reports/revenue.csv`)
        .set('Authorization', `Bearer ${await asReception()}`)
        .query(query)
      expect(asReceptionRes.status).toBe(403)
    })

    it('lets a doctor read operational reports', async () => {
      const res = await supertest(app())
        .get(`${API}/reports/appointments`)
        .set('Authorization', `Bearer ${await asDoctor()}`)
        .query({ from: '2026-10-01', to: '2026-10-12' })

      expect(res.status).toBe(200)
      // Operational, not financial: no money on this one at all.
      expect(JSON.stringify(res.body.data)).not.toContain('Minor')
    })

    it('refuses cross-tenant access to invoices and payments', async () => {
      const bill = await invoice(await asAccountant())

      const read = await supertest(app())
        .get(`${API}/invoices/${bill.id}`)
        .set('Authorization', `Bearer ${await asOther()}`)
      expect(read.status).toBe(404)

      const pay = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${await asOther()}`)
        .send({ invoiceId: bill.id, amountMinor: 1_000, method: 'CASH' })
      expect(pay.status).toBe(404)

      const listed = await supertest(app())
        .get(`${API}/invoices`)
        .set('Authorization', `Bearer ${await asOther()}`)
      expect(listed.body.data.items).toEqual([])
    })

    it('keeps a platform operator out of billing', async () => {
      const res = await supertest(app())
        .get(`${API}/invoices`)
        .set('Authorization', `Bearer ${await as('platform-admin@example.test')}`)

      expect(res.status).toBe(403)
    })
  })

  // ───────────────────── reports ─────────────────────

  describe('reports', () => {
    async function payOn(token: string, at: string, amountMinor: number, extra: Row = {}) {
      const bill = await invoice(token)
      const res = await supertest(app())
        .post(`${API}/payments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ invoiceId: bill.id, amountMinor, method: 'CASH', occurredAt: at, ...extra })
      expect(res.status, `record payment`).toBe(201)
      return res.body.data as Row
    }

    it('separates manual money from verified gateway money', async () => {
      const token = await asAdmin()

      await payOn(token, '2026-10-02T09:00:00+05:30', 10_000)

      const gateway = await payOn(token, '2026-10-02T10:00:00+05:30', 20_000, {
        method: 'CARD',
        source: 'GATEWAY',
        reference: 'TXN-1',
      })

      const gatewayPayment = (gateway.payment as Row).id as string

      await supertest(app())
        .post(`${API}/payments/${gatewayPayment}/verify`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      const res = await supertest(app())
        .get(`${API}/reports/revenue`)
        .set('Authorization', `Bearer ${token}`)
        .query({ from: '2026-10-01', to: '2026-10-05', granularity: 'daily' })

      expect(res.status).toBe(200)
      const totals = res.body.data.totals

      // The whole point of this module. An unreconciled claim and money in hand are
      // different facts and must not be summed into one "revenue" figure.
      expect(totals.manualTotalMinor).toBe(10_000)
      expect(totals.verifiedGatewayTotalMinor).toBe(20_000)
      expect(totals.pendingGatewayTotalMinor).toBe(0)
      expect(totals.settledTotalMinor).toBe(30_000)
    })

    it('keeps an unverified gateway claim out of the settled figure', async () => {
      const token = await asAdmin()

      await payOn(token, '2026-10-03T09:00:00+05:30', 40_000, {
        method: 'CARD',
        source: 'GATEWAY',
        reference: 'TXN-2',
      })

      const res = await supertest(app())
        .get(`${API}/reports/revenue`)
        .set('Authorization', `Bearer ${token}`)
        .query({ from: '2026-10-01', to: '2026-10-05' })

      // Reconciled by nobody, so it is not settled.
      expect(res.body.data.totals.pendingGatewayTotalMinor).toBe(40_000)
      expect(res.body.data.totals.settledTotalMinor).toBe(0)
    })

    it('buckets by the hospital local day, not by UTC', async () => {
      const token = await asAdmin()

      // 23:30 IST on the 2nd is 18:00 UTC the same day, so a UTC bucket would agree here.
      // Use 00:30 IST on the 3rd, which is 19:00 UTC on the 2nd — UTC would file it under
      // the 2nd and a day's takings would land in the wrong column.
      await payOn(token, '2026-10-03T00:30:00+05:30', 15_000)

      const res = await supertest(app())
        .get(`${API}/reports/revenue`)
        .set('Authorization', `Bearer ${token}`)
        .query({ from: '2026-10-01', to: '2026-10-05', granularity: 'daily' })

      const series = res.body.data.series as Row[]
      const day3 = series.find((bucket) => bucket.key === '2026-10-03')
      const day2 = series.find((bucket) => bucket.key === '2026-10-02')

      expect(day3?.manualTotalMinor).toBe(15_000)
      expect(day2?.manualTotalMinor).toBe(0)
    })

    it('returns a row for every day in the range, including empty ones', async () => {
      const token = await asAdmin()
      await payOn(token, '2026-10-02T09:00:00+05:30', 5_000)

      const res = await supertest(app())
        .get(`${API}/reports/revenue`)
        .set('Authorization', `Bearer ${token}`)
        .query({ from: '2026-10-01', to: '2026-10-05', granularity: 'daily' })

      // A missing day reads as "no data" when it should read as "nothing taken", and that
      // difference matters to somebody reconciling.
      expect(res.body.data.series).toHaveLength(5)
    })

    it('buckets by month when asked', async () => {
      const token = await asAdmin()
      await payOn(token, '2026-10-02T09:00:00+05:30', 7_000)
      await payOn(token, '2026-10-20T09:00:00+05:30', 3_000)

      const res = await supertest(app())
        .get(`${API}/reports/revenue`)
        .set('Authorization', `Bearer ${token}`)
        .query({ from: '2026-10-01', to: '2026-10-31', granularity: 'monthly' })

      const series = res.body.data.series as Row[]
      expect(series).toHaveLength(1)
      expect(series[0]?.key).toBe('2026-10')
      expect(series[0]?.manualTotalMinor).toBe(10_000)
    })

    it('refuses a range whose end is before its start', async () => {
      const res = await supertest(app())
        .get(`${API}/reports/revenue`)
        .set('Authorization', `Bearer ${await asAccountant()}`)
        .query({ from: '2026-10-12', to: '2026-10-01' })

      expect(res.status).toBe(422)
    })

    it('refuses a malformed date', async () => {
      const res = await supertest(app())
        .get(`${API}/reports/revenue`)
        .set('Authorization', `Bearer ${await asAccountant()}`)
        .query({ from: '2026-13-45', to: '2026-10-01' })

      expect(res.status).toBe(422)
    })

    it('exports revenue as CSV with the verification split intact', async () => {
      const token = await asAdmin()
      await payOn(token, '2026-10-02T09:00:00+05:30', 11_000)

      const res = await supertest(app())
        .get(`${API}/reports/revenue.csv`)
        .set('Authorization', `Bearer ${token}`)
        .query({ from: '2026-10-01', to: '2026-10-05', granularity: 'daily' })

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/csv')
      expect(res.headers['content-disposition']).toContain('attachment')

      const body = res.text
      expect(body).toContain('period,manual_total_minor,verified_gateway_total_minor')
      expect(body).toContain('2026-10-02')
      // The split survives the export. A CSV that collapsed it would reintroduce exactly
      // the misreading the report avoids.
      expect(body).toContain('verified_gateway_total_minor')
    })

    it('neutralises a spreadsheet formula in an exported value', async () => {
      const { toCsv } = await import('../modules/reports/reports.service.js')

      const body = toCsv(['name'], [{ name: '=cmd|calc' }, { name: 'Anaya' }])

      // Without this, opening the export executes it. A leading tab defuses the formula
      // and the spreadsheet renders it as text. This is how CSV exports become an attack
      // path, and it is why a value is neutralised rather than merely quoted.
      expect(body).not.toContain('\r\n=cmd')
      expect(body).toContain('\t=cmd|calc')
      // An ordinary value is left alone.
      expect(body).toContain('\r\nAnaya')
    })

    it('quotes a value containing a comma so columns do not shift', async () => {
      const { toCsv } = await import('../modules/reports/reports.service.js')

      const body = toCsv(['name', 'id'], [{ name: 'Test, Patient', id: '1' }])
      expect(body).toContain('"Test, Patient",1')
    })

    it('reports attendance hours that add up', async () => {
      const token = await asReception()

      const today = new Date()
      // The HOSPITAL's local calendar day, not UTC's. The service stamps `workDate` the
      // same way, and the two differ for part of every day — at 18:37 UTC this is the 13th
      // in Asia/Kolkata and the 12th in UTC. Asking for the UTC day would make this test
      // pass or fail depending on the hour it ran.
      const workDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(today)

      const record = await supertest(app())
        .post(`${API}/attendance/check-in`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
      expect(record.status).toBe(201)

      await supertest(app())
        .post(`${API}/attendance/check-out`)
        .set('Authorization', `Bearer ${token}`)
        .send({})

      // Read as an ADMINISTRATOR, not as the person who clocked in: RECEPTIONIST holds
      // `attendance:read` but not `report:read`, so recording your own day does not also
      // grant you a view over everyone's. That is the intended separation.
      const asSelf = await supertest(app())
        .get(`${API}/reports/attendance`)
        .set('Authorization', `Bearer ${token}`)
        .query({ from: workDate, to: workDate })
      expect(asSelf.status).toBe(403)

      const res = await supertest(app())
        .get(`${API}/reports/attendance`)
        .set('Authorization', `Bearer ${await asAdmin()}`)
        .query({ from: workDate, to: workDate })

      expect(res.status).toBe(200)
      expect(res.body.data.people.length).toBeGreaterThan(0)
      expect(typeof res.body.data.totals.hoursWorked).toBe('number')
    })

    it('records an export in the audit trail', async () => {
      const token = await asAdmin()

      await supertest(app())
        .get(`${API}/reports/revenue.csv`)
        .set('Authorization', `Bearer ${token}`)
        .query({ from: '2026-10-01', to: '2026-10-05' })

      const { AuditLogModel } = await import('../modules/audit/audit.model.js')
      const entries = await (AuditLogModel as unknown as Model<Row>)
        .find({ hospitalId: new Types.ObjectId(fixture.hospitalA.id) })
        .lean()
        .exec()

      // An export is the easiest way to take data out in bulk.
      expect(entries.map((entry) => entry['action'])).toContain('report.exported')
    })

    it('keeps the patient name out of the financial audit trail', async () => {
      const token = await asAdmin()
      await invoice(token)

      const { AuditLogModel } = await import('../modules/audit/audit.model.js')
      const entries = await (AuditLogModel as unknown as Model<Row>)
        .find({ hospitalId: new Types.ObjectId(fixture.hospitalA.id) })
        .lean()
        .exec()

      // The trail is readable by `audit:read`, a wider group than `billing:read`, and a
      // financial log should not become a second copy of the patient register.
      expect(JSON.stringify(entries)).not.toContain('Riya')
      expect(entries.map((entry) => entry['action'])).toContain('invoice.created')
    })
  })
})