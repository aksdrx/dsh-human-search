import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The chain/provider suites exercise real human-timing waits (typing
    // jitter, settle loops, failover grace windows); hosted CI runners run
    // 2–4× slower than a laptop, so per-test headroom must be generous to
    // keep CI deterministic.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
  },
})
