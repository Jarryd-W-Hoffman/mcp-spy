import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is the ui/ folder.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'ui/src/**/*.test.ts'],
  },
});
