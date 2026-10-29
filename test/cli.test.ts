import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
const echoServer = join(import.meta.dirname, 'fixtures', 'echo-server.mjs');

function run(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('mcpspy run', () => {
  it('still starts the server, unrecorded, when the log cannot be opened', async () => {
    // A path below a regular file can't be created, whoever runs the test.
    const file = join(mkdtempSync(join(tmpdir(), 'mcpspy-cli-')), 'not-a-directory');
    writeFileSync(file, '');
    const initialize = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`;

    const { code, stdout, stderr } = await run(['run', '--db', join(file, 'log.db'), '--', process.execPath, echoServer], initialize);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({ id: 1, result: { serverInfo: { name: 'echo-server' } } });
    expect(stderr).toMatch(/\[mcpspy\] can't open the log at .*log\.db.*; proxying without recording/);
  });
});

describe('mcpspy wrap and unwrap', () => {
  it('rewrites a config in place, keeping its formatting, and restores it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mcpspy-cli-')), '.mcp.json');
    const original = `{\n    "mcpServers": {\n        "echo": {\n            "command": "node",\n            "args": ["server.js"]\n        }\n    }\n}\n`;
    writeFileSync(path, original);

    const dryRun = await run(['wrap', path, '--dry-run']);
    expect(dryRun.stdout).toContain('Dry run');
    expect(readFileSync(path, 'utf8')).toBe(original);

    const wrapped = await run(['wrap', path]);
    expect(wrapped.code).toBe(0);
    expect(wrapped.stdout).toContain('Wrapped 1 server');
    const text = readFileSync(path, 'utf8');
    expect(text).toMatch(/^\{\n {4}"mcpServers"/);
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text).mcpServers.echo.args).toEqual(['run', '--name', 'echo', '--', 'node', 'server.js']);

    expect((await run(['unwrap', path])).code).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(original));
  });

  it('explains a missing or unreadable config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpspy-cli-'));
    expect((await run(['wrap', join(dir, 'nope.json')])).stderr).toContain("pass the path to your agent's MCP config");
    writeFileSync(join(dir, 'bad.json'), '{ // comment\n}');
    const bad = await run(['wrap', join(dir, 'bad.json')]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("bad.json isn't plain JSON");
  });
});

describe('mcpspy prune', () => {
  it('shows what it would delete, then deletes it', async () => {
    const db = join(mkdtempSync(join(tmpdir(), 'mcpspy-cli-')), 'log.db');
    const store = new Store(db);
    for (const [name, daysAgo] of [['ancient', 90], ['recent', 1]] as const) {
      const started = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
      const id = store.createSession({ name, transport: 'stdio', command: '[]', cwd: '/', pid: null, started_at: started });
      store.endSession(id, { ended_at: started + 1000, exit_code: 0, exit_signal: null });
    }
    store.close();

    const dryRun = await run(['prune', '--older-than', '30d', '--dry-run', '--db', db]);
    expect(dryRun.stdout).toContain('Would delete 1 of 2 sessions');
    expect(dryRun.stdout).toMatch(/#1\s+ancient/);
    expect(dryRun.stdout).toContain('Dry run: nothing deleted.');

    const pruned = await run(['prune', '--older-than', '30d', '--vacuum', '--db', db]);
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain('Deleted 1 of 2 sessions');
    expect(pruned.stdout).toContain('Vacuumed:');
    const after = new Store(db);
    expect(after.listSessions().map((session) => session.name)).toEqual(['recent']);
    after.close();
  });

  it('explains what it needs', async () => {
    expect((await run(['prune'])).stderr).toContain('prune needs --older-than <age>, --keep <n> or --max-size <size>');
    expect((await run(['prune', '--older-than', '30 days'])).stderr).toContain('use hours, days or weeks');
  });
});
