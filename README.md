<h1 align="center">🔍 mcpspy</h1>

<p align="center">
    <strong>See, replay and mock what your AI agent says to its MCP servers.</strong><br>
    mcpspy sits between an agent (Claude Code, Cursor, Windsurf, …) and a <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server<br>
    and records every message: what was called, with what, how long it took, what failed and how much context it cost.
</p>

<p align="center">
    <a href="https://github.com/Jarryd-W-Hoffman/mcp-spy/actions/workflows/tests.yml"><img src="https://github.com/Jarryd-W-Hoffman/mcp-spy/actions/workflows/tests.yml/badge.svg" alt="Tests"></a>
    <img src="https://img.shields.io/badge/node-%E2%89%A522.13-5fa04e" alt="Node 22.13 or later">
    <img src="https://img.shields.io/badge/transports-stdio%20·%20Streamable%20HTTP%20·%20SSE-6366f1" alt="stdio, Streamable HTTP and SSE">
    <img src="https://img.shields.io/badge/license-MIT-22c55e" alt="MIT license">
</p>

<p align="center">
    <img src="docs/screenshot.png" alt="The mcpspy web UI: sessions on the left; request and response pairs in the middle, with mock badges, schema issue counts, errors and token estimates; and on the right an echo call whose GitHub token was recorded as [REDACTED]." width="900">
</p>

<p align="center">
    <a href="#why-mcpspy">Why mcpspy?</a> ·
    <a href="#quick-start">Quick start</a> ·
    <a href="#guide">Guide</a> ·
    <a href="#how-it-works">How it works</a> ·
    <a href="#your-log-on-disk">Your log on disk</a> ·
    <a href="#how-its-built">How it's built</a> ·
    <a href="#known-limitations">Known limitations</a> ·
    <a href="#development">Development</a>
</p>

---

## Why mcpspy?

MCP traffic is invisible. The agent says "the tool failed", or quietly picks the wrong tool, and all you have to go on is the model's summary of what happened. mcpspy shows you the messages themselves. Once it's installed, `mcpspy wrap` puts it in front of every stdio server in your `.mcp.json`.

- **See what really happened.** Every request, response, notification and stderr line, paired up, timed and searchable, live in a web UI or your terminal. Unlike the official [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which is a client *you* drive, mcpspy records what your *real agent* sends.
- **Know what it costs.** Every tool definition a server advertises is sent to the model on every turn. mcpspy shows how many tokens each tool and each result adds, and what changed since the server's last session.
- **Reproduce without re-prompting.** Replay any recorded call against a fresh server, edit its arguments, run it 20 times for a latency spread, or save it in a regression suite that runs in CI.
- **Catch protocol bugs early.** Arguments and results are checked against the schemas the server itself declared, as they pass through.
- **Decide what an agent may do.** A policy allows or refuses each call, with tests on its arguments (paths stay inside a folder, values match a pattern), rate limits, and limits on what results the agent sees.
- **Fake what isn't there.** Answer calls from mock rules (outages, rate limits, slow responses, bad payloads) to see how an agent copes, or stand in for a server that doesn't exist yet.
- **Nothing leaves your machine, and secrets stay out of the log.** The log is a SQLite file in your home folder. The UI and proxy only listen on localhost. Tokens and passwords in the traffic are replaced with `[REDACTED]` before they're stored. Environment variable values and HTTP headers such as `Authorization` are never recorded.

## Quick start

> [!NOTE]
> mcpspy isn't on npm yet. Install it from source; it needs **Node 22.13 or later** (for the built-in `node:sqlite`).

```sh
git clone https://github.com/Jarryd-W-Hoffman/mcp-spy.git
cd mcp-spy
npm install
npm run build
npm link        # puts `mcpspy` on your PATH
```

**Stdio servers** (ones your agent starts as a process): run `mcpspy wrap` next to your `.mcp.json`, and restart the agent.

```sh
mcpspy wrap              # puts mcpspy in front of every stdio server in .mcp.json
mcpspy wrap --dry-run    # shows what it would change, without changing it
mcpspy unwrap            # puts the config back as it was
```

It works on any JSON config that lists `mcpServers` or `servers`: pass the path for Cursor (`.cursor/mcp.json`), VS Code (`.vscode/mcp.json`), Claude Desktop (`claude_desktop_config.json`) or Windsurf. Use `--only <name>` to wrap one server. Use `--command <path>` when the agent can't find `mcpspy` on its PATH, which is common for desktop apps. The file is rewritten with its own indentation, so entries written on one line come back spread over several. It keeps its permissions, and a symlinked config (say, one kept in a dotfiles repo) stays a link, with the file it points to updated.

<details>
<summary>What <code>wrap</code> changes, if you'd rather edit by hand</summary>

Each server's command moves behind `mcpspy run --`:

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

</details>

**A server over HTTP** (remote, or local on a port): start a proxy, and give the agent the local URL it prints.

```sh
mcpspy proxy https://mcp.example.com/mcp --name example
# Point your agent at http://127.0.0.1:7800/mcp

claude mcp add --transport http example http://127.0.0.1:7800/mcp
```

**Then watch** while you use the agent as usual:

```sh
mcpspy ui --open      # the web inspector, at the http://localhost:7777/?key=… link it prints
mcpspy tail -f        # or follow along in the terminal
```

## Guide

### 👀 Watching traffic

Every session shows up live. Each row pairs a request with its response, with status, latency, size and token cost. Click a row to see both as a JSON tree or raw text, with tool results rendered the way the agent received them (text and images). Filter by server, text, notifications, stderr, errors or schema issues, and move between rows with <kbd>↑</kbd> / <kbd>↓</kbd>.

The terminal gets the same stream:

```
$ mcpspy tail -f
20:52:08.496 everything #1 → initialize id=0 150B
20:52:08.689 everything #2 stderr Starting default (STDIO) server...
20:52:08.716 everything #3 ← initialize ✓ 220ms id=0 3.4KB
20:52:08.729 everything #5 → tools/list id=1 46B
20:52:08.736 everything #6 ← tools/list ✓ 8ms ≈2.2k tok id=1 9.9KB
20:52:08.761 everything #7 → tools/call echo id=2 108B
20:52:08.765 everything #8 ← tools/call echo ✓ 4ms ≈6 tok id=2 89B
```

The server's stderr is recorded alongside its messages, which often explains failures that look silent from the agent. So is anything a server prints to stdout that isn't JSON-RPC (a classic way to break a stdio server): it's forwarded as-is and logged as `invalid`.

**Searching.** `mcpspy search <text>` finds every recorded message that contains the text, across all sessions, or in one with `--session <id>`. That covers tool arguments, results, errors and server stderr. Case is ignored, and text with quotes is found even though the log stores it JSON-escaped. Each match is shown with the text around it, and `mcpspy show <id>` opens one in full:

```
$ mcpspy search /etc/passwd
20:52:08.761 fs         #7 → tools/call read_file id=2 112B
    …"name":"read_file","arguments":{"path":"/etc/passwd"}}}
```

It lists the newest 50 matches (`-n` changes that) and exits with code 1 when nothing matches, like `grep`. `--json` writes one message per line.

### 🌐 Servers over HTTP

`mcpspy proxy <url>` handles both HTTP transports: **Streamable HTTP**, and the older **HTTP+SSE**. Requests go to the same path on the real server, with their headers. Each MCP session is recorded as its own session, including the JSON-RPC in POST bodies, JSON responses, and every event on SSE streams: progress notifications, and requests the server makes mid-call, such as `roots/list`. HTTP errors, such as a 401, are logged with the session. A session ends when the client sends `DELETE` or closes the stream. `--mocks` works here too.

<p align="center">
    <img src="docs/http.png" alt="A Streamable HTTP session and an SSE session interleaved in the web UI, with a roots/list request from the server selected." width="900">
</p>

Headers such as `Authorization` are forwarded but never recorded. Replays and suites against servers that need them take the headers on the command line: `mcpspy replay 42 -H "Authorization: Bearer $TOKEN"`.

**Servers that need a login.** Logging in with OAuth through the proxy doesn't work. The login service issues a token for the real server's URL, and the agent rejects it because it's talking to the proxy's URL. Instead, give the proxy a token, such as a personal access token or an API key. The proxy adds it to every request, replacing whatever the agent sends, so the agent never needs to log in:

```sh
mcpspy proxy https://api.githubcopilot.com/mcp/ --name github -H "Authorization: Bearer $GITHUB_TOKEN"
```

The startup message names the headers the proxy adds, but never their values. They're never recorded, and only ever sent to that server: a request aimed anywhere else (`GET http://elsewhere/`, or a path like `//elsewhere`) is refused.

### 🪙 Context cost

Every tool definition a server advertises is sent to the model with every request, and every tool result lands in the conversation. mcpspy estimates both:

- The **Tokens** column shows what each result adds to the context.
- The **Tools** tab breaks a session's tool definitions down per tool. It shows what changed since that server's previous session (tools added or removed, and edited descriptions and schemas, with the token change), plus per-tool call counts, errors, latency and result sizes.

<p align="center">
    <img src="docs/tools.png" alt="The Tools tab: a bar per tool showing its share of the tool list's tokens, and changes since the previous session." width="900">
</p>

```sh
mcpspy tokens                 # the same report in the terminal, for the latest session
mcpspy tokens --exact         # exact counts from Anthropic's count_tokens API
```

The estimates are an offline heuristic (see [Token estimates](#token-estimates)), so treat them as relative sizes. `--exact` asks the [count_tokens](https://platform.claude.com/docs/en/build-with-claude/token-counting) endpoint instead (default model `claude-opus-5-5`, change it with `--model`). It needs `ANTHROPIC_API_KEY` or an `ant auth login` profile, and **sends the recorded tool definitions and results to Anthropic**, so it only runs when you ask. Counts are cached in the log per model.

### ⚖️ Comparing calls

In the UI, click **Compare…** on one row, then select another. The detail pane shows the changed paths and a line diff of both requests and both responses. Lists of tools, prompts and resources are matched by `name` or `uri`, so an added or removed entry reads as exactly that, not as every later item shifting by one.

```sh
mcpspy diff 12 40             # two requests: diffs their arguments and their responses
```

### 🔁 Replay

Re-run any request the agent made, against a fresh copy of the server, without prompting the agent again.

```mermaid
sequenceDiagram
    autonumber
    participant You as mcpspy replay 42
    participant Log as SQLite log
    participant Server as Fresh server
    You->>Log: message 42, its session's command and cwd,<br/>the agent's initialize and its replies
    You->>Server: start it (stdio) or open a new session (HTTP)
    You->>Server: initialize (the agent's own params)
    Server-->>You: initialize result
    You->>Server: tools/call, with the recorded params or your edits
    Server->>You: roots/list (the server asks the client something)
    You-->>Server: the agent's recorded answer
    Server-->>You: result
    You->>Log: record it all as a new session,<br/>marked as a replay of the original
    You->>You: diff against the original response
```

Because the replay sends the agent's own `initialize` and answers the server's questions with the agent's recorded replies, the server sees the same client it saw the first time. Each replay is its own session, tagged *replay of #N*, so it can be inspected and diffed like any other traffic.

In the UI, select a request and click **Replay…** to edit its params and run it. The replayed call opens diffed against the original.

<p align="center">
    <img src="docs/replay.png" alt="A replayed get-sum call with edited arguments, diffed against the original response." width="900">
</p>

```sh
mcpspy replay 42                                # same params; diffs the response against the original
mcpspy replay 42 --args '{"query":"rust"}'      # new arguments for a tools/call
mcpspy replay 42 --repeat 20                    # latency spread over 20 runs in one server session
mcpspy replay 42 -e GITHUB_TOKEN=$GITHUB_TOKEN  # extra environment for a stdio server
mcpspy replay 42 -H "Authorization: Bearer $T"  # headers for a server over HTTP
```

mcpspy records the *names* of the environment variables each stdio server started with, never their values. If the original server had config-like variables (API keys, tokens, URLs) that aren't set when you replay, mcpspy names them, so you can pass them with `-e` or start `mcpspy ui` with them exported.

### 🧪 Replay suites

Save recorded calls to a JSON file in your server's repository, then check that the server still answers the same way, without an agent:

```sh
mcpspy suite add mcp.suite.json 42 57 63   # cases from recorded requests
mcpspy suite run mcp.suite.json            # exits 1 if any response changed
mcpspy suite run mcp.suite.json --update   # accept the new responses
```

```
✓ tools/call echo 6ms
✗ tools/call search_docs 41ms
    content[0].text  "3 results" → "0 results"
✓ tools/call get-sum 1ms

2 passed, 1 failed
```

A suite is plain JSON, meant to be reviewed and committed:

```json
{
  "version": 1,
  "servers": {
    "docs": {
      "command": ["node", "dist/index.js"],
      "cwd": ".",
      "initialize": { "protocolVersion": "2025-06-18", "capabilities": { "roots": {} }, "clientInfo": { "name": "claude-code", "version": "2.1.0" } },
      "clientReplies": { "roots/list": { "result": { "roots": [{ "uri": "file:///work/docs" }] } } }
    }
  },
  "cases": [
    {
      "name": "tools/call search_docs",
      "server": "docs",
      "method": "tools/call",
      "params": { "name": "search_docs", "arguments": { "query": "install" } },
      "expect": { "content": [{ "type": "text", "text": "3 results" }] },
      "ignore": ["structuredContent.took_ms"]
    }
  ]
}
```

Servers reached over HTTP are stored as `"url"` and `"transport"` instead of a command (never with headers; pass those to `suite run` with `-H`). A working directory below the suite file is stored relative to it, with forward slashes, so the suite runs on any OS. For values that change between runs, list their paths in a case's `ignore`: `*` matches one key and `[*]` any array index, e.g. `["structuredContent.now", "content[*].text"]`. Run it in CI like any other test command.

### ✅ Schema validation

Every message is checked as it is recorded, against what the server itself declared:

- **Calls:** `tools/call` arguments against the tool's `inputSchema` (JSON Schema draft-07 or 2020-12, with formats such as `uri` and `date-time`), and calls to tools the server never listed.
- **Results:** content blocks against the MCP rules (block types and their required fields, `isError`) and, when the tool has an `outputSchema`, `structuredContent` against it.
- **Tool lists:** duplicate names, names outside `A–Z a–z 0–9 _ - .`, and missing or invalid schemas.
- **The handshake:** an `initialize` result without a `protocolVersion`, `capabilities`, or `serverInfo` name and version, and requests other than `ping` sent before it arrived (warnings).
- **Capabilities:** each side may only use what the other declared in `initialize`. A server asking for `sampling`, `roots` or `elicitation` the client didn't declare is an error. A client calling `resources/*`, `prompts/*`, `tools/*`, `logging/setLevel` or `completion/complete` without the server's capability is a warning, since the server will just refuse (`completions` only from protocol `2025-03-26`, which added it). So are `list_changed` and `resources/updated` notifications the sender didn't declare. Sessions mcpspy joined after `initialize`, such as an HTTP session that started before the proxy, skip these checks.
- **Resources and prompts:** results of `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list` and `prompts/get` against the MCP shapes.

Issues show up as `⚠ 2 issues` in `tail`, as a badge and a list in the UI (with a *Schema issues* filter), and in `mcpspy validate`, which exits 1 on errors:

```
$ mcpspy validate
everything #1  tools/call get-sum request #19
  error    params.arguments  missing required property "b"
  error    params.arguments.a  must be number

2 errors, 0 warnings in 1 message
```

<p align="center">
    <img src="docs/validation.png" alt="A get-sum call with a string where a number belongs and a missing argument, with its two schema issues listed in the detail pane." width="900">
</p>

### 🎭 Mocks

A mock file holds rules that answer requests instead of the server, and tools to add to its tool list:

```json
{
  "tools": [
    { "name": "forecast", "inputSchema": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] } }
  ],
  "rules": [
    { "name": "outage", "match": { "tool": "forecast", "arguments": { "city": "Oslo" } }, "toolError": "Service unavailable" },
    { "name": "flaky search", "match": { "tool": "search*" }, "error": { "code": -32000, "message": "rate limited" }, "probability": 0.3 },
    { "name": "slow fetch", "match": { "tool": "fetch" }, "passthrough": true, "delayMs": 4000 },
    { "name": "hang", "match": { "method": "resources/read", "params": { "uri": "file:///big.log" } }, "drop": true },
    { "name": "forecast", "match": { "tool": "forecast" }, "text": "Sunny in {{arguments.city}}", "delayMs": 300 }
  ]
}
```

Each request from the agent goes through the rules in order:

```mermaid
flowchart LR
    R["Request from the agent"] --> M{"First rule that matches<br/>method · tool · arguments · server<br/>(and isn't used up by times<br/>or skipped by probability)"}
    M -->|none| S["Real server"]
    M -->|"result · error · text · toolError"| A["Answer after delayMs,<br/>recorded as [mock: rule]"]
    M -->|passthrough| D["Wait delayMs"] --> S
    M -->|drop| X["Never answer<br/>(test timeouts)"]
    S --> L{"tools/list<br/>response?"}
    L -->|yes| P["Add the mock tools"] --> C["Agent"]
    L -->|no| C
    A --> C
```

- **match** on `method`, `tool` (with `*` wildcards; implies `tools/call`), `arguments` or `params` (the request must contain these values), and `server` (the `--name`). The first matching rule wins.
- **Answer** with exactly one of `result`, `error`, `text` (a one-block tool result), `toolError` (the same, with `isError: true`), `passthrough` (forward to the real server after `delayMs`) or `drop`. Strings can use `{{arguments.city}}` or `{{params.uri}}`.
- **Limit** a rule with `times` (stop after N uses) or `probability` (0–1, for flaky behaviour), and slow it down with `delayMs`.

Use it in front of a real server with `mcpspy run --mocks mocks.json -- <cmd>` (or `mcpspy proxy --mocks`). Without a real server, `mcpspy mock serve mocks.json` is a stand-in that also answers `initialize`, `ping` and `tools/list` from the file. The file reloads when you save it; if the new version is broken, the old rules stay and a warning goes to stderr. `mcpspy mock add mocks.json <id>...` appends rules that reproduce recorded calls, copying each tool's definition from the session's tool list.

Mocked responses are recorded like real ones, and labelled with the rule that produced them. Mock tools are validated like real ones too, so a mock that breaks its own `outputSchema` gets flagged.

<p align="center">
    <img src="docs/mocks.png" alt="A mocked get-forecast call: the detail pane says which rule answered it, and mock badges mark the other mocked rows." width="900">
</p>

### 🛡️ Policies

A policy decides which calls an agent may make. mcpspy checks each request before it reaches the server: refused ones are answered by mcpspy and never arrive.

```json
{
  "default": "deny",
  "rules": [
    { "name": "no writes", "tool": "write_*", "deny": "writes need a human" },
    { "tool": "read_file", "where": { "path": { "under": ["./src", "./docs"] } }, "allow": true },
    { "tool": "query", "where": { "sql": { "match": "^select ", "notMatch": ";" }, "limit": { "max": 500 } }, "allow": true },
    { "tool": "search", "rate": "20/minute", "allow": true },
    { "tool": "deploy", "ask": "Deploy this to production?" },
    { "method": "resources/read", "where": { "uri": { "match": "^secret:" } }, "deny": "secret resources are off limits" }
  ],
  "results": { "maxBytes": 200000, "redact": ["ghp_[A-Za-z0-9]{36}"] }
}
```

```sh
mcpspy run --name files --policy policy.json -- npx -y @modelcontextprotocol/server-filesystem .
mcpspy wrap --policy policy.json      # every wrapped server gets it
```

Every request from the agent passes the policy before mock rules or the server see it, and replies are checked on the way back:

```mermaid
flowchart LR
    A["Agent"] --> J{"Valid JSON,<br/>not a batch?"}
    J -->|no| X["Refused"]
    J -->|yes| R{"First rule that matches<br/>tool · method · server · where"}
    R -->|"deny, a failed test,<br/>or rate limit reached"| D["Refusal with the reason,<br/>recorded as [policy: rule]"]
    R -->|"none, and default deny"| D
    R -->|allow| F["The message as checked<br/>(re-serialised)"] --> M["Mock rules"] --> S["Server"]
    R -->|ask| Q["Hold the call, ask the<br/>agent's user (elicitation)"]
    Q -->|accept| F
    Q -->|"decline, no answer,<br/>or no way to ask"| D
    S --> W["Redact matches in everything<br/>it sends (never the envelope)"] --> L{"Reply"}
    L -->|tools/list| H["Hide tools no call<br/>could use"] --> A
    L -->|tool result| C["Cap the size"] --> A
    L -->|"anything else"| A
    D --> A
```

- **Rules** are checked in order, and the first one that matches decides. A rule matches on `tool` (with `*` wildcards), or `method` for anything other than `tools/call`, and on `server` (the `--name`, with wildcards). It may also have a `where` of tests on the arguments (or a request's params), keyed by dot path. It then `allow`s (`true`), `deny`s with a reason the agent sees, or `ask`s with a prompt. When an allow rule's tests fail, the refusal names the argument (`"path" is not allowed for read_file`).
- **Tests**:
  - `under` (directories, relative to the policy file): the path must be inside one of them once symlinks are followed, so `src/../../etc` and a link out of `src/` both fail. A relative path in the arguments is resolved against the server's working directory. A leading `~` means the home directory, as servers that expand it read it, and `~user` paths are refused. Behind `mcpspy proxy`, the server's working directory and home aren't known, so only absolute paths and `file:` URIs can pass an `under` test.
  - `in`: one of a list of values.
  - `match` and `notMatch`: regular expressions.
  - `max`: for numbers.
  - `maxLength`: for strings.

  A missing argument fails every test.
- **Default**: a tool call no rule matches is denied, unless the file says `"default": "allow"`. Other methods, such as `initialize` and `tools/list`, pass unless a rule names them.
- **Asking**: an `ask` rule holds the call and asks the agent's user, through MCP elicitation, whether to let it through. The call goes ahead only if the user accepts. It's refused if they decline, if nobody answers within two minutes, or if the agent closes its connection first. If the agent cancels the call while it's held, the call is dropped and never runs, even if the user accepts afterwards. When an ask ends unanswered, the agent is told, so it can close its prompt. It's also refused if the agent didn't declare elicitation support, or if the server is behind `mcpspy proxy`: the HTTP proxy has no way to ask.
- **Rates**: `rate` on an allow rule (`"10/minute"`, per `second`, `minute`, `hour` or `day`) refuses calls beyond the limit, over a sliding window.
- **Tool lists** lose the tools no call could be allowed to use, so the agent doesn't plan around them. A tool that some arguments could unlock stays listed.
- **Results**: `maxBytes` replaces an oversized tool result with an error. `redact` replaces matches in everything the server sends the agent: tool results and lists, resource contents, prompts, errors, log notifications and the server's own requests (such as `sampling/createMessage`), batches included. The JSON-RPC envelope (`jsonrpc`, `id`, `method`) is never changed, so a broad pattern can't break the protocol. This is unlike [Secrets](#-secrets), which only changes the record.

A refused tool call gets a tool result with `isError: true` and the reason, so the agent can adjust. Other refused requests get a JSON-RPC error (code `-32001`). Each decision goes to stderr (`[mcpspy] policy denied tools/call write_file (no writes): writes need a human`), and its reply is recorded with the rule that decided it, or `default deny` when no rule matched. In the UI, those rows carry a **policy** badge.

**Start from a recording.** `mcpspy policy suggest` drafts a policy from a session, the latest by default or one chosen with `--session <id>`. The draft denies by default and allows each tool the session called. Where every call passed a path, the draft keeps that argument `under` the deepest directory that held them all:

```sh
mcpspy policy suggest > policy.json
```

```json
{
  "default": "deny",
  "rules": [
    { "name": "read_file (12 recorded calls)", "tool": "read_file", "where": { "path": { "under": "/home/me/app" } }, "allow": true },
    { "name": "search (3 recorded calls)", "tool": "search", "allow": true }
  ]
}
```

It allows what the session did, not what it should do, so review it before you rely on it.

**It fails closed:**
- **Broken policy:** mcpspy refuses to start the server, and `wrap` refuses to write the config.
- **Rules that could never match** are broken too. A policy checks what the agent sends, so a rule naming a request only servers send (`sampling/createMessage`, `elicitation/create`, `roots/list`, or a server notification) is refused rather than silently ignored.
- **Broken edit:** while running, the policy reloads when you save it. A broken edit keeps the old rules in force.
- **Keep it out of the agent's reach.** The policy reloads when its file changes, so an agent that can write the file can change its own rules. If it sits where the servers work (beside `.mcp.json`, say), make sure no tool it allows can write it, as `write_*` is denied above. Otherwise keep it elsewhere, with absolute `under` paths. mcpspy warns when the file is inside the server's working directory or the config's directory.
- **What the server sees:** the request exactly as it was checked, re-serialised. JSON with duplicate keys therefore can't show the policy one tool name and the server another.
- **Compressed replies:** behind `mcpspy proxy`, a reply the server compressed is decompressed and checked like any other. One in an encoding mcpspy can't read is refused (`502`).
- **Batches and invalid lines:** batched requests, and lines from the agent that aren't JSON, are refused.
- **Other HTTP methods:** behind `mcpspy proxy`, only `POST` bodies are checked, so a `PUT`, `PATCH` or any other request with a body is refused (`405`) and never reaches the server.

<p align="center">
    <img src="docs/policy.png" alt="A read_file call for project/../.ssh/id_ed25519 refused by the default deny rule: the detail pane gives the reason the agent saw, and policy badges mark every call the policy answered or changed." width="900">
</p>

The tools/list reply above lost `write_file` and `delete_branch`, which no rule allows:

<p align="center">
    <img src="docs/policy-tools.png" alt="A tools/list response with write_file and delete_branch hidden by the policy." width="900">
</p>

Policies work the same over HTTP: `mcpspy proxy <url> --policy policy.json` answers refusals itself, and filters and limits replies whether the server answers in JSON or over SSE. A remote server's working directory and home aren't known, so an `under` test there only accepts absolute paths and `file:` URIs.

### 🔒 Secrets

mcpspy removes secrets from what it records, before anything reaches the log. The agent and server still exchange the real values, because only the record changes.

- **Known formats**, wherever they appear: GitHub, GitLab, Anthropic, OpenAI, AWS, Slack, Stripe, Google, npm and Hugging Face keys, JWTs, `Bearer …` and `Basic …` credentials, private key blocks, `user:password@` in URLs, secrets in query strings (`?api_key=…`), and assignments to secret names (`--api-key=…`, `GITHUB_TOKEN=…`) with values of 8 characters or more.
- **Secret keys** in JSON: the values of `password`, `secret`, `token`, `access_token`, `api_key`, `authorization`, `cookie`, `private_key` and similar keys. Keys only match whole, so `progressToken` and `max_tokens` are kept.
- **Command lines** and HTTP URLs of servers, and stderr lines. On a command line, the argument after a secret flag (`--token <value>`, `--api-key <value>`) goes too.

```sh
mcpspy run --redact 'acct-\d+' -- my-server     # also remove your own patterns
mcpspy run --no-redact -- my-server             # turn the built-in patterns off
```

Both options work on `run` and `proxy`, and `--redact` can be repeated. A payload that held a secret is stored with `[REDACTED]` in its place, so replaying it would send that instead. Replay stops and explains: pass new arguments with `--args`. Replay can't restart a server whose command line held a secret either. Pass the secret in an environment variable or, over HTTP, a header (`-H`).

Patterns can't catch everything, such as a password in free text with nothing around it to recognise. Treat the log as sensitive anyway.

### Command reference

| Command | What it does |
| --- | --- |
| `mcpspy wrap [<config>] [--only <name>] [--dry-run] [--command <path>] [--policy <file>]` | Put mcpspy in front of the stdio servers in an MCP config (`.mcp.json` by default). |
| `mcpspy unwrap [<config>] [--only <name>] [--dry-run]` | Take it out again, restoring each server's command and args. |
| `mcpspy run [--name <label>] [--policy <file>] [--mocks <file>] [--redact <regex>] [--no-redact] -- <cmd> [args…]` | Start a stdio server behind the proxy. `--policy` decides which calls the agent may make. `mcpspy -- <cmd>` is shorthand. |
| `mcpspy proxy <url> [--port 7800] [--name <label>] [--policy <file>] [--mocks <file>] [-H 'Name: value']` | Proxy a server reached over HTTP (Streamable HTTP or HTTP+SSE). `-H` adds a header, such as a token, to every request. Takes `--redact` and `--no-redact` like `run`. |
| `mcpspy ui [--port 7777] [--open] [--read-only]` | Serve the web inspector on localhost, at the link it prints (it carries a new key each run). `--read-only` turns replay off. |
| `mcpspy tail [-f] [-n 50] [--session <id>] [--json]` | Print recorded messages; `-f` follows new ones, `--json` prints NDJSON rows. |
| `mcpspy sessions [--limit 20]` | List recorded sessions with their status and message count. |
| `mcpspy show <message-id>` | Pretty-print a message alongside its request or response. |
| `mcpspy search <text> [--session <id>] [-n <50>]` | Find recorded messages that contain some text (see [Watching traffic](#-watching-traffic)). |
| `mcpspy tokens [--session <id>] [--exact] [--model <id>]` | Context cost of a session's tools, call stats, and tool list changes. |
| `mcpspy diff <id> <id>` | Diff two messages, or two requests and their responses. |
| `mcpspy replay <id> [--args <json> \| --params <json>] [--repeat <n>] [-e K=V] [-H 'Name: value']` | Re-run a recorded request against a fresh server (or session) and diff the response. |
| `mcpspy suite add <file> <id>...` / `mcpspy suite run <file> [--update] [-H …]` | Save recorded calls as a regression suite, and run it. |
| `mcpspy export [--session <id>]...` / `mcpspy import <file \| ->` | Copy sessions between logs as JSON Lines (see [Moving and sharing sessions](#moving-and-sharing-sessions)). |
| `mcpspy prune [--older-than 30d] [--keep <n>] [--max-size 500MB] [--dry-run] [--vacuum]` | Delete old sessions so the log stops growing; `MCPSPY_RETENTION` makes `mcpspy ui` do it daily. |
| `mcpspy validate [--session <id>]` | List schema and protocol issues; exits 1 if there are errors. |
| `mcpspy mock serve <file>` / `mcpspy mock add <file> <id>...` | Run a stand-in server from mock rules; turn recorded calls into rules. |
| `mcpspy policy suggest [--session <id>]` | Draft a policy that allows what a session did (see [Policies](#%EF%B8%8F-policies)). |

Every command takes `--db <path>`. The default log is `~/.mcpspy/mcpspy.db`, or `$MCPSPY_DB` if it's set.

## How it works

mcpspy is three kinds of process that never talk to each other directly. They meet in one SQLite file:

```mermaid
flowchart LR
    subgraph agent ["Your agent"]
        A["Claude Code, Cursor, …"]
    end
    subgraph proxies ["Proxies (one per server)"]
        P1["mcpspy run<br/>(stdio)"]
        P2["mcpspy proxy<br/>(HTTP)"]
    end
    subgraph servers ["MCP servers"]
        S1["local server process"]
        S2["remote server"]
    end
    A <-->|"stdin / stdout"| P1 <-->|"stdin / stdout"| S1
    A <-->|"HTTP + SSE"| P2 <-->|"HTTP + SSE"| S2
    P1 -->|write| DB[("~/.mcpspy/mcpspy.db<br/>SQLite, WAL mode, 0600")]
    P2 -->|write| DB
    DB -->|read| T["mcpspy tail · tokens ·<br/>validate · diff"]
    DB <-->|"read · replay"| U["mcpspy ui<br/>(localhost:7777, per-run key)"]
    U -->|server-sent events| B["Browser"]
```

Your agent starts one `mcpspy run` per stdio server, so a busy setup has several proxies writing at once, plus a UI and a `tail` reading. SQLite in WAL mode lets readers and writers work side by side, and a busy timeout covers the moments two writers collide. No proxy has to know whether a UI is running.

### The stdio proxy: forward first, record second

The proxy's first job is to stay out of the way. Bytes are forwarded the moment they arrive, unchanged; a copy goes to a line splitter that records complete messages on the side:

```ts
// src/proxy/stdio.ts (simplified)
const onInput = (chunk: Buffer): void => {
  child.stdin.write(chunk);   // the agent's bytes reach the server untouched…
  fromClient.push(chunk);     // …and a copy is framed and recorded
};
child.stdout.on('data', (chunk: Buffer) => {
  output.write(chunk);        // the server's reply goes straight back
  fromServer.push(chunk);
});
```

```mermaid
sequenceDiagram
    participant Agent
    participant Proxy as mcpspy run
    participant Server
    participant Log as SQLite
    Agent->>Proxy: {"id":7,"method":"tools/call",…}\n
    Proxy->>Server: same bytes, immediately
    Proxy-)Log: record the request (on the side)
    Server->>Proxy: {"id":7,"result":…}\n
    Proxy->>Agent: same bytes, immediately
    Proxy-)Log: record the response, paired with<br/>its request: latency 41ms
```

Recording is wrapped so it can never take the session down: if the database fails, the proxy warns once on stderr and keeps forwarding. Signals are passed on to the server, and the proxy exits with the server's exit code, so the agent sees exactly what it would without mcpspy.

With `--policy` or `--mocks`, the proxy has to read a request before deciding whether the server sees it at all, so it handles whole lines instead of raw chunks (`src/proxy/interceptor.ts`). Those two options are the only reason it ever does. With a policy, what reaches the server is the message the policy checked, re-serialised, rather than the agent's bytes:

```mermaid
sequenceDiagram
    participant Agent
    participant Proxy as mcpspy run --policy
    participant Server
    Agent->>Proxy: tools/call read_file {"path":"project/src/app.ts"}
    Note over Proxy: rule "project files": path is under ./project
    Proxy->>Server: the checked message, re-serialised
    Server->>Proxy: result
    Note over Proxy: redact, cap the size
    Proxy->>Agent: result
    Agent->>Proxy: tools/call read_file {"path":"../.ssh/id_ed25519"}
    Note over Proxy: no rule allows it
    Proxy->>Agent: isError result: "path" is not allowed for read_file
    Note over Server: never sees the call
```

### From bytes to a recorded message

```mermaid
flowchart LR
    B["bytes"] --> F["LineSplitter<br/>one frame per \n line"]
    F --> C["classifyFrame<br/>request · notification ·<br/>response · error · invalid<br/>(batches expanded)"]
    C --> R["redact secrets"]
    R --> P["pair responses<br/>with requests"]
    P --> T["estimate tokens<br/>for results"]
    T --> V["validate against<br/>declared schemas"]
    V --> D[("messages row")]
```

Requests flow both ways in MCP: servers ask the client for roots, sampling and elicitation. So pending requests are keyed by **who sent them** as well as their JSON-RPC id. Otherwise a server's request `id: 0` would collide with the agent's own `id: 0`:

```ts
// src/recorder.ts
if (message.kind === 'response' || message.kind === 'error') {
  const requester = direction === 'server' ? 'client' : 'server';
  const request = this.pending.get(`${requester}:${message.rpcId}`);
  // → request_id, latency_ms, and the method the response answers
}
```

Validation works the same way, one session at a time: the session's latest tool list (joined across pages, when the server sends it in pages) is compiled into JSON Schema validators (with [Ajv](https://ajv.js.org)), and each later call and result is checked against them as it passes.

### The HTTP proxy

Over HTTP, one MCP session is spread across many HTTP requests. A POST can be answered with plain JSON, or with an SSE stream that carries progress notifications and even requests *to* the client before the final result. mcpspy has to follow all of it and put it back together as one session.

```mermaid
sequenceDiagram
    participant Agent
    participant Proxy as mcpspy proxy
    participant Server
    Agent->>Proxy: POST /mcp initialize
    Proxy->>Server: POST /mcp initialize
    Server-->>Proxy: 200 JSON, Mcp-Session-Id: S1
    Note over Proxy: new session in the log, bound to S1
    Proxy-->>Agent: 200 JSON, Mcp-Session-Id: S1
    Agent->>Proxy: POST tools/call (Mcp-Session-Id: S1)
    Proxy->>Server: POST tools/call
    Server-->>Proxy: 200 text/event-stream
    Proxy-->>Agent: event: notifications/progress
    Proxy-->>Agent: event: roots/list (a request to the agent)
    Agent->>Proxy: POST the roots/list reply (S1)
    Proxy->>Server: POST the reply
    Proxy-->>Agent: event: the tools/call result
    Agent->>Proxy: DELETE /mcp (S1)
    Note over Proxy: session closed
```

Each request is matched to a session like this:

| The request has… | Recorded in |
| --- | --- |
| an `Mcp-Session-Id` header mcpspy has seen | that session |
| an `Mcp-Session-Id` mcpspy hasn't seen | a new session (it started before the proxy did) |
| no header, and it's an `initialize` | a new session, bound to the id in the server's reply |
| no header, on a legacy `/messages?sessionId=…` endpoint | the session whose event stream named that endpoint |
| none of these | the latest session, for servers that never assign ids |

A session ends when the agent sends `DELETE`, when its legacy event stream closes, or after 30 minutes with no traffic and nothing in flight (no open stream, no request awaiting its reply). An agent can vanish without saying goodbye, so the idle limit stops the proxy holding on to its sessions forever. A request that names an ended session starts a new one.

The legacy HTTP+SSE transport works differently. The client opens an event stream with a GET, and the server's first event names the URL to POST messages to. When that URL is absolute, the proxy rewrites it to point at itself, or the agent's messages would go straight past it.

To make that possible, SSE responses are forwarded **one event at a time** rather than byte by byte. Each event is held until its terminating blank line, recorded, rewritten if it has to be, then sent. An event isn't usable by the client until that blank line anyway, so this adds no delay. JSON responses are buffered and forwarded whole. The proxy asks the server for uncompressed bodies so it can read them. If a server compresses anyway (gzip, deflate or brotli), the proxy decompresses the reply and forwards it plain, so what's recorded and checked is exactly what the agent gets. A reply in an encoding mcpspy can't read passes through untouched, unless a policy is set: then it's refused, since it can't be checked.

### The live UI

`mcpspy ui` is a small `node:http` server plus a React app. Because the proxies are separate processes, the UI can't be told about new messages; it watches the log instead. One shared poller asks SQLite for rows past the last id it has seen (every 250 ms, an indexed query that costs almost nothing), and pushes them to every open browser tab over server-sent events. A tab that reconnects says which id it saw last and gets what it missed.

Every request needs the key `mcpspy ui` made when it started, since anyone on the machine can reach loopback. The printed link carries it once:

```mermaid
sequenceDiagram
    participant You as Your browser
    participant UI as mcpspy ui
    You->>UI: GET /?key=K (the printed link)
    UI-->>You: 303 to /, Set-Cookie: mcpspy_key_7777=K (HttpOnly, SameSite=Strict)
    You->>UI: GET /, /api/…, /api/events (the cookie goes along)
    UI-->>You: 200
    Note over You,UI: Without the cookie (another user, another site): 401
```

### Token estimates

Claude's tokenizer isn't public, so offline estimates use a heuristic that's close enough to compare sizes:

```ts
// src/tokens.ts
return Math.ceil(ascii / 3.5 + other);   // ~3.5 ASCII characters per token, 1 per other character
```

Images are costed by their pixel dimensions (read from the PNG, GIF, JPEG or WebP header), the way Claude scales them. `--exact` measures instead of estimating. It counts a request with every tool, then with each tool left out; the difference is that tool's cost, and what's left over is the fixed tool-use preamble.

### Security model

Recorded traffic often holds secrets: tokens in tool arguments, private documents in results. So:

- **Only localhost.** The UI and the HTTP proxy bind to `127.0.0.1` and refuse requests whose `Host` isn't a loopback name, which stops DNS-rebinding attacks from a web page. The proxy also refuses a non-local `Origin`.
- **Replay can't be triggered cross-site.** Replay starts processes, so its endpoint also requires a custom header and a JSON body. A cross-site request can't send those without a CORS preflight, and mcpspy never approves one. It also checks `Origin` and `Sec-Fetch-Site`. No other site may frame the UI (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), so a hidden frame can't trick you into clicking Replay. `mcpspy ui --read-only` turns replay off entirely.
- **Secrets are removed before they're stored.** Well-known credential formats and the values of secret-sounding keys are replaced with `[REDACTED]` in everything recorded. See [Secrets](#-secrets).
- **Names, not values.** For stdio servers, mcpspy stores the names of environment variables (so replay can say which are missing), never their values. Over HTTP, headers are never stored at all.
- **A key per run.** Loopback is shared by every user on the machine, so `mcpspy ui` makes a random key each time it starts and prints a link carrying it. Opening the link swaps the key for an `HttpOnly`, `SameSite=Strict` cookie and drops it from the address bar. Without the cookie, every request gets `401`, so another user can't read your log through the UI or replay calls as you.
- **The HTTP proxy is for anyone on this machine.** `mcpspy proxy` can't tell which local user is talking to it, so on a shared machine any of them can use it, and the `-H` headers it adds. Use `-H` tokens there only if they'd be fine in those users' hands.
- **Opt-in network calls.** Nothing is sent anywhere unless you run `mcpspy tokens --exact`, which says so in its help.

## Your log on disk

Everything lives in one SQLite file, `~/.mcpspy/mcpspy.db` (or `--db` / `$MCPSPY_DB`). It holds tool arguments, results and server output, so only you can read it: the file (and its `-wal` and `-shm` companions) is `0600` and `~/.mcpspy` is `0700`, tightened each time mcpspy opens the log.

Its tables:

| Table | One row per |
| --- | --- |
| `sessions` | server session: name, transport (`stdio`, `http`, `sse`, `mock`, `replay`), command or URL, working directory, start and end, exit code, the session it replays, and its message count (kept up to date by a trigger) |
| `messages` | message: direction, kind, method, JSON-RPC id, the payload (secrets redacted), the request it answers, latency, tokens, schema issues, and the mock rule that answered it |
| `exact_counts` | cached `count_tokens` result per message and model |

It's yours to query. For example, the slowest tools across every session:

```sql
SELECT json_extract(req.payload, '$.params.name') AS tool,
       count(*)                                    AS calls,
       round(avg(res.latency_ms))                  AS avg_ms,
       sum(res.tokens)                             AS tokens
FROM messages res
JOIN messages req ON req.id = res.request_id
WHERE res.method = 'tools/call'
GROUP BY tool
ORDER BY avg_ms DESC;
```

```
tool                            calls  avg_ms  tokens
------------------------------  -----  ------  ------
trigger-long-running-operation  1      2019    19
get-forecast                    2      93      11
echo                            3      20      26
get-sum                         3      10      64
```

For a pipeline instead, `mcpspy tail --json` prints the same rows as NDJSON.

### Keeping it small

The log keeps everything until you prune it. A busy day of agent work can record thousands of messages, so trim it now and then:

```sh
mcpspy prune --older-than 30d --dry-run   # list what would be deleted
mcpspy prune --older-than 30d             # delete sessions last active over 30 days ago
mcpspy prune --keep 200                   # keep the 200 most recently active sessions
mcpspy prune --max-size 500MB             # delete the oldest sessions until the log fits
```

Or set `MCPSPY_RETENTION` to an age, a size, or both (`30d`, `1GB`, `30d,1GB`). `mcpspy ui` then prunes when it starts and once a day while it runs.

- **Running sessions are safe.** A session's age counts from its last activity, and one that hasn't ended and recorded something in the last hour is never deleted.
- **Proxies keep recording.** Deletion runs in small batches with pauses in between, so proxies writing to the same log wait at most a moment. On a million-message log, a concurrent writer's slowest insert during a prune took 80 ms.
- **Freed space is reused.** New recordings fill it, so the file stops growing, but it doesn't shrink on its own. Add `--vacuum` to shrink it now. That locks the log briefly and needs free disk space about the size of the log, so run it when no agent is busy.

Or delete the file to start over.

### Moving and sharing sessions

`mcpspy export` writes sessions as JSON Lines: all of them by default, or the ones you pick with `--session <id>` (repeatable). `mcpspy import` adds them to another log, such as a teammate's or the one on another machine:

```sh
mcpspy export --session 12 > flaky-search.jsonl
mcpspy import flaky-search.jsonl          # or: … | mcpspy import -
```

- **They arrive as new sessions.** Imported sessions get new ids. The links between them come along: which response answers which request, and which session a replay came from. Links to sessions outside the file are dropped.
- **Nothing is imported unless everything is.** Each line is checked, and the whole import runs in one transaction, so a bad line imports nothing and the error names the line.
- **Imported servers are never started.** An imported session's command or URL came from someone else's file, so `mcpspy replay` and `mcpspy suite add` refuse it: replaying would run their program, or send your `-H` headers to their URL. Record the server yourself to replay its calls.
- **Check an export before you share it.** Secrets mcpspy redacted while recording stay redacted, but tool arguments and results are included as recorded.

## How it's built

| Part | Technology |
| --- | --- |
| CLI and proxies | TypeScript on Node.js, with only `node:` built-ins for processes, HTTP and streams |
| Log | [`node:sqlite`](https://nodejs.org/api/sqlite.html) (SQLite built into Node), in WAL mode |
| Validation | [Ajv](https://ajv.js.org) with [ajv-formats](https://github.com/ajv-validator/ajv-formats), for draft-07 and 2020-12 schemas |
| Web UI | [React 19](https://react.dev) and [Vite 8](https://vite.dev), bundled into `dist/ui` and served by the CLI |
| Exact token counts | [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript), loaded only for `--exact` |
| Tests | [Vitest](https://vitest.dev), against real child processes and real HTTP servers; the UI with [Testing Library](https://testing-library.com) in jsdom |

```text
src/
├── bin.ts              ← the executable: starts cli.ts
├── cli.ts              ← every command
├── proxy/
│   ├── stdio.ts        ← mcpspy run
│   ├── interceptor.ts  ← policy and mock rules applied to stdio traffic
│   ├── http.ts         ← mcpspy proxy (Streamable HTTP and HTTP+SSE)
│   └── mock-server.ts  ← mcpspy mock serve
├── framing.ts · sse.ts · jsonrpc.ts   ← bytes → frames → classified messages
├── recorder.ts         ← pairs, costs and validates each message, then stores it
├── store.ts            ← the SQLite log
├── tokens.ts · exact.ts · report.ts   ← context cost
├── validate.ts         ← schema checks
├── mocks.ts            ← mock rules
├── policy.ts           ← policy rules: which calls an agent may make
├── policy-suggest.ts   ← mcpspy policy suggest
├── transfer.ts         ← mcpspy export and import
├── rpc-client.ts · http-client.ts     ← the minimal clients replay and suites use
├── replay.ts · suite.ts · diff.ts
└── server.ts           ← the UI's API and live stream
ui/src/                 ← the React app
```

### Why this stack?

**TypeScript on Node,** because that's where MCP lives. Most servers are started with `npx`, the official SDKs are TypeScript-first, and anyone running an MCP server already has Node installed. A Go or Rust binary would start faster and ship as one file, but it would ask people to install a new runtime for a debugging tool.

**`node:sqlite` rather than a SQLite package,** because the popular ones (such as `better-sqlite3`) are native modules, compiled for each platform and Node version, and they're the classic thing that breaks `npm install`. The built-in module needs nothing compiled. The cost is the Node 22.13 minimum, and an API that's younger than the packages it replaces.

**No web framework.** The UI's API is a handful of routes, and `node:http` covers them; the HTTP proxy needs raw access to streams and headers that frameworks tend to hide. The React app is bundled at build time, so the CLI has just three runtime dependencies, and one of those only loads for `--exact`.

**Polling SQLite instead of messaging between processes.** Proxies, the UI and `tail` are separate processes started at different times by different parents. A shared database with an indexed "rows after id N" query is simpler and sturdier than sockets between them, and a quarter of a second of delay is invisible when you're watching an agent work.

**Raw JSON-RPC instead of the MCP SDK for replays.** The SDK would rebuild requests its own way, and validate them. A replay has to send exactly what was recorded, or exactly your edit, even when that's invalid, because sometimes the invalid request is the bug you're chasing.

## Performance

mcpspy sits in the path of every message, so it has to be cheap. Here's how it behaves against a real server.

### A real session

[`bench/notes-server.mjs`](bench/notes-server.mjs) is a small notes server built with the official MCP SDK. It has seven tools, including one that's slow, one that can fail and one that takes a password, plus a resource. It runs over stdio or Streamable HTTP. [`bench/agent.mjs`](bench/agent.mjs) plays an agent's session against it: list tools and resources, search, save a note containing a GitHub token, read it back, ask for a note that doesn't exist, log in, summarise, and read a resource.

Run through `mcpspy run` and `mcpspy proxy`, the agent got the same results as without mcpspy, over both transports:

- **Every message was recorded:** 22 for the stdio session, including the server's stderr line, and 21 over HTTP. The latencies were right: the slow tool sleeps 150 ms and was recorded at 152 ms over stdio and 154 ms over HTTP. The missing note was flagged as a tool error.
- **No secrets were stored.** The GitHub token in the note, the password and the API key in the login reply appear nowhere in the log, including where the server echoed the token back. Neither do a token passed to the server as `--api-token <value>` and the `Authorization` header given to `mcpspy proxy -H`. The agent still received every real value.
- **The log stayed private.** It was created `0600`, and a `~/.mcpspy` left `0775` was closed to `0700`.
- **Validation caught a confused agent.** [`bench/bad-agent.mjs`](bench/bad-agent.mjs) sends a string where an integer belongs, leaves out a required field, and misspells a tool name. `mcpspy validate` reported all three against the server's own schemas, with clearer messages than the server's errors.
- **Replay** re-ran a recorded search with new arguments against a fresh copy of the server, three times, and diffed the result against the original. For the session whose command line held the redacted `--api-token`, it refused and said why.
- **Search and export** found the recorded traffic, and an export of both sessions (43 messages) imported into a fresh log intact.

The same session ran again under a policy that denies `login`, allows `get_note` only up to id 50, asks before `summarize_notes`, and redacts GitHub tokens from what the agent receives:

- **The agent never saw `login`:** the tool list it got had six tools, recorded as `[policy: hid login]`.
- **Refusals arrived as tool errors with the reason**, over both transports: `only notes 1-50` for note 99, and `sign in yourself` for the login. The agent can't answer an ask, so `summarize_notes` was refused, and behind `mcpspy proxy` the reason says asking only works with `mcpspy run`.
- **The note came back with its token redacted** (`[policy: result redacted]`), while the allowed calls behaved as before.
- **Policy placement:** copied into the server's working directory, the policy got a warning that the agent could rewrite it.
- **Proxy targets:** requests aimed past the upstream (`GET http://…/mcp`, `//example.com/x`) got `400`.

### Overhead

[`bench/bench.mjs`](bench/bench.mjs) (`npm run bench`) sends the same workloads to the notes server directly, through mcpspy, and through mcpspy with a policy, over each transport. The policy is a typical one: it allows by default, denies one tool, and limits and scans every result for a pattern of its own. Medians of three runs on a laptop (8 × Intel i7-10510U, Node 24.21, Linux):

| | p50 | p95 | p99 | calls/s, one at a time | calls/s, 64 at once | 100 KB result | 1 MB result | 5 MB result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stdio, direct | 0.10 ms | 0.17 ms | 0.26 ms | 8,938 | 47,682 | 0.7 ms | 9.4 ms | 107 ms |
| stdio, through mcpspy | 0.15 ms | 0.26 ms | 0.39 ms | 5,701 | 9,226 | 3.0 ms | 33.8 ms | 302 ms |
| stdio, through mcpspy with a policy | 0.26 ms | 0.38 ms | 0.54 ms | 3,689 | 6,629 | 4.0 ms | 52.3 ms | 375 ms |
| HTTP, direct | 0.88 ms | 1.54 ms | 2.47 ms | 1,005 | 2,098 | 1.5 ms | 8.6 ms | 37 ms |
| HTTP, through mcpspy | 1.47 ms | 2.06 ms | 2.51 ms | 640 | 1,787 | 5.3 ms | 45.7 ms | 368 ms |
| HTTP, through mcpspy with a policy | 1.49 ms | 2.14 ms | 2.64 ms | 636 | 1,788 | 6.0 ms | 55.8 ms | 414 ms |

The latency columns are for `ping`, a tool that answers immediately, so they show mcpspy's overhead with nothing else in the way. What this means in practice:

- **Typical calls gain well under a millisecond:** about 0.05 ms over stdio and 0.6 ms over HTTP. An agent waits seconds for each model turn, so this is invisible.
- **A policy adds about 0.1 ms a call** over stdio, where it checks and re-serialises each request and checks each reply. Over HTTP it's lost in the noise.
- **Throughput tops out at thousands of calls a second.** Through mcpspy, stdio handled about 9,200 calls a second with 64 in flight, and about 6,600 with a policy; recording each message is the limit. Agents make a few calls a second.
- **Large results cost the most.** mcpspy parses each message, scans it for secrets, estimates its tokens and stores it. That adds about 25–40 ms to a 1 MB result, and 200–330 ms to a 5 MB one. A policy adds 10–20 ms and 40–70 ms more, to limit and scan the result again. Most of it is the secret scan: recording a 5 MB result took 145 ms, of which 92 ms was redaction and 25 ms the token estimate.
- **Memory:** about 80 MB during 5,000 ordinary calls, 83 MB with a policy. It peaked at about 235 MB in the benchmark (245 MB with a policy) while handling the 5 MB results.
- **The log:** about 190 bytes per small message. Each benchmark run's log reached 53 MB, nearly all of it the large reports. Use [`mcpspy prune`](#keeping-it-small) to keep it in check.

Numbers vary from run to run and machine to machine; a laptop's clock speed alone moves them by tens of percent. Run `npm run bench` to measure yours.

## Known limitations

- **Not on npm yet.** Install from source for now.
- **No OAuth login through `mcpspy proxy`.** The agent rejects a login for a URL other than the one it's using. Pass a token with `-H` instead; see [Servers over HTTP](#-servers-over-http).
- **Replays from the UI can't send headers.** HTTP servers that need `Authorization` fail there with a 401 and a hint; use `mcpspy replay -H` instead.
- **Mock rules apply to single requests.** Batched requests always go to the real server.
- **Very large results are slower to pass through.** A 5 MB result takes a few hundred milliseconds longer, mostly to scan it for secrets. See [Performance](#performance).
- **Policies check what the agent sends.** Requests the server sends the agent (sampling, elicitation, roots) can't be refused, though a policy's `redact` still applies to them. A rule naming one is rejected when the policy loads.
- **`ask` rules need `mcpspy run`.** Behind `mcpspy proxy`, there's no way to ask the agent's user, so an `ask` rule refuses instead.
- **Policies test values, not meaning.** A pattern such as `^select ` narrows what a query tool receives, but it isn't a SQL parser. For a hard guarantee, give the server credentials that can only read.
- **Token estimates are estimates.** Use them to compare sizes, or `--exact` for real numbers.
- **One log per machine by default.** Sessions from every project share `~/.mcpspy/mcpspy.db`; use `--db` or `MCPSPY_DB` to keep a project's traffic apart.

## Development

```sh
npm test              # Vitest
npm run test:coverage # the same, failing below 100% coverage (as CI does)
npm run typecheck     # the CLI and the UI
npm run build         # dist/ (CLI) and dist/ui (web UI)
npm run dev -- tail   # run the CLI from source via tsx
npm run bench         # overhead against a real MCP server (Linux; build first)

# The UI with hot reload: the API on :7777, Vite on :5173 proxying /api to it.
# Open the link `ui` prints once, so the browser holds its key, then use :5173.
npm run dev -- ui
npm run dev:ui
```

Every line, branch and function of the CLI and the UI is tested, and CI fails if coverage drops below 100%. The tests run against real processes and sockets rather than mocks of them. A stdio fixture server (`test/fixtures/echo-server.mjs`) can echo, stall, ask the client for roots, and print junk to stdout on purpose. An HTTP fixture (`test/fixtures/http-server.ts`) speaks both Streamable HTTP and legacy SSE, including a mid-call request to the client.

[GitHub Actions](.github/workflows/tests.yml) runs on every push and pull request:

- **Types, tests (with 100% coverage) and the build** on Node **22.13.0** (the oldest version mcpspy supports, so the `engines` promise is checked) and Node **24**.
- A **smoke test** of the built CLI: proxy a real stdio server, then read the result back with `tail`.
- **`npm audit`** for known vulnerabilities in dependencies.

Dependabot proposes grouped weekly updates for npm packages and GitHub Actions.

### Contributing

Pull requests are welcome.
- Work on a feature branch and keep commits small.
- Each change comes with tests, and `npm run test:coverage` and `npm run typecheck` should pass before you open a PR.
- If you change what's recorded, check an old log still opens: columns are added by migrations in `src/store.ts`, and older sessions are backfilled when a log is opened.

## License

mcpspy is open-source software licensed under the [MIT license](LICENSE).
