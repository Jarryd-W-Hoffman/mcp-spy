# mcpspy

An inspection proxy for [Model Context Protocol](https://modelcontextprotocol.io) servers. Put it between your AI agent (Claude Code, Cursor, Windsurf, …) and an MCP server to see every JSON-RPC message they exchange: which tools were called, with what arguments, how long they took, what failed, and how much they weighed.

Unlike the official MCP Inspector, which is a client *you* drive, mcpspy records what your real agent actually sends.

![mcpspy web UI](docs/screenshot.png)

## Status

Milestone 3 of 6.

- [x] stdio proxy, SQLite log, `tail` / `sessions` / `show`
- [x] Web UI: live stream, request/response pairs, JSON viewer
- [x] Token estimates per tool call and for `tools/list`, JSON diffing
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

Then open the inspector:

```sh
mcpspy ui --open      # http://localhost:7777
```

Every session shows up live. Each row pairs a request with its response, showing status, latency and size. Click a row to see both as a JSON tree or raw text, with tool results rendered the way the agent received them (text and images). Filter by server, text, notifications, stderr or errors only, and move between rows with ↑/↓.

### Context cost

Every tool definition a server advertises is sent to the model with every request, and every tool result lands in the conversation. mcpspy estimates both:

- The **Tokens** column shows what each result adds to the context.
- The **Tools** tab breaks a session's tool definitions down per tool. It also shows what changed in the tool list since that server's previous session (added, removed, or edited descriptions and schemas, with the token delta), plus per-tool call counts, errors, latency and result sizes.

![Tools tab](docs/tools.png)

```sh
mcpspy tokens                 # same report in the terminal, for the latest session
mcpspy tokens --exact         # exact counts from Anthropic's count_tokens API
```

Estimates are an offline heuristic (Claude's tokenizer isn't public), so treat them as relative sizes. `--exact` uses the [count_tokens](https://platform.claude.com/docs/en/build-with-claude/token-counting) endpoint (default model `claude-opus-5-5`, override with `--model`). It measures each tool by counting the request with and without it, and reports the fixed tool-use preamble separately. It needs `ANTHROPIC_API_KEY` or an `ant auth login` profile, and **sends the recorded tool definitions and results to Anthropic**. Results are cached in the log per model.

### Comparing calls

In the UI, click **Compare…** on one row, then select another. The detail pane shows the changed paths and a line diff of both requests and both responses. Lists of tools, prompts and resources are matched by `name` / `uri`, so an added or removed entry reads as exactly that. From the terminal:

```sh
mcpspy diff 12 40             # two requests: diffs their arguments and their responses
```

Or stay in the terminal:

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
| `mcpspy ui [--port 7777] [--open]` | Serve the web inspector on localhost. |
| `mcpspy tokens [--session <id>] [--exact] [--model <id>]` | Context cost of a session's tools, call stats, and tool list changes. |
| `mcpspy diff <id> <id>` | Diff two messages, or two requests and their responses. |

Every command accepts `--db <path>`. The default log is `~/.mcpspy/mcpspy.db`, or `$MCPSPY_DB` if set.

## How it works

- Bytes are forwarded in both directions as soon as they arrive, unchanged. A copy is split into newline-delimited frames and recorded separately, so a parsing or database error can never break the agent's session (the proxy warns once on stderr and keeps forwarding).
- Responses are paired with their request by sender and JSON-RPC id, so server-initiated requests (sampling, elicitation) pair correctly too. Latency is measured at the proxy.
- The server's stderr is passed through and logged, which often explains failures that look silent from the agent.
- Non-JSON output on stdout (a classic way to break an MCP server) is forwarded as-is and logged as `invalid`.
- Signals are forwarded to the server, and the proxy exits with the server's exit code.
- The UI server binds to 127.0.0.1 and rejects requests whose `Host` isn't a loopback name, because recorded payloads can contain tokens and other secrets.

## Development

```sh
npm test            # vitest
npm run typecheck
npm run dev -- tail # run the CLI from source via tsx

# UI with hot reload: API on :7777, Vite on :5173 proxying /api to it
npm run dev -- ui
npm run dev:ui
```

The web UI lives in `ui/` (React + Vite) and builds into `dist/ui`, which the CLI serves. It has no runtime dependencies: React is bundled at build time.
