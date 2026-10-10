/** Build and runtime constants. Kept separate from validated environment config. */

export const SERVICE_NAME = 'infinigrow-hospital-cloud-api'
export const SERVICE_VERSION = '0.1.0-phase0'
export const API_BASE_PATH = '/api/v1'

export const SUPPORTED_ROLES = [
  'SUPER_ADMIN',
  'HOSPITAL_ADMIN',
  'DOCTOR',
  'RECEPTIONIST',
  'STAFF',
  'PHARMACIST',
  'ACCOUNTANT',
  'PATIENT',
] as const

export const PRODUCT_NAME = 'Infinigrow Hospital Cloud'
export const PRODUCT_TAGLINE = 'Ideas grow without limits'
export const PRODUCT_VENDOR = 'Infinigrow Softech'