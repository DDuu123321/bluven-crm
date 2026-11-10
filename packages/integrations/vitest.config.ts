import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    // Same test database and preparation as the core package.
    globalSetup: ['../core/test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
