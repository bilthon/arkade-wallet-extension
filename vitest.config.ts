import { defineConfig } from 'vitest/config';

// Match the application alias so bridge and approval tests exercise real entrypoints.
export default defineConfig({
  resolve: { alias: { '@': new URL('.', import.meta.url).pathname } },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
