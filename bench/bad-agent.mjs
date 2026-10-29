// An agent that gets arguments wrong, as models sometimes do, for mcpspy validate:
//   node bench/bad-agent.mjs '["mcpspy","run","--name","notes","--","node","bench/notes-server.mjs","stdio"]'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [command, ...args] = JSON.parse(process.argv[2]);
const client = new Client({ name: 'claude-code', version: '2.1.0' });
await client.connect(new StdioClientTransport({ command, args, stderr: 'ignore' }));
await client.listTools();
for (const [name, a] of [['get_note', { id: '2' }], ['add_note', { body: 'no title' }], ['search_note', { query: 'x' }]]) {
  const r = await client.callTool({ name, arguments: a }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
  console.log(name.padEnd(12), (r.content[0]?.text ?? '').slice(0, 90));
}
await client.close();
