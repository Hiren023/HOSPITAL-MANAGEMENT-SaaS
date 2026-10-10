/**
 * Platform-wide limits and defaults.
 *
 * Centralised so client and server agree, and so limits can be audited in one place.
 */

export const PAGINATION = Object.freeze({
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  ADMIN_MAX_PAGE_SIZE: 200,
})

/**
 * Session lifetimes, in seconds.
 *
 * The access token is deliberately short-lived: it bounds the window in which a
 * terminated or de-roled user retains access if the revocation cache is unavailable.
 */
export const SESSION = Object.freeze({
  ACCESS_TOKEN_TTL_SECONDS: 10 * 60,
  REFRESH_TOKEN_TTL_SECONDS: 14 * 24 * 60 * 60,
  PASSWORD_RESET_TTL_SECONDS: 15 * 60,
  /** Absolute session lifetime regardless of activity. */
  ABSOLUTE_SESSION_TTL_SECONDS: 30 * 24 * 60 * 60,
})

/** Failed-login protection. */
export const LOGIN_PROTECTION = Object.freeze({
  MAX_ATTEMPTS_BEFORE_COOLDOWN: 5,
  BASE_COOLDOWN_SECONDS: 60,
  MAX_COOLDOWN_SECONDS: 60 * 60,
  LOCKOUT_SECONDS: 15 * 60,
})

/**
 * Rate limits, expressed as a window and a maximum number of requests within it.
 * In-memory store for single-instance development; a shared store is required for
 * multi-instance production deployments (docs/SECURITY.md R12).
 */
export const RATE_LIMITS = Object.freeze({
  LOGIN: { windowMs: 15 * 60 * 1000, limit: 10 },
  REGISTER: { windowMs: 60 * 60 * 1000, limit: 5 },
  PASSWORD_RESET: { windowMs: 60 * 60 * 1000, limit: 5 },
  MFA_VERIFY: { windowMs: 15 * 60 * 1000, limit: 10 },
  API: { windowMs: 60 * 1000, limit: 300 },
  PUBLIC: { windowMs: 60 * 1000, limit: 60 },
  FILE_UPLOAD: { windowMs: 15 * 60 * 1000, limit: 30 },
})

/** Default hospital configuration applied when a tenant is approved. */
export const HOSPITAL_DEFAULTS = Object.freeze({
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  slotDurationMinutes: 20,
  appointmentBufferMinutes: 0,
  maxAppointmentAdvanceDays: 90,
  invoicePrefix: 'INV',
  dateFormat: 'DD/MM/YYYY',
})