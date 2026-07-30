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

Then:

1. Open the Agent Panel (`Cmd-?` on macOS)
2. Select **oz** from the agent dropdown
3. Start chatting

### Model selection

On `initialize`, `oz-acp` runs `oz model list` and exposes models as ACP config options (`id: "model"`). Switch models from the host UI when supported.

### Extra Oz args

```json
{
  "agent_servers": {
    "oz": {
      "type": "custom",
      "command": "oz-acp",
      "args": [],
      "env": {
        "OZ_EXTRA_ARGS": "--debug"
      }
    }
  }
}
```

## Environment variables

| Variable | Description |
|---|---|
| `OZ_BIN_PATH` | Full path to the `oz` binary |
| `OZ_INSTALL_PATH` | Directory containing `oz` |
| `OZ_EXTRA_ARGS` | Shell-style extra args prepended to every `oz` invocation |
| `WARP_API_KEY` | API key (passed through to `oz`) |
| `HOME` | Used for session persistence under `~/.openab/oz-acp/` |

## Session persistence

Sessions are stored at `~/.openab/oz-acp/sessions.json` (with a lock file). Bindings include `conversationId`, `lastRunId`, `modelId`, `cwd`, and emitted content keys for replay/delta.

Model IDs are cached at `~/.openab/oz-acp/models_cache.json`.

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

## License

MIT
