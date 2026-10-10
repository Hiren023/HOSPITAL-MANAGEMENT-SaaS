import nodemailer from 'nodemailer'

import type { OtpDelivery, OtpPurpose } from './otp-delivery.js'

/**
 * SMTP OTP delivery — the production adapter.
 *
 * SECURITY: the OTP is placed in the message body only. It is never written to the
 * logger, never included in a subject line (which would leak it into mail-server
 * logs and notification previews), and never included in a reply-to header.
 */

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
  from: string
}

const SUBJECTS: Record<OtpPurpose, string> = {
  EMAIL_VERIFICATION: 'Verify your Infinigrow Hospital Cloud email address',
  PASSWORD_RESET: 'Reset your Infinigrow Hospital Cloud password',
  LOGIN_CHALLENGE: 'Your Infinigrow Hospital Cloud sign-in code',
}

const INTRO: Record<OtpPurpose, string> = {
  EMAIL_VERIFICATION: 'Confirm this address to finish setting up your account.',
  PASSWORD_RESET: 'Use this code to choose a new password. If you did not request this, ignore this email.',
  LOGIN_CHALLENGE: 'Use this code to complete your sign-in.',
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface OtpMessage {
  to: string
  subject: string
  text: string
  html: string
}

/**
 * Build the OTP message.
 *
 * Separated from transport so the content can be tested without a mail server — in
 * particular the two properties that matter: the code is in the BODY only, and any
 * HTML metacharacters in the surrounding text are escaped.
 */
export function buildOtpMessage(input: {
  to: string
  code: string
  purpose: OtpPurpose
  expiresInMinutes: number
}): OtpMessage {
  return {
    to: input.to,
    // The code is deliberately absent from the subject.
    subject: SUBJECTS[input.purpose],
    // The warning appears in BOTH the plain-text and HTML versions: a plain-text
    // client is just as likely to be phished by a code being "requested" by support.
    text:
      `${INTRO[input.purpose]}\n\nYour code: ${input.code}\n\n` +
      `It expires in ${input.expiresInMinutes} minutes. Never share it with anyone.`,
    html:
      `<p>${escapeHtml(INTRO[input.purpose])}</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:24px 0">${escapeHtml(input.code)}</p>` +
      `<p>This code expires in ${input.expiresInMinutes} minutes. Never share it with anyone.</p>`,
  }
}

export function createSmtpDelivery(config: SmtpConfig): OtpDelivery {
  return {
    name: 'smtp',

    async sendOtp(input) {
      const message = buildOtpMessage(input)

      const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.password },
      })

      await transporter.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      })
    },
  }
}