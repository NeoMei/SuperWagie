import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['**/*.test.ts'],
    testTimeout: 15_000,
    clearMocks: true,
    restoreMocks: true
  }
});
