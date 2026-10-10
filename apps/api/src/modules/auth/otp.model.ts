import { Schema } from 'mongoose'
import mongoose from 'mongoose'

/**
 * One-time passwords for email verification and password reset.
 *
 * Deliberately NOT tenant-scoped: a user verifies their email before they have a
 * hospital membership, so there may be no `hospitalId` to scope by.
 *
 * `otpHash` stores a SHA-256 of the code, never the code itself.
 */
const otpChallengeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },

    purpose: {
      type: String,
      enum: ['EMAIL_VERIFICATION', 'PASSWORD_RESET', 'LOGIN_CHALLENGE'],
      required: true,
      index: true,
    },

    /** SHA-256 of the code. The plaintext code exists only in the delivery message. */
    otpHash: { type: String, required: true, select: false },

    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date },
    attempts: { type: Number, default: 0 },

    /** Blocks a flood of OTP requests for one address. */
    lastSentAt: { type: Date, default: () => new Date() },

    ip: { type: String, maxlength: 64 },
    requestId: { type: String, maxlength: 100 },
  },
  { timestamps: true, strict: true, strictQuery: true },
)

// TTL: expired challenges are removed by MongoDB rather than a scheduled job.
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
otpChallengeSchema.index({ email: 1, purpose: 1, createdAt: -1 })

export const OtpChallengeModel =
  (mongoose.models['OtpChallenge'] as mongoose.Model<Record<string, unknown>> | undefined) ??
  mongoose.model<Record<string, unknown>>('OtpChallenge', otpChallengeSchema)