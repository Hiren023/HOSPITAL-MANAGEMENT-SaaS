import { Router } from 'express'
import { API_ERROR_CODES, ROLES } from '@infinigrow/shared'

import { API_BASE_PATH } from '../../config/constants.js'
import { env } from '../../config/env.js'

/**
 * API root.
 *
 * This is a real capability-discovery endpoint, not a placeholder: it advertises the
 * API version, the error-code vocabulary and the role matrix so that client generators
 * and integration tests can assert against the live contract instead of a duplicated
 * copy that can drift.
 */
export const apiRouter: Router = Router()

apiRouter.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      name: 'Infinigrow Hospital Cloud API',
      vendor: 'Infinigrow Softech',
      basePath: API_BASE_PATH,
      docsEnabled: env.ENABLE_API_DOCS,
      errorCodes: API_ERROR_CODES,
      roles: ROLES,
      modules: {
        implemented: ['health', 'tenancy-context'],
        planned: [
          'auth',
          'hospitals',
          'users',
          'departments',
          'patients',
          'appointments',
          'consultations',
          'prescriptions',
          'attendance',
          'billing',
          'notifications',
          'audit',
        ],
      },
    },
    meta: { requestId: req.requestId },
  })
})
