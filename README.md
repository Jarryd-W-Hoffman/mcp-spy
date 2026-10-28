# mcpspy

An inspection proxy for [Model Context Protocol](https://modelcontextprotocol.io) servers. Put it between your AI agent (Claude Code, Cursor, Windsurf, …) and an MCP server to see every JSON-RPC message they exchange: which tools were called, with what arguments, how long they took, what failed, and how much they weighed.

Unlike the official MCP Inspector, which is a client *you* drive, mcpspy records what your real agent actually sends.

## Status

Milestone 1 of 6: stdio proxy, SQLite log, and terminal viewer.

- [x] stdio proxy, SQLite log, `tail` / `sessions` / `show`
- [ ] Web UI: live stream, request/response pairs, JSON viewer
- [ ] Token estimates per tool call and for `tools/list`, JSON diffing
- [ ] Replay a recorded call against the server without the agent
- [ ] Mock rules and schema validation (`inputSchema` / `outputSchema`)
- [ ] Streamable HTTP and SSE proxying

## Install (from source)

Requires Node 22.13+ (uses the built-in `node:sqlite`).

```sh
npm install
npm run build
npm link        # puts `mcpspy` on your PATH
```

## Usage

Prefix the server command in your agent's MCP config with `mcpspy run --`. For example, in Claude Code's `.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "mcpspy",
      "args": ["run", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

Then watch the traffic from another terminal:

```sh
mcpspy tail -f
```

```
20:52:08.496 everything #1 → initialize id=0 150B
20:52:08.689 everything #2 stderr Starting default (STDIO) server...
20:52:08.716 everything #3 ← initialize ✓ 220ms id=0 3.4KB
20:52:08.729 everything #5 → tools/list id=1 46B
20:52:08.736 everything #6 ← tools/list ✓ 8ms id=1 9.9KB
20:52:08.761 everything #7 → tools/call echo id=2 108B
20:52:08.765 everything #8 ← tools/call echo ✓ 4ms id=2 89B
```

| Command | What it does |
| --- | --- |
| `mcpspy run [--name <label>] -- <cmd> [args…]` | Start the server behind the proxy. `mcpspy -- <cmd>` is shorthand. |
| `mcpspy tail [-f] [-n 50] [--session <id>] [--json]` | Print recorded messages; `-f` follows new ones. `--json` emits NDJSON rows. |
| `mcpspy sessions [--limit 20]` | List recorded server sessions with exit status and message count. |
| `mcpspy show <message-id>` | Pretty-print a message alongside its request or response. |

Every command accepts `--db <path>`. The default log is `~/.mcpspy/mcpspy.db`, or `$MCPSPY_DB` if set.

## How it works

- Bytes are forwarded in both directions as soon as they arrive, unchanged. A copy is split into newline-delimited frames and recorded separately, so a parsing or database error can never break the agent's session (the proxy warns once on stderr and keeps forwarding).
- Responses are paired with their request by sender and JSON-RPC id, so server-initiated requests (sampling, elicitation) pair correctly too. Latency is measured at the proxy.
- The server's stderr is passed through and logged, which often explains failures that look silent from the agent.
- Non-JSON output on stdout (a classic way to break an MCP server) is forwarded as-is and logged as `invalid`.
- Signals are forwarded to the server, and the proxy exits with the server's exit code.

## Development

```sh
npm test            # vitest
npm run typecheck
npm run dev -- tail # run the CLI from source via tsx
```
