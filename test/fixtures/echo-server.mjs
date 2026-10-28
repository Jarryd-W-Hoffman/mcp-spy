// A tiny hand-rolled MCP server for tests. It answers initialize, tools/list
// and tools/call ("echo" and "slow"), writes logs to stderr, and can be told
// to misbehave via argv.
import { createInterface } from 'node:readline';

const noisy = process.argv.includes('--noisy');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

console.error('echo-server: starting');
if (noisy) process.stdout.write('this is not json\n');

const extraTools = ['roots', 'time', 'env'].map((name) => ({ name, inputSchema: { type: 'object' } }));
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

// Requests this server sends to the client, awaiting replies.
const waiting = new Map();
let nextServerId = 1;
const askClient = (method, params) =>
  new Promise((resolve) => {
    const id = `server-${nextServerId++}`;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
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
      return send({ jsonrpc: '2.0', id: message.id, result: { tools: [...tools, ...extraTools] } });
    case 'tools/call': {
      const { name, arguments: input = {} } = message.params ?? {};
      if (name === 'slow') await new Promise((resolve) => setTimeout(resolve, input.ms ?? 50));
      if (name === 'roots') {
        const reply = await askClient('roots/list', {});
        return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(reply.result ?? reply.error) }] } });
      }
      if (name === 'time') {
        return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { now: Date.now() } } });
      }
      if (name === 'env') {
        return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: process.env[input.key] ?? '(unset)' }] } });
      }
      if (name === 'echo' || name === 'slow') {
        return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(input.text ?? 'done') }] } });
      }
      return send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
    default:
      return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
