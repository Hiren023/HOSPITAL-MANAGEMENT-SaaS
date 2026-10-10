import { Router } from 'express'

import { health } from './health.controller.js'
import { ready } from './ready.controller.js'

/** Probes are mounted outside `/api/v1` so they are unaffected by API versioning. */
export const healthRouter: Router = Router()

healthRouter.get('/', health)
healthRouter.get('/ready', ready)