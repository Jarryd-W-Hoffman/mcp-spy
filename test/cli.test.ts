import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
const echoServer = join(import.meta.dirname, 'fixtures', 'echo-server.mjs');

function run(args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
