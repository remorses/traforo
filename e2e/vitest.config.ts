import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globals: false,
    include: ['src/**/*.test.ts'],
    // Each e2e test spawns a framework dev server on a unique port and connects
    // a tunnel; sequential execution avoids port collisions and tunnel conflicts.
    fileParallelism: false,
  },
})
