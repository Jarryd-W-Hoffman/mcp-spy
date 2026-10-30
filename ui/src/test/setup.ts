import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Component tests run in jsdom; the rest of the suite in Node, where there is nothing to clean.
afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
