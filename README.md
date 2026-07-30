# oz-acp

An [Agent Client Protocol (ACP)](https://agentclientprotocol.com) stdio adapter for Warp’s [`oz`](https://docs.warp.dev/reference/cli) CLI. It bridges Oz into ACP hosts like [Zed](https://zed.dev).

Modeled after [`agy-acp`](../agy/agy-acp), but implemented in TypeScript and driven by Oz CLI JSON (not local SQLite).

```
Zed (ACP host)  <--stdin/stdout NDJSON-->  oz-acp  <--subprocess-->  oz  <--API-->  Warp
```

## Prerequisites

- **Node.js 20+**
- **pnpm** (recommended) or npm/npx
- **`oz`** on your `PATH` (Warp CLI / Homebrew)
- Auth via `oz login` **or** `WARP_API_KEY`

Check tools:

```bash
node -v
pnpm -v   # or: npm -v
oz --version
oz whoami --output-format json
```

If `oz whoami` fails, run `oz login` first.

## Setup

From the repo root:

```bash
# 1. Install dependencies
pnpm install

# 2. Ensure the bin is executable
chmod +x bin/oz-acp.mjs

# 3. Smoke-check the adapter (stdio JSON-RPC)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | node bin/oz-acp.mjs
```

You should see a JSON-RPC result with `"agentInfo":{"name":"oz",...}` on stdout. Diagnostic logs go to stderr only.

### Optional: put `oz-acp` on your PATH

```bash
# link this checkout globally
pnpm link --global
oz-acp   # now available as a command

# or run without linking
pnpm exec oz-acp
node bin/oz-acp.mjs
```

After publish (or from a path install):

```bash
npx oz-acp
```

### No compile step

TypeScript runs in-place via **tsx**:

- `bin/oz-acp.mjs` spawns `node --import tsx src/index.ts`
- `tsx` is a **runtime** dependency so cold `npx`/global installs work
- `pnpm typecheck` (`tsc --noEmit`) is optional and not required to run

## Usage

`oz-acp` is an **ACP agent server**. An ACP host (editor/UI) starts it as a subprocess and speaks [JSON-RPC over stdio](https://agentclientprotocol.com) (newline-delimited JSON). You normally do **not** run it interactively yourself—the host owns the transport.

### What you can do with it

| Goal | How |
|---|---|
| Use Oz from Zed’s Agent Panel | Register `oz-acp` as a custom agent server (below) |
| Resume a prior chat | Host calls `session/load` / `session/resume` with the saved `sessionId` |
| Pick model / effort / profile | Host config UI or `session/set_config_option` (`model`, `effort`, `profile`, `computer_use`) |
| Cancel an in-flight turn | Host sends `session/cancel` |
| Point Oz at a project directory | Host passes `cwd` on `session/new` (mapped to `oz agent run --cwd`) |

### Typical ACP session flow

1. Host starts `oz-acp` and calls **`initialize`** (ACP protocol version `1`).
2. Host calls **`session/new`** with an absolute `cwd` (your project root).
3. Host sends **`session/prompt`** with text content blocks.
4. Adapter starts `oz agent run`, polls the run/conversation, and streams **`session/update`** notifications (`agent_message_chunk`, `tool_call`, `tool_call_update`, …).
5. When the Oz run finishes, **`session/prompt`** returns `{ "stopReason": "end_turn" }` (or `"cancelled"`).
6. Later turns reuse the same ACP `sessionId`; the adapter continues the bound Oz `conversationId`.

Supported agent methods include: `initialize`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/delete`, `session/prompt`, `session/cancel`, `session/set_config_option` (plus `session/set_model` aliases).

### Run the adapter manually (debug only)

```bash
# stdio server — host would attach here
node bin/oz-acp.mjs
# or
pnpm exec oz-acp
```

Smoke without a full host:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"'"$(pwd)"'","mcpServers":[]}}' \
  | node bin/oz-acp.mjs
```

Expect JSON-RPC responses for `initialize` and `session/new` on stdout. Keep logs on stderr only—stdout is the ACP transport.

### Prompt example (conceptual)

Hosts send prompts like:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "<id from session/new>",
    "prompt": [
      { "type": "text", "text": "Summarize the README in this repo." }
    ]
  }
}
```

While the turn runs, the adapter emits `session/update` notifications, then answers the original request with a `stopReason`.

### Session config options

On `initialize` / session setup, `oz-acp` loads `oz model list` and `oz agent profile list`, then exposes ACP `configOptions`:

| `configId` | Type | Notes |
|---|---|---|
| `model` | select | Full Oz model id from `oz model list` |
| `effort` | select | `low` / `medium` / `high` / `xhigh` / `max` (and related) when the current model family has effort-suffixed variants; rewriting the model id (e.g. `claude-4-8-opus-high` → `…-low`) |
| `profile` | select | From `oz agent profile list` → `oz agent run --profile` |
| `computer_use` | boolean | Passed via a temp agent config file as `computer_use_enabled` |

Oz does **not** support a free-form `temperature` setting in agent config / CLI, so it is not exposed.

Switch options from the host UI when supported, or via:

- `session/set_config_option` with the `configId`s above
- `session/set_model` / `session/setModel` aliases (model only)

### Extra Oz args

Pass extra CLI flags to every `oz` invocation with `OZ_EXTRA_ARGS`:

```bash
OZ_EXTRA_ARGS='--debug' node bin/oz-acp.mjs
```

## Use with Zed

Edit `~/.config/zed/settings.json`.

**Recommended (absolute path to this checkout):**

```json
{
  "agent_servers": {
    "oz": {
      "type": "custom",
      "command": "node",
      "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"],
      "env": {}
    }
  }
}
```

**If `oz-acp` is on your PATH:**

```json
{
  "agent_servers": {
    "oz": {
      "type": "custom",
      "command": "oz-acp",
      "args": [],
      "env": {}
    }
  }
}
```

**With extra Oz args / API key:**

```json
{
  "agent_servers": {
    "oz": {
      "type": "custom",
      "command": "oz-acp",
      "args": [],
      "env": {
        "OZ_EXTRA_ARGS": "--debug",
        "WARP_API_KEY": "your-key-if-needed"
      }
    }
  }
}
```

Then:

1. Open the Agent Panel (`Cmd-?` on macOS)
2. Select **oz** from the agent dropdown
3. Start chatting in a project workspace (that directory becomes the session `cwd`)

To inspect JSON-RPC traffic in Zed, use **dev: open acp logs** from the command palette.

## Environment variables

| Variable | Description |
|---|---|
| `OZ_BIN_PATH` | Full path to the `oz` binary |
| `OZ_INSTALL_PATH` | Directory containing `oz` |
| `OZ_EXTRA_ARGS` | Shell-style extra args prepended to every `oz` invocation |
| `WARP_API_KEY` | API key (passed through to `oz`) |
| `XDG_CONFIG_HOME` | Config root for session persistence (`$XDG_CONFIG_HOME/oz-acp`) |
| `HOME` | Fallback config root when `XDG_CONFIG_HOME` is unset (`~/.config/oz-acp`) |

## Session persistence

Sessions are stored at `$XDG_CONFIG_HOME/oz-acp/sessions.json` (default `~/.config/oz-acp/sessions.json`) with a lock file. Bindings include `conversationId`, `lastRunId`, `modelId`, `cwd`, and emitted content keys for replay/delta.

Model IDs are cached at `$XDG_CONFIG_HOME/oz-acp/models_cache.json` (default `~/.config/oz-acp/models_cache.json`).

## How a prompt turn works

1. Flatten ACP text prompt blocks
2. `oz agent run --output-format json -p ... --cwd ... [--model] [--conversation]`
3. Poll `oz run get <run_id>` + conversation JSON every ~500ms
4. Map new `text` / `action` / `action_result` blocks to `session/update`
5. Complete `session/prompt` with `{ stopReason: "end_turn" | "cancelled" }`

## Development

```bash
pnpm install
pnpm start          # run adapter on stdio
pnpm test           # unit tests
pnpm typecheck      # optional tsc --noEmit
```

Project layout:

| Path | Purpose |
|---|---|
| `bin/oz-acp.mjs` | Node bin entry (tsx launcher) |
| `src/index.ts` | ACP stdio server |
| `src/adapter.ts` | Session lifecycle + prompt orchestration |
| `src/oz.ts` | Oz CLI subprocess helpers |
| `src/stream.ts` | Run/conversation polling |
| `src/map.ts` | Oz conversation → ACP updates |
| `src/session-store.ts` | Persistent session store |
| `AGENTS.md` | Notes for coding agents |

## Troubleshooting

| Symptom | What to check |
|---|---|
| `failed to spawn oz` | `oz` on PATH, or set `OZ_BIN_PATH` |
| Auth / whoami warnings | `oz login` or `WARP_API_KEY` |
| Empty model list | Network/auth; cache falls back to `auto` |
| Host shows no agent output | Ensure stdout is reserved for JSON-RPC (logs are on stderr) |
| Zed cannot start agent | Use absolute path to `bin/oz-acp.mjs`; Node 20+ |
| Prompt hangs / no updates | Confirm `oz whoami` works and the account has credits |

## License

MIT
