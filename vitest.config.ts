import { defineConfig } from 'vitest/config'

/**
 * Everything under test is pure by design — `block.ts`, `activity.ts`, `plan.ts`,
 * `metrics.ts`, `seed.ts` and the crypto helpers take no bindings and do no I/O, so they
 * run in plain Node with no Workers pool and no D1.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
})
