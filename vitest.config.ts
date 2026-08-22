import { defineConfig } from 'vitest/config'

/**
 * Pure-logic tests run in plain Node — `src/lib/training/`, the mappers, the rate-limit
 * maths and the crypto helpers have no bindings and no I/O by design, which is what makes
 * the training engine reproducible and cheap to test.
 *
 * D1-backed tests live under `test/integration/` and run against a real local D1 through
 * the Workers pool; see `vitest.workers.config.ts`.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
})
