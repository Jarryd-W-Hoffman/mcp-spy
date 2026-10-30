import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store.js';

// Changing a file another user owns fails; the paths here stand in for one.
const refuse = vi.hoisted(() => new Set<string>());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: ((path: string, mode: number) => {
      if (refuse.has(String(path))) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return actual.chmodSync(path, mode);
    }) as typeof actual.chmodSync,
  };
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe('log file permissions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    refuse.clear();
  });

  it('creates the log and its WAL files readable by their owner only', () => {
    const folder = join(mkdtempSync(join(tmpdir(), 'mcpspy-perms-')), 'nested');
    const path = join(folder, 'log.db');
    const store = new Store(path);
    store.createSession({ name: 'a', transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: 0 });
    expect([mode(folder), mode(path), mode(`${path}-wal`), mode(`${path}-shm`)]).toEqual([0o700, 0o600, 0o600, 0o600]);
    store.close();
  });

  it('tightens a log left readable by others, and mcpspy’s own folder, but not a folder elsewhere', () => {
    const home = mkdtempSync(join(tmpdir(), 'mcpspy-home-'));
    vi.stubEnv('HOME', home);
    const own = join(home, '.mcpspy');
    mkdirSync(own, { mode: 0o755 });
    chmodSync(own, 0o775);
    const path = join(own, 'mcpspy.db');
    new Store(path).close();
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      writeFileSync(file, '', { flag: 'a' });
      chmodSync(file, 0o644);
    }
    new Store(path).close();
    expect([mode(own), mode(path)]).toEqual([0o700, 0o600]);

    const elsewhere = mkdtempSync(join(tmpdir(), 'mcpspy-shared-'));
    chmodSync(elsewhere, 0o755);
    new Store(join(elsewhere, 'log.db')).close();
    expect(mode(elsewhere)).toBe(0o755);
  });

  it('leaves alone a log it may not change', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mcpspy-perms-')), 'log.db');
    new Store(path).close();
    chmodSync(path, 0o644);
    refuse.add(path);
    new Store(path).close();
    expect(mode(path)).toBe(0o644);
  });
});
