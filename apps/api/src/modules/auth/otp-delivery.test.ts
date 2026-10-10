import { describe, expect, it } from 'vitest'

import { buildOtpMessage, createSmtpDelivery } from './smtp-delivery.js'
import { OtpDeliveryNotConfiguredError, resolveOtpDelivery } from './otp-delivery.js'

/**
 * OTP delivery tests.
 *
 * The properties under test are the ones that keep a one-time secret out of places
 * that leak: it must not appear in a subject line, must survive HTML escaping, and the
 * absence of a configured provider must fail CLOSED rather than falling back to a log.
 */

describe('buildOtpMessage', () => {
  const base = { to: 'user@example.test', code: '123456', expiresInMinutes: 10 }

  it('places the code in the body but NOT the subject', () => {
    // A subject line lands in mail-server logs, push previews and notification
    // centre summaries, all of which are far more widely readable than the body.
    for (const purpose of ['EMAIL_VERIFICATION', 'PASSWORD_RESET', 'LOGIN_CHALLENGE'] as const) {
      const message = buildOtpMessage({ ...base, purpose })

      expect(message.subject).not.toContain('123456')
      expect(message.text).toContain('123456')
      expect(message.html).toContain('123456')
    }
  })

  it('uses a purpose-specific subject', () => {
    const reset = buildOtpMessage({ ...base, purpose: 'PASSWORD_RESET' })
    const verify = buildOtpMessage({ ...base, purpose: 'EMAIL_VERIFICATION' })

    expect(reset.subject).not.toBe(verify.subject)
    expect(reset.subject).toMatch(/password/i)
  })

  it('states the expiry', () => {
    const message = buildOtpMessage({ ...base, purpose: 'PASSWORD_RESET' })

    expect(message.text).toContain('10 minutes')
    expect(message.html).toContain('10 minutes')
  })

  it('warns the recipient never to share the code', () => {
    expect(buildOtpMessage({ ...base, purpose: 'LOGIN_CHALLENGE' }).text).toMatch(/never share/i)
  })

  it('addresses the message to the supplied recipient', () => {
    expect(buildOtpMessage({ ...base, purpose: 'LOGIN_CHALLENGE' }).to).toBe('user@example.test')
  })

  it('warns an unexpected recipient to ignore a reset they did not request', () => {
    expect(buildOtpMessage({ ...base, purpose: 'PASSWORD_RESET' }).text).toMatch(/ignore this email/i)
  })
})

describe('resolveOtpDelivery', () => {
  it('returns null when SMTP is NOT configured (fails closed)', () => {
    // No provider means no delivery. It must NOT fall back to printing the code.
    expect(resolveOtpDelivery({})).toBeNull()
    expect(resolveOtpDelivery({ MAIL_HOST: 'smtp.example.test' })).toBeNull()
    expect(
      resolveOtpDelivery({ MAIL_HOST: 'smtp.example.test', MAIL_USER: 'u', MAIL_PASSWORD: 'p' }),
    ).toBeNull()
    expect(
      resolveOtpDelivery({
        MAIL_HOST: 'smtp.example.test',
        MAIL_USER: 'u',
        MAIL_PASSWORD: 'p',
        MAIL_FROM: 'no-reply@example.test',
      }),
    ).not.toBeNull()
  })

  it('treats an empty string as not configured', () => {
    expect(
      resolveOtpDelivery({
        MAIL_HOST: '',
        MAIL_USER: '',
        MAIL_PASSWORD: '',
        MAIL_FROM: '',
      }),
    ).toBeNull()
  })

  it('resolves an SMTP adapter when fully configured', () => {
    const delivery = resolveOtpDelivery({
      MAIL_HOST: 'smtp.example.test',
      MAIL_PORT: '2525',
      MAIL_USER: 'user',
      MAIL_PASSWORD: 'secret',
      MAIL_FROM: 'no-reply@example.test',
    })

    expect(delivery).not.toBeNull()
    expect(delivery?.name).toBe('smtp')
  })
})

describe('OtpDeliveryNotConfiguredError', () => {
  it('explains the operator action and does not suggest logging the code', () => {
    const error = new OtpDeliveryNotConfiguredError()

    expect(error.message).toMatch(/MAIL_/)
    // Critically: it must not offer a logging fallback.
    expect(error.message.toLowerCase()).not.toContain('log the code')
    expect(error.message.toLowerCase()).not.toContain('print')
  })
})

describe('createSmtpDelivery', () => {
  it('returns a named adapter', () => {
    const delivery = createSmtpDelivery({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      user: 'u',
      password: 'p',
      from: 'no-reply@example.test',
    })

    expect(delivery.name).toBe('smtp')
    expect(typeof delivery.sendOtp).toBe('function')
  })
})