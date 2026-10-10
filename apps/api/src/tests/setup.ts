import process from 'node:process'

/**
 * Global test setup, executed before any test module is imported.
 *
 * The environment is pinned here (rather than in a `.env.test`) so that a developer's
 * real `.env` file can never influence a test run. `DOTENV_DISABLED` also makes
 * `config/env.ts` skip `process.loadEnvFile()`.
 */
process.env['NODE_ENV'] = 'test'
process.env['DOTENV_DISABLED'] = '1'
process.env['LOG_LEVEL'] ??= 'silent'
process.env['LOG_PRETTY'] ??= 'false'
process.env['ENABLE_API_DOCS'] ??= 'false'
process.env['TRUST_PROXY'] ??= 'false'
process.env['CORS_ORIGINS'] ??= 'http://localhost:5173'
process.env['MONGODB_URI'] ??= 'mongodb://127.0.0.1:27017'
process.env['MONGODB_DB_NAME'] ??= 'infinigrow_test'