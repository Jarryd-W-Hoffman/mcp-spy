// Plays an agent's session against the notes server, directly or through mcpspy:
//   node bench/agent.mjs '["mcpspy","run","--name","notes","--","node","bench/notes-server.mjs","stdio"]'
//   node bench/agent.mjs http://127.0.0.1:7901/mcp     (with mcpspy proxy in front of notes-server.mjs http 7900)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const target = process.argv[2];
const transport = target.startsWith('http')
  ? new StreamableHTTPClientTransport(new URL(target))
  : new StdioClientTransport({ command: JSON.parse(target)[0], args: JSON.parse(target).slice(1), stderr: 'ignore' });
const client = new Client({ name: 'claude-code', version: '2.1.0' });
await client.connect(transport);
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  console.log(`${name.padEnd(16)} ${result.isError ? 'ERROR ' : ''}${(result.content[0]?.text ?? '').split('\n')[0].slice(0, 70)}`);
};
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
console.log('resources:', (await client.listResources()).resources.map((r) => r.uri).join(', '));
await call('search_notes', { query: 'deploy' });
await call('add_note', { title: 'API keys', body: 'Rotate the GitHub token ghp_R8x2kQ7vLmN4pT9wZcY3bF6hJ1sD5gA0eU2i monthly', tags: ['security'] });
await call('get_note', { id: 3 });
await call('get_note', { id: 99 });
await call('login', { username: 'ada', password: 'correct horse battery staple' });
await call('summarize_notes', {});
console.log('resource:', (await client.readResource({ uri: 'notes://2' })).contents[0].text);
if (target.startsWith('http')) await transport.terminateSession();
await client.close();
