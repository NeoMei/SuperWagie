import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true
  }
});
