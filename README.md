# oz-acp

An [Agent Client Protocol (ACP)](https://agentclientprotocol.com) stdio adapter for Warp’s [`oz`](https://docs.warp.dev/reference/cli) CLI. It bridges Oz into ACP hosts such as [Zed](https://zed.dev), VS Code / GitHub Copilot clients, Claude Code workflows, Codex, Cursor, OpenCode, and [Devin Desktop](https://docs.devin.ai/desktop/acp).

Modeled after [`agy-acp`](../agy/agy-acp), but implemented in TypeScript and driven by Oz CLI JSON (not local SQLite).

```
ACP host (Zed / VS Code / …)
   <--stdin/stdout NDJSON-->  oz-acp  <--subprocess-->  oz  <--API-->  Warp
```

## Prerequisites

- **Bun 1.1+** and/or **Node.js 20+**
  - **Bun:** preferred for development; also supported when running the package under Bun (`bunx`, `bun run`)
  - **Node + tsx:** default package bin path for `npx` / global npm / many ACP hosts
- **`oz`** on your `PATH` — Warp CLI cask: `brew install --cask warpdotdev/warp/oz` ([warpdotdev/homebrew-warp](https://github.com/warpdotdev/homebrew-warp))
- Auth via `oz login` **or** `WARP_API_KEY`

Check tools:

```bash
bun -v    # optional but recommended (>= 1.1)
node -v   # >= 20 when using npx / Node hosts
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

# Homebrew (pulls Node; requires Warp oz cask on PATH)
brew install --cask warpdotdev/warp/oz
brew tap tariqwest/tap && brew install oz-acp && oz-acp
```

These install/run paths use the package bin (`bin/oz-acp.mjs`): under **Node** it loads TypeScript via **tsx** (for `npx` compatibility); under **Bun** it imports `src/index.ts` directly.

### Install the CLI

```bash
# from GitHub
npm install -g https://github.com/tariqwest/oz-acp
# after npm publish
npm install -g oz-acp
# Homebrew tap (requires Warp oz cask — see Prerequisites)
brew install --cask warpdotdev/warp/oz   # if needed
brew tap tariqwest/tap && brew install oz-acp

oz-acp   # on PATH (Node+tsx or Bun, depending on how the bin is invoked)
```

### Contributor setup (Bun)

```bash
git clone https://github.com/tariqwest/oz-acp.git
cd oz-acp
bun install
chmod +x bin/oz-acp.mjs
bun test
bun run typecheck
```

Day-to-day development uses **Bun** only — see [Development](#development).

### Smoke-check (stdio JSON-RPC)

```bash
# installed / npx (Node + tsx)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | npx -y https://github.com/tariqwest/oz-acp

# local Bun dev entry
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | bun src/index.ts
```

You should see a JSON-RPC result with `"agentInfo":{"name":"oz",...}` on stdout. Diagnostic logs go to stderr only.

### Runtime split (no compile step)

| Mode | How TypeScript runs | Command |
|---|---|---|
| **Dev (Bun)** | Bun runs `.ts` directly | `bun run dev` / `bun start` / `bun test` |
| **Released under Bun** | Bin detects Bun and imports `src/index.ts` | `bunx oz-acp` / `bun run` of the installed bin |
| **Released under Node** | Bin spawns Node + **tsx** → `src/index.ts` | `npx oz-acp` / `node bin/oz-acp.mjs` / most ACP hosts |

There is no `tsc` emit for any path. Bun remains a first-class runtime; the Node/tsx path exists so `npx` and Node-only hosts keep working. `bun run typecheck` (`tsc --noEmit`) is optional for contributors.

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
# installed package bin (works on Node via tsx, or Bun directly)
oz-acp
npx -y https://github.com/tariqwest/oz-acp
bunx oz-acp

# local clone (Bun)
bun start
bun run dev   # watch mode
```

Smoke without a full host:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"'"$(pwd)"'","mcpServers":[]}}' \
  | bun src/index.ts
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

#### Custom / BYO / third-party model labels (UUID ids)

**Upstream gap:** `oz model list --output-format json` currently returns **only** id fields:

```json
[{ "id": "claude-4-8-opus-high" }, { "id": "c770946e-4fa3-481e-9768-dd10d5e01fde" }]
```

First-party Oz catalog ids are already human-readable. **Custom, BYO, and many third-party / gateway-backed models** are registered under **opaque UUID ids**, with no `name`, `display_name`, or `provider` in the list payload. ACP hosts therefore cannot show a useful picker label from the CLI alone.

Until upstream adds optional label fields on `oz model list`, oz-acp addresses this with a **local, user-owned id → label map**. Selection still uses the real Oz model id; only the **display name** in the ACP model picker changes.

```text
$XDG_CONFIG_HOME/oz-acp/model_labels.json   # default ~/.config/oz-acp/model_labels.json
```

```json
{
  "labels": {
    "c770946e-4fa3-481e-9768-dd10d5e01fde": "gateway/combo-or-model-slug",
    "05446706-2ea8-4578-b523-5c1728503c84": "openrouter/anthropic/claude-sonnet-4"
  },
  "notes": "optional",
  "updatedAt": "2026-07-31T00:00:00.000Z",
  "source": "manual"
}
```

Unlabeled UUID ids fall back to `Custom <first8>` (e.g. `Custom c770946e`). Flat maps (`{ "<uuid>": "label" }` without a nested `labels` object) are also accepted. Labels load when the adapter builds config options; restart the ACP session (or the host agent process) after editing the file.

**Preferred upstream shape** (so this file becomes unnecessary):

```json
[
  {
    "id": "c770946e-4fa3-481e-9768-dd10d5e01fde",
    "name": "combo-or-model-slug",
    "display_name": "Friendly name",
    "provider": "my-gateway"
  }
]
```

##### Populating labels manually

1. List ids: `oz model list --output-format json`
2. Create or edit `~/.config/oz-acp/model_labels.json` with the UUID → label pairs you care about
3. Re-open / re-init the ACP session so oz-acp reloads the map

Any short string works as a label (`provider/model`, a combo name, a nickname). Prefer stable slugs you recognize in your own gateway or provider console.

##### Inferring labels with a probe script (example only)

When you have many UUID models and do not want to label them by hand, you can **probe** each id with a short `oz agent run` and infer a name from the reply and/or error text. That is a lightweight stand-in for what an ACP host does on `session/prompt`—it is **not** wired into the oz-acp adapter itself.

An abstracted example lives in the repo (copy or run from a clone):

```bash
# plan only — list UUID models that would be probed
node scripts/examples/probe-model-labels.mjs --dry-run

# probe UUID models, merge into ~/.config/oz-acp/model_labels.json
node scripts/examples/probe-model-labels.mjs --keep-going

# limit scope while iterating
node scripts/examples/probe-model-labels.mjs --models '<uuid1>,<uuid2>' --replace
```

**How the example works**

1. Read model ids from `oz model list` (default: UUID-shaped ids only).
2. For each id, run `oz agent run --model <id> --output-format ndjson` with a unique marker prompt that asks for a one-line model slug.
3. Parse NDJSON agent text plus stderr/stdout for candidates:
   - bracketed paths in errors (`[provider/model-or-combo]`)
   - `model` / `resolved_model` / `combo_name`-style fragments
   - short self-identify lines from a cooperative model
4. Rank candidates (prefer `provider/...` slugs; demote HTML noise and raw UUIDs).
5. Write / merge `model_labels.json` and a side report `model_labels_probe_report.json` next to it.

This is **opt-in tooling**, environment-agnostic, and easy to fork. It does **not** ship as part of the published package runtime surface and is **not** invoked by `oz-acp` automatically.

**Adapting the example for common custom / 3p setups**

| Setup | What to change |
|---|---|
| **OpenAI-compatible gateway** (LiteLLM, Helicone, custom reverse proxy) | Keep the probe loop; tighten `extractLabelCandidates` to your error JSON (`error.metadata.model`, `x-litellm-model`, response headers you log server-side). |
| **OpenRouter / Together / Fireworks / Groq style routers** | Prefer labels like `openrouter/org/model`. Error bodies often already contain that path in brackets or `model` fields—extend the regexes rather than the Oz spawn logic. |
| **Self-hosted router with request logs** (SQLite, JSONL, ClickHouse, …) | After each probe, query *your* log store in the time window of the run (and/or match the unique marker string in the logged prompt). Prefer the router's **combo / route name** over the leaf upstream model when both exist. Do not hard-code hostnames; pass log location via flags/env. |
| **Provider console export** | If the gateway can dump `uuid → display name` (CSV/JSON), skip probing and generate `model_labels.json` with a 10-line transform script. |
| **Models that refuse to self-identify** | Rely on error-path extraction, log correlation, or manual labels. Use `--keep-going` and fill gaps by hand. |
| **Failed runs that still name the backend** | Treat stderr as a signal: many gateways include `[route/model] [502]: …` even when the Oz run fails—those strings are often the best available label. |

**Caveats**

- Probing spends provider credits / rate limit and creates real Oz runs.
- Inferred labels can be wrong when several backends share an error shape; always spot-check `model_labels_probe_report.json`.
- oz-acp only **reads** the labels file—it never runs the probe script.
- When upstream ships `name` / `display_name` / `provider` on `oz model list`, prefer those and delete or ignore the local map.

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
| Installed globally (`npm i -g …` / Homebrew / on `PATH`) | `oz-acp` | `[]` |
| Not installed yet (GitHub) | `npx` | `["-y", "https://github.com/tariqwest/oz-acp"]` |
| Published on npm | `npx` | `["-y", "oz-acp"]` |
| Homebrew | `oz-acp` | `[]` |

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

This repo is **Bun-first**. Use Bun for install, run, test, release scripts, and as a supported production runtime. The package bin also supports **Node + tsx** so `npx` and Node-only ACP hosts work without Bun.

### Workflow

```bash
bun install                 # creates/updates bun.lock
bun run dev                 # bun --watch src/index.ts
bun start                   # bun src/index.ts (stdio ACP server)
bun test                    # bun test src
bun run typecheck           # tsc --noEmit (optional)
```

| Script | What it runs |
|---|---|
| `bun run dev` | Watch-mode ACP server on stdio |
| `bun start` / `bun run oz-acp` | One-shot Bun server (`src/index.ts`) |
| `bun test` | Unit tests under `src/` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run formula …` | Generate Homebrew formula |
| `bun run release …` | Tag / GitHub release / optional npm + Homebrew tap |
| `bun run start:node` | Force Node+tsx start path |
| `bun run test:node` | Node+tsx/`node:test` unit tests |
| `node bin/oz-acp.mjs` | Package bin under Node (tsx) |
| `bun bin/oz-acp.mjs` | Package bin under Bun (direct `.ts` import) |

### Bun vs Node+tsx

- **Bun** is supported for development **and** release/runtime (`bunx oz-acp`, `bun bin/oz-acp.mjs`, or running `src/index.ts` directly).
- **Node + tsx** is the compatibility entry for **`npx`**, global npm installs, Homebrew’s Node dependency, and hosts that only spawn Node.
- Lockfile is `bun.lock` (`packageManager` is Bun). Do not reintroduce pnpm lockfiles.
- **`tsx` stays a runtime dependency** so the Node path works without requiring Bun on the host.

### Compatibility checks

Before release, confirm both runtimes:

```bash
# Bun
bun start
bun test
bun bin/oz-acp.mjs

# Node + tsx (npx path)
bun run start:node
bun run test:node
node bin/oz-acp.mjs
```

## Release

Create a GitHub release (tag + `gh release`), optionally publishing to npm and updating the Homebrew tap:

```bash
# dry-run (no git/gh/npm changes)
bun run release 0.1.1 --dry-run

# GitHub release only
bun run release 0.1.1

# GitHub release + npm publish
bun run release 0.1.1 --npm
# or: bun scripts/release.mjs 0.1.1 --npm --yes

# GitHub release + Homebrew formula push to tariqwest/homebrew-tap
bun run release patch --homebrew --yes

# bump from package.json (patch|minor|major) and release
bun run release patch --npm --homebrew --yes
```

Generate the formula alone:

```bash
bun run formula 0.1.3                 # print Formula/oz-acp.rb to stdout
bun run formula 0.1.3 -- --write /tmp/oz-acp.rb
```

Install from the tap:

```bash
# oz is a cask on warpdotdev/homebrew-warp (formula cannot auto-install casks)
brew install --cask warpdotdev/warp/oz
brew tap tariqwest/tap
brew install oz-acp
```

The formula declares a fatal requirement for `oz` on PATH and points installers at `warpdotdev/warp/oz` when missing.

Requires a clean git worktree and `gh` auth. For `--npm` also run `npm login` first. OTP: `--otp 123456`.

Package publish surface: `bin/`, non-test `src/`, `README.md`, `AGENTS.md`, `LICENSE` (see `package.json` `files` + `.npmignore`). `prepublishOnly` runs `bun test` and `bun run typecheck`.

See `bun scripts/release.mjs --help`.

Project layout:

| Path | Purpose |
|---|---|
| `bin/oz-acp.mjs` | Package bin: Bun → direct `.ts`; Node → tsx (npx-compatible) |
| `src/index.ts` | ACP stdio server (Bun and Node/tsx) |
| `src/adapter.ts` | Session lifecycle + prompt orchestration |
| `src/oz.ts` | Oz CLI subprocess helpers |
| `src/stream.ts` | Run/conversation polling |
| `src/map.ts` | Oz conversation → ACP updates |
| `src/session-store.ts` | Persistent session store |
| `src/model-labels.ts` | Optional UUID → display label map |
| `scripts/examples/probe-model-labels.mjs` | Example-only helper to infer labels via probe prompts (not wired into the adapter) |
| `bun.lock` | Bun lockfile (dev) |
| `AGENTS.md` | Notes for coding agents |

## Troubleshooting

| Symptom | What to check |
|---|---|
| `failed to spawn oz` | `oz` on PATH for the **host process**, or set `OZ_BIN_PATH` / `OZ_INSTALL_PATH` in the agent `env` |
| Auth / whoami warnings | `oz login` or `WARP_API_KEY` in the agent `env` / Devin `devin.acp.agentEnv.*` (host Claude/Codex/Cursor/Devin login is unrelated) |
| Devin Desktop missing Oz | Add registry entry under `~/.windsurf/acp/registry.json`, enable in **Agents**, restart or **Reload ACP Connections** |
| Empty model list | Network/auth; cache falls back to `auto` |
| Model picker shows bare UUIDs / `Custom <first8>` | Custom/3p models are id-only from `oz model list` today. Add labels in `~/.config/oz-acp/model_labels.json`, or infer them with `scripts/examples/probe-model-labels.mjs`. See [Custom / BYO / third-party model labels](#custom--byo--third-party-model-labels-uuid-ids) |
| Prompt succeeds in Oz but ACP UI never shows the reply | Fixed in ≥0.1.2: `oz agent run` returns NDJSON events; older oz-acp tried to parse one JSON object and never streamed `session/update`. Update the adapter. |
| Host shows no agent output | Ensure stdout is reserved for JSON-RPC (logs are on stderr only); confirm `session/update` notifications are accepted by the host |
| Host cannot start agent | Need **Node 20+** (npx path) or **Bun 1.1+**. Try `npx -y https://github.com/tariqwest/oz-acp`, `bunx oz-acp`, or `brew install tariqwest/tap/oz-acp`. |
| Agent missing in VS Code | Install an ACP client extension; use the settings key it documents (`agent_servers`, `acp.agents`, or `multicoder.agentServers`) |
| No model/effort UI | Host must render ACP `configOptions`; otherwise call `session/set_config_option` |
| Prompt hangs / no updates | Confirm `oz whoami` works and the account has credits |

## License

MIT
