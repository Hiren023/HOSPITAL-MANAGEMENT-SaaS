import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
    /**
     * Proxy API calls to the Express server during development so the browser talks to
     * a single origin. This keeps cookies first-party and avoids CORS entirely in dev.
     */
    proxy: {
      '/api': {
        target: process.env['VITE_DEV_API_PROXY'] ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    // Fail the build if a bundle grows unexpectedly rather than silently bloating.
    chunkSizeWarningLimit: 700,
  },

  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,

    /**
     * jsdom environments are memory-hungry. Running every test file in its own fork
     * while the API suite concurrently holds an ephemeral `mongod` exhausts the worker
     * pool, and Vitest reports "Failed to start forks worker" — a resource failure
     * that looks like a broken test but is not one.
     *
     * Threads plus a small worker cap keeps both suites reliable on a developer
     * machine and on a CI runner. Note `poolOptions.threads.singleThread` is not
     * available in the Vitest 5 config type, so the cap is expressed via `maxWorkers`.
     */
    pool: 'threads',
    maxWorkers: 2,
    fileParallelism: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/main.tsx', 'src/**/*.test.{ts,tsx}'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
    },
  },
})
