import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is the ui/ folder.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'ui/src/**/*.test.{ts,tsx}'],
    setupFiles: ['ui/src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**', 'ui/src/**'],
      exclude: ['ui/src/**/*.test.{ts,tsx}', 'ui/src/test/**', 'ui/src/**/*.css'],
      reporter: ['text-summary', 'text'],
      // Every line, branch and function is tested; keep it that way.
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
