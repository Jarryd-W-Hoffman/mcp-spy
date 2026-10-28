// A tiny hand-rolled MCP server for tests. It answers initialize, tools/list
// and tools/call ("echo" and "slow"), writes logs to stderr, and can be told
// to misbehave via argv.
import { createInterface } from 'node:readline';

const noisy = process.argv.includes('--noisy');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

console.error('echo-server: starting');
if (noisy) process.stdout.write('this is not json\n');

const tools = [
  {
    name: 'echo',
    description: 'Echoes the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'slow',
    description: 'Waits before answering',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
  },
];

createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;

  switch (message.method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'echo-server', version: '1.0.0' },
        },
      });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: message.id, result: { tools } });
    case 'tools/call': {
      const { name, arguments: input = {} } = message.params ?? {};
      if (name === 'slow') await new Promise((resolve) => setTimeout(resolve, input.ms ?? 50));
      if (name === 'echo' || name === 'slow') {
        return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(input.text ?? 'done') }] } });
      }
      return send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
    default:
      return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
