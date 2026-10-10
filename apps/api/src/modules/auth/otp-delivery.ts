/**
 * OTP delivery.
 *
 * Requirement: an OTP must reach the user through a properly configured provider and
 * must never appear in plaintext in logs.
 *
 * The design therefore has NO code path that writes an OTP to a logger. Delivery is a
 * pluggable adapter; if none is configured, the request fails closed rather than
 * falling back to printing the code.
 */

export interface OtpDelivery {
  readonly name: string
  /** Send an OTP. Must not log the code. */
  sendOtp(input: { to: string; code: string; purpose: OtpPurpose; expiresInMinutes: number }): Promise<void>
}

export type OtpPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET' | 'LOGIN_CHALLENGE'

export class OtpDeliveryNotConfiguredError extends Error {
  constructor() {
    super(
      'No OTP delivery provider is configured. Set MAIL_* environment variables to enable ' +
        'email delivery. The code is deliberately not logged as a fallback.',
    )
    this.name = 'OtpDeliveryNotConfiguredError'
  }
}

/**
 * Resolves the configured adapter.
 *
 * Returns null when SMTP is not configured, so callers can fail closed with a clear
 * message rather than silently sending mail nowhere.
 */
export function resolveOtpDelivery(env: Record<string, string | undefined>): OtpDelivery | null {
  const host = env['MAIL_HOST']
  const user = env['MAIL_USER']
  const password = env['MAIL_PASSWORD']
  const from = env['MAIL_FROM']

  if (!host || !user || !password || !from) return null

  // Imported lazily so the dependency is only loaded when actually configured.
  return {
    name: 'smtp',
    async sendOtp({ to, code, purpose, expiresInMinutes }) {
      const { createSmtpDelivery } = await import('./smtp-delivery.js')
      await createSmtpDelivery({
        host,
        port: Number(env['MAIL_PORT'] ?? 587),
        secure: env['MAIL_SECURE'] === 'true',
        user,
        password,
        from,
      }).sendOtp({ to, code, purpose, expiresInMinutes })
    },
  }
}