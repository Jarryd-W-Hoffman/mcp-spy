import { describe, expect, it } from 'vitest';
import { formatBytes, formatClock, formatDuration, formatRelative } from './format';

describe('format', () => {
  it('sizes in B, KB and MB', () => {
    expect([10, 2048, 3 * 1024 * 1024].map(formatBytes)).toEqual(['10 B', '2.0 KB', '3.0 MB']);
  });

  it('durations in ms and s', () => {
    expect([0.5, 12.4, 1500].map(formatDuration)).toEqual(['<1 ms', '12 ms', '1.50 s']);
  });

  it('clock times with milliseconds', () => {
    expect(formatClock(new Date(2026, 0, 2, 3, 4, 5, 6).getTime())).toBe('03:04:05.006');
  });

  it('relative times, falling back to the date', () => {
    const now = 10_000_000_000;
    expect([now - 5_000, now - 120_000, now - 7_200_000].map((ts) => formatRelative(ts, now))).toEqual(['just now', '2m ago', '2h ago']);
    expect(formatRelative(now - 90_000_000, now)).toBe(new Date(now - 90_000_000).toLocaleDateString());
    expect(formatRelative(Date.now())).toBe('just now');
  });
});
