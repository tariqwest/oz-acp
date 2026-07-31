# oz-acp

An [Agent Client Protocol (ACP)](https://agentclientprotocol.com) stdio adapter for Warp’s [`oz`](https://docs.warp.dev/reference/cli) CLI. It bridges Oz into ACP hosts such as [Zed](https://zed.dev), VS Code / GitHub Copilot clients, Claude Code workflows, Codex, Cursor, OpenCode, and [Devin Desktop](https://docs.devin.ai/desktop/acp).

Modeled after [`agy-acp`](../agy/agy-acp), but implemented in TypeScript and driven by Oz CLI JSON (not local SQLite).

```
ACP host (Zed / VS Code / …)
   <--stdin/stdout NDJSON-->  oz-acp  <--subprocess-->  oz  <--API-->  Warp
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

### Run without installing (happy path)

```bash
# from GitHub (no local clone required)
npx -y https://github.com/tariqwest/oz-acp

# after the package is on npm
npx -y oz-acp
```

### Install the CLI

```bash
# from GitHub
npm install -g https://github.com/tariqwest/oz-acp
# after npm publish
npm install -g oz-acp

oz-acp   # on PATH
```

### Smoke-check (stdio JSON-RPC)

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | npx -y https://github.com/tariqwest/oz-acp
# or: oz-acp
```

You should see a JSON-RPC result with `"agentInfo":{"name":"oz",...}` on stdout. Diagnostic logs go to stderr only.

### No compile step

TypeScript runs in-place via **tsx** (a runtime dependency), so `npx` / global installs work with no `tsc` emit. `pnpm typecheck` is optional for contributors.

## Usage

`oz-acp` is an **ACP agent server**. An ACP host (editor/UI) starts it as a subprocess and speaks [JSON-RPC over stdio](https://agentclientprotocol.com) (newline-delimited JSON). You normally do **not** run it interactively yourself—the host owns the transport.

### What you can do with it

| Goal | How |
|---|---|
| Use Oz from an ACP host | Register `oz-acp` as a custom agent (see [Host setup](#host-setup)) |
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
oz-acp
# or
npx -y https://github.com/tariqwest/oz-acp
```

Smoke without a full host:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"'"$(pwd)"'","mcpServers":[]}}' \
  | npx -y https://github.com/tariqwest/oz-acp
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
| `model` | select | One entry per model family (base name only). Effort variants like `claude-4-8-opus-high` collapse to `claude-4-8-opus`. |
| `effort` | select | `low` / `medium` / `high` / `xhigh` / `max` (and related) when the current model family has effort-suffixed variants; rewriting the concrete Oz model id (e.g. `claude-4-8-opus-high` → `…-low`) |
| `profile` | select | From `oz agent profile list` → `oz agent run --profile` |
| `computer_use` | boolean | Passed via a temp agent config file as `computer_use_enabled` |

Oz does **not** support a free-form `temperature` setting in agent config / CLI, so it is not exposed.

#### Known gap: custom / BYO model labels

`oz model list --output-format json` currently returns **only** `{ "id": "..." }` entries. First-party models use human-readable ids (`claude-4-8-opus-high`, `gpt-5-5-medium`). Custom, BYO, and some third-party provider models often appear as bare UUIDs (e.g. `05446706-2ea8-4578-b523-5c1728503c84`).

oz-acp has no second source for display names: the CLI does not expose `display_name` / `alias` / provider metadata (even though Warp’s internal model objects appear to carry those fields). Until `oz model list` (or another documented Oz API) returns labels, ACP hosts will show those UUID ids as-is. Workarounds in oz-acp (local label maps, truncated “Custom model (… )” fallbacks, hiding UUID entries) are possible later but are not real name resolution.

**Upstream ask:** extend `oz model list` JSON with optional human-readable fields, for example:

```json
{
  "id": "05446706-2ea8-4578-b523-5c1728503c84",
  "name": "my-openrouter-model",
  "display_name": "OpenRouter · My Model",
  "provider": "open_router"
}
```

Switch options from the host UI when supported, or via:

- `session/set_config_option` with the `configId`s above
- `session/set_model` / `session/setModel` aliases (model only)

### Extra Oz args

Pass extra CLI flags to every `oz` invocation with `OZ_EXTRA_ARGS` in the agent `env` (or your shell):

```bash
OZ_EXTRA_ARGS='--debug' oz-acp
```

## Host setup

`oz-acp` is an **ACP agent server** (stdio JSON-RPC). Hosts spawn it as a subprocess. Auth for Oz stays with Warp (`oz login` or `WARP_API_KEY`) — not Claude / Codex / Cursor / Copilot / Devin subscriptions.

### How to launch oz-acp

Use one of these (no local clone required):

| Situation | `command` | `args` |
|---|---|---|
| Installed globally (`npm i -g …` / on `PATH`) | `oz-acp` | `[]` |
| Not installed yet (GitHub) | `npx` | `["-y", "https://github.com/tariqwest/oz-acp"]` |
| Published on npm | `npx` | `["-y", "oz-acp"]` |

GUI hosts often have a thin `PATH`; if `oz-acp` is not found, prefer the `npx` form.

### Generic ACP agent definition

Most ACP hosts share the same spawn shape (`command` + `args` + optional `env`). Only the **settings file / key** differs.

**Recommended (works without a prior install):**

```json
{
  "oz": {
    "type": "custom",
    "command": "npx",
    "args": ["-y", "https://github.com/tariqwest/oz-acp"],
    "env": {
      "WARP_API_KEY": "your-key-if-needed"
    }
  }
}
```

**If `oz-acp` is already on PATH:**

```json
{
  "oz": {
    "type": "custom",
    "command": "oz-acp",
    "args": [],
    "env": {}
  }
}
```

**After npm publish**, you can use `"args": ["-y", "oz-acp"]` with `npx` instead of the GitHub URL.

| Field | Required | Notes |
|---|---|---|
| `command` | yes | `oz-acp` or `npx` |
| `args` | no | empty for global install; `npx` args as above |
| `env` | no | `WARP_API_KEY`, `OZ_*`, … |
| `type` | recommended | `"custom"` where the host distinguishes registry vs custom |
| `name` | optional | Display name when the map key is not shown |
| `cwd` | optional | Some VS Code clients support a process working directory |

### Session config options (all hosts)

When the host renders ACP session config UI, `oz-acp` advertises:

| `configId` | Type | Purpose |
|---|---|---|
| `model` | select | Base model name (one entry per family from `oz model list`) |
| `effort` | select | Reasoning effort when the model family has effort suffixes |
| `profile` | select | Oz agent profile (`oz agent profile list`) |
| `computer_use` | boolean | Enable computer use via agent config file |

Hosts without a config UI can still call `session/set_config_option` / `session/set_model` over ACP.

### Hosts using generic `agent_servers` / `acp.agents`

These clients all take the same spawn object. Paste the generic definition under the key your host reads:

| Host | Config location | Settings key |
|---|---|---|
| **Zed** | `~/.config/zed/settings.json` (or Agent Settings → External Agents → Add Custom Agent) | `agent_servers` |
| **JetBrains** AI Assistant | `~/.jetbrains/acp.json` (AI Chat → Add Custom Agent) | `agent_servers` (plus optional `default_mcp_settings`) |
| **VS Code** [ACP Client](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client) | User/workspace `settings.json` | `acp.agents` |
| **VS Code** [ACP plugin](https://marketplace.visualstudio.com/items?itemName=strato-space.acp-plugin) | User/workspace `settings.json` | `agent_servers` (alias: `acp.agents`) |
| **VS Code** [Multicoder](https://marketplace.visualstudio.com/items?itemName=multicoder.multicoder) | User/workspace `settings.json` | `multicoder.agentServers` |
| Other ACP clients | Host docs | Usually `agent_servers` or equivalent |

**Example (Zed / JetBrains / VS Code ACP plugin):**

```json
{
  "agent_servers": {
    "oz": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "https://github.com/tariqwest/oz-acp"],
      "env": {
        "WARP_API_KEY": "your-key-if-needed"
      }
    }
  }
}
```

**JetBrains** wraps the same entry with MCP defaults:

```json
{
  "default_mcp_settings": {},
  "agent_servers": {
    "Oz": {
      "command": "npx",
      "args": ["-y", "https://github.com/tariqwest/oz-acp"],
      "env": {
        "WARP_API_KEY": "your-key-if-needed"
      }
    }
  }
}
```

**VS Code ACP Client** (`acp.agents`) and **Multicoder** (`multicoder.agentServers`) use the same inner object; only the outer key name changes.

Then open the host’s agent/chat UI, select **oz** / **Oz**, and start a session in a project workspace (that directory becomes session `cwd`).

| Host tips |
|---|
| **Zed** — Agent Panel (`Cmd-?` on macOS). Debug: **dev: open acp logs**. Docs: [External Agents](https://zed.dev/docs/ai/external-agents). |
| **JetBrains** — AI Chat agent picker. Prefer `npx` if the IDE’s `PATH` is thin. |
| **VS Code** — Install an ACP *client* extension first; stock VS Code/Copilot Chat does not host arbitrary ACP agents. |
| **GitHub Copilot** — Copilot’s own ACP binary (`@github/copilot-language-server --acp`) is a different *agent*. To run **Warp Oz**, register `oz-acp` in an ACP client extension as above. |

### Alongside Claude Code, Codex, Cursor, OpenCode

Those products are usually ACP **agents** (or their own apps), not hosts for `oz-acp`. To use Oz **next to** them, register both in the same ACP host:

```json
{
  "agent_servers": {
    "claude-code": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@zed-industries/claude-agent-acp"]
    },
    "codex": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@zed-industries/codex-acp"]
    },
    "cursor": {
      "type": "custom",
      "command": "agent",
      "args": ["acp"]
    },
    "opencode": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "opencode-ai@latest", "acp"]
    },
    "oz": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "https://github.com/tariqwest/oz-acp"],
      "env": {}
    }
  }
}
```

Switch agents in the host UI. Native config stays with each product (`~/.codex/config.toml`, Cursor login, etc.); Oz options are only ACP `configOptions` + env vars below.

**Cursor desktop** does not host custom ACP agents—use Cursor CLI as an agent in another host, or run `oz-acp` from Zed / VS Code / JetBrains / Devin Desktop.

### Devin Desktop

[Devin Desktop](https://docs.devin.ai/desktop/acp) uses an **ACP registry file** (not `agent_servers`), then an enable toggle.

| Build | Registry path |
|---|---|
| Devin Desktop | `~/.windsurf/acp/registry.json` |
| Devin Desktop Next | `~/.windsurf-next/acp/registry.json` |

Command palette → **Open Local ACP Registry Config**. Schema: [ACP registry](https://agentclientprotocol.com/get-started/registry). Devin launches via `cmd` / `args` (it does not fetch `archive` URLs today).

**Sample entry** (GitHub via `npx`; swap to `"cmd": "oz-acp", "args": []` if installed globally):

```json
{
  "version": "1.0.0",
  "agents": [
    {
      "id": "oz-acp",
      "name": "Oz",
      "version": "0.1.0",
      "description": "Warp Oz ACP adapter (oz-acp)",
      "authors": ["local"],
      "license": "MIT",
      "distribution": {
        "binary": {
          "darwin-aarch64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/oz-acp"]
          },
          "darwin-x86_64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/oz-acp"]
          },
          "linux-aarch64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/oz-acp"]
          },
          "linux-x86_64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/oz-acp"]
          },
          "windows-aarch64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/oz-acp"]
          },
          "windows-x86_64": {
            "archive": "",
            "cmd": "npx",
            "args": ["-y", "https://github.com/tariqwest/oz-acp"]
          }
        }
      }
    }
  ],
  "extensions": []
}
```

Enable:

1. **Devin User Settings** → **Agents** → toggle **Oz**
2. Restart Devin Desktop (or **Reload ACP Connections**)
3. New conversation → pick **Oz**

Env (`WARP_API_KEY`, `OZ_BIN_PATH`, …): Agents tab **…** menu, or:

```json
{
  "devin.acp.agentEnv.oz-acp": {
    "WARP_API_KEY": "your-key-if-needed"
  }
}
```

Notes: Warp handles Oz billing/privacy; Devin only hosts the session. Session **modes** are not in Devin’s UI—use oz-acp `configOptions`. Team admins can push a shared registry via **ACP Registry Config**.

Docs: [Devin Desktop ACP](https://docs.devin.ai/desktop/acp), [custom agents](https://docs.devin.ai/desktop/acp-custom).

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
2. `oz agent run --output-format ndjson -p ... --cwd ... [--model] [--conversation]`
3. Stream NDJSON events live (`run_started`, `conversation_started`, `{type:"agent",text}`) into ACP `session/update` (`agent_message_chunk`)
4. After the child exits, briefly poll `oz run get` / conversation JSON for tool calls and any late blocks (without re-emitting already-streamed text)
5. Complete `session/prompt` with `{ stopReason: "end_turn" | "cancelled" }`

Note: Oz emits **NDJSON** for `agent run` even with `--output-format json` (multiple lines, not one object). oz-acp parses that stream; older adapters that `JSON.parse` the whole stdout will hang/error after a successful Oz run.

## Development

```bash
pnpm install
pnpm start          # run adapter on stdio
pnpm test           # unit tests
pnpm typecheck      # optional tsc --noEmit
```

## Release

Create a GitHub release (tag + `gh release`), optionally publishing to npm:

```bash
# dry-run (no git/gh/npm changes)
pnpm release 0.1.1 --dry-run

# GitHub release only
pnpm release 0.1.1

# GitHub release + npm publish
pnpm release 0.1.1 --npm
# or: node scripts/release.mjs 0.1.1 --npm --yes

# bump from package.json (patch|minor|major) and release
pnpm release patch --npm
```

Requires a clean git worktree and `gh` auth. For `--npm` also run `npm login` (or `pnpm login`) first. OTP: `--otp 123456`.

Package publish surface: `bin/`, non-test `src/`, `README.md`, `AGENTS.md`, `LICENSE` (see `package.json` `files` + `.npmignore`). `prepublishOnly` runs tests and typecheck.

See `node scripts/release.mjs --help`.

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
| `failed to spawn oz` | `oz` on PATH for the **host process**, or set `OZ_BIN_PATH` / `OZ_INSTALL_PATH` in the agent `env` |
| Auth / whoami warnings | `oz login` or `WARP_API_KEY` in the agent `env` / Devin `devin.acp.agentEnv.*` (host Claude/Codex/Cursor/Devin login is unrelated) |
| Devin Desktop missing Oz | Add registry entry under `~/.windsurf/acp/registry.json`, enable in **Agents**, restart or **Reload ACP Connections** |
| Empty model list | Network/auth; cache falls back to `auto` |
| Model picker shows bare UUIDs | Custom/BYO/third-party models: `oz model list` only returns `id` today (no display names). See [Known gap: custom / BYO model labels](#known-gap-custom--byo-model-labels) |
| Prompt succeeds in Oz but ACP UI never shows the reply | Fixed in ≥0.1.2: `oz agent run` returns NDJSON events; older oz-acp tried to parse one JSON object and never streamed `session/update`. Update the adapter. |
| Host shows no agent output | Ensure stdout is reserved for JSON-RPC (logs are on stderr only); confirm `session/update` notifications are accepted by the host |
| Host cannot start agent | Node 20+; use `npx -y https://github.com/tariqwest/oz-acp` if `oz-acp` is not on the host `PATH` |
| Agent missing in VS Code | Install an ACP client extension; use the settings key it documents (`agent_servers`, `acp.agents`, or `multicoder.agentServers`) |
| No model/effort UI | Host must render ACP `configOptions`; otherwise call `session/set_config_option` |
| Prompt hangs / no updates | Confirm `oz whoami` works and the account has credits |

## License

MIT
