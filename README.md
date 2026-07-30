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

## Host setup

`oz-acp` is an **ACP agent server** (stdio JSON-RPC). Hosts spawn it as a subprocess. Auth for Oz stays with Warp (`oz login` or `WARP_API_KEY`) — not the host’s Claude/Codex/Cursor/Copilot subscription.

Prefer an **absolute path** to `bin/oz-acp.mjs` (or a global `oz-acp` on `PATH`). GUI apps often do not inherit your shell `PATH`.

### Shared agent definition

Most hosts use a Zed-style `agent_servers` entry:

```json
{
  "agent_servers": {
    "oz": {
      "type": "custom",
      "command": "node",
      "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"],
      "env": {
        "WARP_API_KEY": "your-key-if-needed",
        "OZ_EXTRA_ARGS": ""
      }
    }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `command` | yes | `node`, `oz-acp`, or absolute path to the bin |
| `args` | no | e.g. `["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"]` when `command` is `node` |
| `env` | no | Passed to the agent process (`WARP_API_KEY`, `OZ_*`, …) |
| `type` | recommended | `"custom"` for hand-configured agents |
| `cwd` | optional | Some hosts (VS Code ACP clients) support a process working directory |
| `name` | optional | Display name when the key is not enough |

**If `oz-acp` is on PATH:**

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

**After npm publish / without a local checkout:**

```json
{
  "agent_servers": {
    "oz": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "oz-acp"],
      "env": {}
    }
  }
}
```

### Session config options (all hosts)

When the host supports ACP session config UI, `oz-acp` advertises:

| `configId` | Type | Purpose |
|---|---|---|
| `model` | select | Oz model id (`oz model list`) |
| `effort` | select | Reasoning effort when the model family has effort suffixes |
| `profile` | select | Oz agent profile (`oz agent profile list`) |
| `computer_use` | boolean | Enable computer use via agent config file |

Hosts without a config UI can still call `session/set_config_option` / `session/set_model` over ACP.

### Zed

Edit `~/.config/zed/settings.json` (or **Agent Settings → External Agents → Add Custom Agent**).

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

Then:

1. Open the Agent Panel (`Cmd-?` on macOS)
2. Select **oz** from the new-thread / agent menu
3. Chat in a project workspace (that directory becomes session `cwd`)

Debug: command palette → **dev: open acp logs**.

Docs: [Zed External Agents](https://zed.dev/docs/ai/external-agents).

### VS Code / GitHub Copilot

VS Code does not ship a built-in ACP host for arbitrary agents. Use an ACP client extension, then add `oz` as a custom agent.

Popular clients:

- [ACP Client](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client) (`formulahendry.acp-client`) — settings key `acp.agents`
- [ACP — Agent Client Protocol](https://marketplace.visualstudio.com/items?itemName=strato-space.acp-plugin) (`strato-space.acp-plugin`) — prefers root `agent_servers` (also accepts `acp.agents`)
- [Multicoder](https://marketplace.visualstudio.com/items?itemName=multicoder.multicoder) — settings key `multicoder.agentServers`

**User or workspace `settings.json` (ACP Client / Zed-compatible shape):**

```json
{
  "agent_servers": {
    "oz": {
      "type": "custom",
      "name": "Oz",
      "command": "node",
      "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"],
      "env": {
        "WARP_API_KEY": "your-key-if-needed"
      }
    }
  },
  "acp.agents": {
    "oz": {
      "command": "node",
      "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"],
      "env": {
        "WARP_API_KEY": "your-key-if-needed"
      }
    }
  }
}
```

You only need the key your extension reads (`agent_servers` and/or `acp.agents`). Some clients expand `${workspaceFolder}`, `${userHome}`, and `${env:NAME}` in `command` / `args` / `cwd`.

**Multicoder:**

```json
{
  "multicoder.agentServers": {
    "Oz": {
      "type": "custom",
      "command": "node",
      "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"],
      "env": {}
    }
  }
}
```

Then open the extension’s ACP/chat view, connect to **oz**, and start a session. Session config options (`model`, `effort`, …) appear in the composer when the client renders ACP `configOptions`.

**GitHub Copilot note:** Copilot’s own agent (`npx @github/copilot-language-server --acp`) is a separate ACP *agent*. To drive **Warp Oz** from VS Code, use an ACP *client* extension and register `oz-acp` as above — not the Copilot agent preset.

### Claude Code

Claude Code is primarily an ACP **agent** (for example via `@zed-industries/claude-agent-acp` / `@agentclientprotocol/claude-agent-acp`). It does not replace an ACP host.

To use **Oz** alongside Claude Code:

1. Keep Claude Code as its own agent (registry or custom entry).
2. Add the shared `oz` `agent_servers` entry in the **same host** (Zed, VS Code ACP client, JetBrains, …).
3. Switch agents in the host UI; do not expect Claude Code’s CLI to spawn `oz-acp` as a sub-agent unless you wire that yourself.

Example Zed settings with both agents:

```json
{
  "agent_servers": {
    "claude-code": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@zed-industries/claude-agent-acp"]
    },
    "oz": {
      "type": "custom",
      "command": "node",
      "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"],
      "env": {}
    }
  }
}
```

Oz model/effort/profile options remain oz-acp’s ACP `configOptions`; Claude’s models stay with the Claude agent.

### Codex

Codex CLI is also typically an ACP **agent** (for example `npx @zed-industries/codex-acp`). Same pattern as Claude: register **oz** next to Codex in your host.

```json
{
  "agent_servers": {
    "codex": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@zed-industries/codex-acp"]
    },
    "oz": {
      "type": "custom",
      "command": "node",
      "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"],
      "env": {}
    }
  }
}
```

Codex-native settings stay in `~/.codex/config.toml`. Oz settings are only what `oz-acp` exposes over ACP (`model`, `effort`, `profile`, `computer_use`) plus env vars below.

### Cursor

Cursor’s desktop app runs its own agent. Cursor CLI can act as an ACP **agent** (`agent acp` / `cursor-agent acp`) for *other* hosts — it is not a general host for custom agents like `oz-acp`.

To use Oz from a Cursor-centric workflow:

1. Prefer an ACP host that accepts custom agents (Zed, VS Code ACP extension, JetBrains ACP, Multicoder, …) and add the shared `oz` entry there; or
2. Drive `oz-acp` with any custom ACP client over stdio (see [Usage](#usage)).

Example of registering Oz in Zed while also having Cursor available as an external agent:

```json
{
  "agent_servers": {
    "cursor": {
      "type": "custom",
      "command": "agent",
      "args": ["acp"]
    },
    "oz": {
      "type": "custom",
      "command": "node",
      "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"],
      "env": {}
    }
  }
}
```

Cursor auth (`agent login` / `CURSOR_API_KEY`) does not authenticate Oz; still use `oz login` or `WARP_API_KEY`.

### OpenCode

OpenCode can run as an ACP agent (`opencode acp` / `npx opencode-ai@latest acp`) and many hosts list it in the ACP registry. To use **Warp Oz** instead of (or beside) OpenCode, add the custom `oz` server in the host — OpenCode does not need to wrap oz-acp.

**Zed / VS Code-style:**

```json
{
  "agent_servers": {
    "opencode": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "opencode-ai@latest", "acp"]
    },
    "oz": {
      "type": "custom",
      "command": "node",
      "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"],
      "env": {}
    }
  }
}
```

If your OpenCode build or host supports custom agent plugins that spawn arbitrary ACP stdio servers, point that plugin at the same `command` / `args` / `env` as the shared definition above.

### Devin Desktop

[Devin Desktop](https://docs.devin.ai/desktop/acp) hosts third-party ACP agents in the Agent Command Center. Custom agents are registered via a **local ACP registry** (not Zed’s `agent_servers` JSON), then enabled in settings.

Registry files:

| Build | Path |
|---|---|
| Devin Desktop | `~/.windsurf/acp/registry.json` |
| Devin Desktop Next | `~/.windsurf-next/acp/registry.json` |

Command palette → **Open Local ACP Registry Config** also opens the file. Format follows the [ACP registry](https://agentclientprotocol.com/get-started/registry) shape. Devin Desktop expects the agent binary already installed; it launches via `cmd` / `args` and does not download `archive` URLs today.

**Sample local registry entry for oz-acp** (adjust paths for your machine/OS):

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
            "cmd": "node",
            "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"]
          },
          "darwin-x86_64": {
            "archive": "",
            "cmd": "node",
            "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"]
          },
          "linux-aarch64": {
            "archive": "",
            "cmd": "node",
            "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"]
          },
          "linux-x86_64": {
            "archive": "",
            "cmd": "node",
            "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"]
          },
          "windows-aarch64": {
            "archive": "",
            "cmd": "node",
            "args": ["C:\\ABS\\PATH\\TO\\oz-acp\\bin\\oz-acp.mjs"]
          },
          "windows-x86_64": {
            "archive": "",
            "cmd": "node",
            "args": ["C:\\ABS\\PATH\\TO\\oz-acp\\bin\\oz-acp.mjs"]
          }
        }
      }
    }
  ],
  "extensions": []
}
```

If `oz-acp` is on `PATH`, you can set `"cmd": "oz-acp"` and `"args": []` instead of going through `node`.

Then enable the agent:

1. Command palette → **Devin User Settings** → **Agents**
2. Toggle on **Oz** / `oz-acp`
3. Restart Devin Desktop (or run **Reload ACP Connections** while iterating)
4. Start a **new** conversation and pick **Oz** from the agent selector

**Environment variables** (Warp auth, `OZ_BIN_PATH`, etc.):

- Agents tab → **…** menu for the agent, or
- `devin.acp.agentEnv.oz-acp` in Devin Desktop `settings.json` (key matches the registry `id`)

```json
{
  "devin.acp.agentEnv.oz-acp": {
    "WARP_API_KEY": "your-key-if-needed",
    "OZ_BIN_PATH": "/ABS/PATH/TO/oz"
  }
}
```

**Notes:**

- Billing/privacy for Oz stay with Warp; Devin Desktop only hosts the ACP session.
- Session **modes** are not exposed in Devin Desktop’s UI; use oz-acp’s ACP `configOptions` (`model`, `effort`, `profile`, `computer_use` — categories like `mode` / `model` / `thought_level` as advertised).
- Team admins can push a shared registry via **ACP Registry Config** in Devin team settings.

Docs: [Devin Desktop ACP](https://docs.devin.ai/desktop/acp), [custom ACP agents](https://docs.devin.ai/desktop/acp-custom).

### JetBrains (bonus)

JetBrains AI Assistant uses `~/.jetbrains/acp.json`:

```json
{
  "default_mcp_settings": {},
  "agent_servers": {
    "Oz": {
      "command": "node",
      "args": ["/ABS/PATH/TO/oz-acp/bin/oz-acp.mjs"],
      "env": {
        "WARP_API_KEY": "your-key-if-needed"
      }
    }
  }
}
```

Use absolute paths; the IDE process often has a restricted `PATH`.

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

## Release

Create a GitHub release (tag + `gh release`), optionally publishing to npm:

```bash
# dry-run (no git/gh/npm changes)
pnpm release -- 0.1.1 --dry-run

# GitHub release only
pnpm release -- 0.1.1

# GitHub release + npm publish
pnpm release -- 0.1.1 --npm

# bump from package.json (patch|minor|major) and release
pnpm release -- patch --npm
```

Requires a clean git worktree, `gh` auth, and (for `--npm`) npm auth. See `node scripts/release.mjs --help`.

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
| Host shows no agent output | Ensure stdout is reserved for JSON-RPC (logs are on stderr only) |
| Host cannot start agent | Absolute path to `bin/oz-acp.mjs`; Node 20+; GUI apps may not see shell `PATH` |
| Agent missing in VS Code | Install an ACP client extension; use the settings key it documents (`agent_servers`, `acp.agents`, or `multicoder.agentServers`) |
| No model/effort UI | Host must render ACP `configOptions`; otherwise call `session/set_config_option` |
| Prompt hangs / no updates | Confirm `oz whoami` works and the account has credits |

## License

MIT
