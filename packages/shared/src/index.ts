/**
 * @infinigrow/shared
 *
 * Types, validation schemas, the RBAC matrix and API contracts shared by the API and
 * the web app. Importing from here guarantees that a permission, an error code or a
 * validation rule is defined exactly once.
 *
 * This package must stay free of any runtime dependency on Node built-ins or the
 * database so that it can be bundled into the browser application.
 */

export * from './types/ids.js'
export * from './types/role.js'
export * from './api/errors.js'
export * from './api/envelope.js'
export * from './schemas/common.js'
export * from './constants/limits.js'
