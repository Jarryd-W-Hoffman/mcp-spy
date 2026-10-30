import { describe, expect, it } from 'vitest';
import { unwrapConfig, wrapConfig } from '../src/wrap.js';

const config = {
  mcpServers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
    time: { type: 'stdio', command: 'uvx', env: {} },
    remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
  },
  other: { keep: true },
};

describe('wrapConfig', () => {
  it('puts mcpspy in front of each stdio server and skips remote ones', () => {
    const { config: wrapped, changes } = wrapConfig(config);
    expect(wrapped).toEqual({
      mcpServers: {
        github: {
          command: 'mcpspy',
          args: ['run', '--name', 'github', '--', 'npx', '-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
        },
        time: { type: 'stdio', command: 'mcpspy', args: ['run', '--name', 'time', '--', 'uvx'], env: {} },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      },
      other: { keep: true },
    });
    // args land right after command, where people expect them.
    expect(Object.keys((wrapped as typeof config).mcpServers.time)).toEqual(['type', 'command', 'args', 'env']);
    expect(changes).toEqual([
      { name: 'github', outcome: 'wrapped' },
      { name: 'time', outcome: 'wrapped' },
      { name: 'remote', outcome: 'skipped', reason: 'reached over HTTP: run mcpspy proxy https://mcp.example.com/mcp and point the agent at it' },
    ]);
  });

  it('passes options through to mcpspy run', () => {
    const { config: wrapped } = wrapConfig(config, { only: ['github'], command: '/opt/bin/mcpspy', db: '/tmp/x.db', mocks: 'mocks.json' });
    const servers = (wrapped as typeof config).mcpServers;
    expect(servers.github).toMatchObject({
      command: '/opt/bin/mcpspy',
      args: ['run', '--name', 'github', '--db', '/tmp/x.db', '--mocks', 'mocks.json', '--', 'npx', '-y', '@modelcontextprotocol/server-github'],
    });
    expect(servers.time).toEqual(config.mcpServers.time);
  });

  it('leaves wrapped servers alone, so wrapping twice changes nothing', () => {
    const once = wrapConfig(config).config;
    const twice = wrapConfig(once);
    expect(twice.config).toEqual(once);
    expect(twice.changes.filter((change) => change.outcome === 'wrapped')).toEqual([]);
  });

  it('handles VS Code’s "servers" key', () => {
    const { config: wrapped } = wrapConfig({ servers: { fs: { type: 'stdio', command: 'node', args: ['fs.js'] } } });
    expect(wrapped).toEqual({ servers: { fs: { type: 'stdio', command: 'mcpspy', args: ['run', '--name', 'fs', '--', 'node', 'fs.js'] } } });
  });

  it('refuses files without servers, and unknown server names', () => {
    expect(() => wrapConfig({ name: 'package' })).toThrow('no MCP servers here');
    expect(() => wrapConfig(config, { only: ['gitlab'] })).toThrow('no server named "gitlab"');
  });
});

describe('unwrapConfig', () => {
  it('restores the original config exactly', () => {
    const { config: restored, changes } = unwrapConfig(wrapConfig(config, { db: '/tmp/x.db' }).config);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(config));
    expect(changes.map((change) => change.outcome)).toEqual(['unwrapped', 'unwrapped', 'skipped']);
  });

  it('only unwraps what mcpspy wrapped', () => {
    const handWritten = { mcpServers: { x: { command: 'mcpspy', args: ['ui'] } } };
    expect(unwrapConfig(handWritten).config).toEqual(handWritten);
  });
});

describe('remote servers', () => {
  it('names serverUrl, or a placeholder, when skipping them', () => {
    const { changes } = wrapConfig({ mcpServers: { a: { serverUrl: 'https://a.example/mcp' }, b: { type: 'http' }, c: { url: 42 } } });
    expect(changes.map((change) => change.reason)).toEqual([
      'reached over HTTP: run mcpspy proxy https://a.example/mcp and point the agent at it',
      'reached over HTTP: run mcpspy proxy <url> and point the agent at it',
      'reached over HTTP: run mcpspy proxy <url> and point the agent at it',
    ]);
  });
});
