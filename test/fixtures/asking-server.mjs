// A test server that asks the client for ping and roots/list before answering
// a tool call, never answers "hang", and answers initialize with an error
// when told to by argv.
import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const failInitialize = process.argv.includes('--fail-initialize');
const waiting = new Map();
const ask = (id, method) => new Promise((resolve) => (waiting.set(id, resolve), send({ jsonrpc: '2.0', id, method })));

createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) return waiting.get(message.id)?.(message);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    return send(failInitialize ? { jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'not today' } } : { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'asking', version: '1' } } });
  }
  if (message.method === 'hang') return;
  const [ping, roots] = await Promise.all([ask('p', 'ping'), ask('r', 'roots/list')]);
  send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ ping, roots }) }] } });
});
