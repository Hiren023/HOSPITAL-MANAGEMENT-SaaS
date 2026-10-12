import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino'

import { env } from '../config/env.js'

/**
 * Structured logger with mandatory redaction of sensitive values.
 *
 * Patient information must never reach the log pipeline (docs/SECURITY.md R8).
 * Pino redaction is applied at the serializer level so a developer cannot
 * accidentally log a raw request or response object without it being scrubbed.
 */

/** Header names whose values are always replaced with `[REDACTED]`. */
const REDACTED_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-refresh-token',
  'proxy-authorization',
]

/**
 * Body/query/params keys that may contain secrets or personal health information.
 *
 * `password` and friends are credentials. The remaining entries cover fields that
 * will appear in clinical payloads once Phase 3/4 lands — they are listed now so the
 * list is complete before any of them are written to a log call.
 */
const REDACTED_FIELDS = [
  // Credentials and tokens
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'confirmPassword',
  'token',
  'accessToken',
  'refreshToken',
  'resetToken',
  'mfaSecret',
  'recoveryCodes',
  'apiKey',
  'secret',

  // Personally identifiable information
  'dateOfBirth',
  'dob',
  'aadhaar',
  'aadhar',
  'pan',
  'phone',
  'phoneNumber',
  'address',
  'emergencyContact',

  // Clinical / protected health information
  'chiefComplaint',
  'history',
  'examination',
  'diagnosis',
  'advice',
  'vitals',
  'prescription',
  'medication',
  'notes',
  // Phase 7 clinical fields.
  //
  // `symptoms`, `assessment`, `plan` and `clinicalData` are exactly the kind of thing
  // that gets added to a log call as a debugging aid and then ships. A consultation is
  // the most sensitive record this system holds, and a log line is the least protected
  // place it could end up.
  'symptoms',
  'assessment',
  'plan',
  'clinicalData',
  'items',
  'drugName',
  'dose',
  'frequency',
  'followUpAt',
]

const REDACTION_PLACEHOLDER = '[REDACTED]'

/**
 * Options exposed so that tests can capture output and assert that redaction really
 * works. Production code uses the defaults.
 */
export interface CreateLoggerOptions {
  destination?: DestinationStream
  level?: string
}

/**
 * Pretty transport is a LOCAL DEVELOPMENT convenience and `pino-pretty` is a
 * devDependency. If it is missing, falling back to JSON is correct; crashing the
 * process at boot is not. A misconfigured `LOG_PRETTY` must never stop the API from
 * serving patients' requests.
 */
function usePrettyTransport(options: CreateLoggerOptions): boolean {
  if (options.destination) return false
  if (!env.LOG_PRETTY) return false

  try {
    require.resolve('pino-pretty')
    return true
  } catch {
    return false
  }
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? env.LOG_LEVEL,

    // JSON everywhere except local development with the transport available.
    ...(usePrettyTransport(options)
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : {}),

    base: {
      service: 'infinigrow-hospital-cloud-api',
      env: env.NODE_ENV,
    },

    redact: {
      paths: [
        'password',
        'req.headers.authorization',
        'req.headers.cookie',
        ...REDACTED_HEADERS.map((header) => `req.headers.${header}`),
        ...REDACTED_HEADERS.map((header) => `headers.${header}`),
        ...REDACTED_FIELDS.map((field) => `req.body.${field}`),
        ...REDACTED_FIELDS.map((field) => `body.${field}`),
        ...REDACTED_FIELDS.map((field) => `*.${field}`),
      ],
      censor: REDACTION_PLACEHOLDER,
      remove: false,
    },

    /**
     * Serialisers keep request logs to metadata only. Bodies are never serialised,
     * so a clinical payload cannot be logged by accident through a request object.
     */
    serializers: {
      req: (request: Record<string, unknown>) => ({
        method: request.method,
        url: request.url,
        remoteAddress: request.remoteAddress,
      }),
      res: (response: Record<string, unknown>) => ({ statusCode: response.statusCode }),
      err: pino.stdSerializers.err,
    },

    timestamp: pino.stdTimeFunctions.isoTime,
  }

  /**
   * The destination MUST be passed as the second positional argument.
   *
   * Pino 10 ignores a `stream` key inside the options object, so setting it there
   * silently sends every log line to stdout instead of the caller-supplied stream.
   * This was found by a failing redaction test and is called out so it is not
   * "simplified" back into the options object later.
   */
  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions)
}

export const logger = createLogger()

/** Exported for tests that assert redaction behaviour. */
export const REDACTED_FIELD_NAMES: readonly string[] = REDACTED_FIELDS
export const REDACTED_HEADER_NAMES: readonly string[] = REDACTED_HEADERS
export const REDACTED_VALUE = REDACTION_PLACEHOLDER
