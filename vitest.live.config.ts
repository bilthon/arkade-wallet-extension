import { defineConfig } from 'vitest/config';

// Live regtest checks are deliberately separate from the ordinary test suite.
export default defineConfig({
  resolve: { alias: { '@': new URL('.', import.meta.url).pathname } },
  test: {
    include: ['dev/live/**/*.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
