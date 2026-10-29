// A small but realistic MCP server: a notes store, over stdio or Streamable HTTP.
//   node notes-server.mjs stdio
//   node notes-server.mjs http 7900
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const notes = new Map([
  [1, { id: 1, title: 'Release checklist', body: 'Bump the version, tag, push, publish to npm.', tags: ['release'] }],
  [2, { id: 2, title: 'Deploy notes', body: 'Staging deploys from main every hour.', tags: ['ops'] }],
]);
let nextId = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeServer() {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });

  server.registerTool('ping', { description: 'Answer immediately (for latency checks).', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));

  server.registerTool(
    'add_note',
    {
      description: 'Save a note and return its id.',
      inputSchema: { title: z.string().min(1), body: z.string(), tags: z.array(z.string()).optional() },
      outputSchema: { id: z.number() },
    },
    async ({ title, body, tags = [] }) => {
      const note = { id: nextId++, title, body, tags };
      notes.set(note.id, note);
      return { content: [{ type: 'text', text: `Saved note ${note.id}` }], structuredContent: { id: note.id } };
    },
  );

  server.registerTool(
    'search_notes',
    { description: 'Find notes whose title, body or tags contain the query.', inputSchema: { query: z.string(), limit: z.number().int().positive().optional() } },
    async ({ query, limit = 10 }) => {
      const q = query.toLowerCase();
      const found = [...notes.values()].filter((n) => `${n.title} ${n.body} ${n.tags.join(' ')}`.toLowerCase().includes(q)).slice(0, limit);
      return { content: [{ type: 'text', text: found.length ? found.map((n) => `#${n.id} ${n.title}`).join('\n') : 'No notes found.' }] };
    },
  );

  server.registerTool('get_note', { description: 'Read one note by id.', inputSchema: { id: z.number().int() } }, async ({ id }) => {
    const note = notes.get(id);
    if (!note) return { isError: true, content: [{ type: 'text', text: `No note with id ${id}` }] };
    return { content: [{ type: 'text', text: `${note.title}\n\n${note.body}` }] };
  });

  server.registerTool('summarize_notes', { description: 'Summarise every note (slow).', inputSchema: {} }, async () => {
    await sleep(150);
    return { content: [{ type: 'text', text: `${notes.size} notes: ${[...notes.values()].map((n) => n.title).join(', ')}` }] };
  });

  server.registerTool(
    'login',
    { description: 'Sign in to the sync service.', inputSchema: { username: z.string(), password: z.string() } },
    async ({ username }) => ({ content: [{ type: 'text', text: `Signed in as ${username}; session token sk-ant-api03-${'x'.repeat(24)}` }] }),
  );

  server.registerTool('report', { description: 'Return a report of about `kb` kilobytes.', inputSchema: { kb: z.number().int().min(1).max(10240) } }, async ({ kb }) => ({
    content: [{ type: 'text', text: 'Lorem ipsum dolor sit amet. '.repeat(Math.ceil((kb * 1024) / 28)).slice(0, kb * 1024) }],
  }));

  server.registerResource(
    'note',
    new ResourceTemplate('notes://{id}', { list: async () => ({ resources: [...notes.values()].map((n) => ({ uri: `notes://${n.id}`, name: n.title })) }) }),
    { description: 'A note', mimeType: 'text/plain' },
    async (uri, { id }) => ({ contents: [{ uri: uri.href, text: notes.get(Number(id))?.body ?? '' }] }),
  );
  return server;
}

const [mode = 'stdio', port = '7900'] = process.argv.slice(2);
if (mode === 'stdio') {
  await makeServer().connect(new StdioServerTransport());
  console.error('notes server ready (stdio)');
} else {
  const transports = new Map();
  createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const sessionId = req.headers['mcp-session-id'];
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      if (req.method !== 'POST' || body?.method !== 'initialize') return void res.writeHead(400).end('Bad Request: no valid session ID');
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (id) => transports.set(id, transport) });
      transport.onclose = () => transports.delete(transport.sessionId);
      await makeServer().connect(transport);
    }
    await transport.handleRequest(req, res, body);
  }).listen(Number(port), '127.0.0.1', () => console.error(`notes server ready on http://127.0.0.1:${port}/mcp`));
}
