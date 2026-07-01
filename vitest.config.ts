import { defineConfig } from 'vitest/config';

// Minimal config so `npm test` runs the page-bridge plumbing check. The check
// imports only from `./` so no path aliases or browser globals are needed.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
