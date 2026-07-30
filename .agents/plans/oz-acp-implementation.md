# oz-acp: ACP stdio wrapper for Oz CLI
## Problem
Build an Agent Client Protocol (ACP) stdio adapter for Warp’s `oz` CLI, modeled on `~/Developer/agy/agy-acp`, so hosts like Zed can drive Oz agents. Target dir `~/Developer/oz-acp` is empty; no official Warp ACP server exists yet (Warp FR #7326).
## Current state (researched)
### Reference: `agy-acp`
Rust NDJSON JSON-RPC adapter (architecture reference only; **oz-acp will be TypeScript**):
* stdin/stdout loop; async `session/prompt`; cancel flags
* session lifecycle, spawn backend CLI, model config, persistence
* Streams by polling backend state (agy: SQLite; oz: CLI JSON)
* Persists `sessionId → conversation_id/model_id` under `~/.openab/agy-acp/`
* ACP **v1**: `session/prompt` completes with `{ stopReason }`; emits `session/update` (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, …)
### Language choice
Use **TypeScript on Node via tsx** (not Rust, not Bun-required). No strong technical reason to match agy-acp’s Rust:
* Workload is JSON-RPC, subprocess CLI, and polling — TS is a natural fit
* Official `@agentclientprotocol/sdk` and `oz-agent-sdk` are TS-friendly
* Faster iteration given your familiarity; binary size/startup are not MVP constraints
* `tsx` lets hosts run TypeScript directly with Node/`npx` (no `tsc` emit step)
Rust only wins if we needed agy-style local SQLite/protobuf scraping or a single static binary with no runtime — neither applies to Oz.
### Oz surfaces to wrap
CLI (preferred transport, mirrors agy-acp):
* `oz agent run -p <prompt> --cwd <dir> [--model <id>] [--conversation <id>] --output-format json`
    * Response shape (OpenAPI `RunAgentResponse`): `run_id`, `task_id`, `state`, `at_capacity`
    * Continue turns via `--conversation <conversation_id>` (no dedicated CLI followup command)
* `oz run get <run_id> --output-format json` → run metadata + terminal `state`
* `oz run get <run_id> --conversation` / `oz run conversation get <id>` → `{ conversation_id, steps[] }`
* `oz model list --output-format json` → `[{ "id": "..." }, ...]` (100 models observed)
* `oz whoami --output-format json` → auth check
* Auth via existing `oz login` / `WARP_API_KEY`
Conversation content (live sample):
* Nested `steps[]` with `messages[]`
* Roles: `user` | `assistant` | `tool` | `system`
* Content blocks: `text`, `action`, `action_result`, `event`
* Actions: `{ type, category, name, id, input }` (`category`: command/files/skill/…)
* Results: `{ type, action_id, state, output }` (`state`: running/completed/failed/denied)
Not useful for token streaming:
* `oz run message watch` is **agent-to-agent inbox** streaming (requires `--output-format ndjson`), not conversation transcript streaming
OpenAPI extras (optional later):
* `POST /agent/runs/{runId}/cancel`
* `POST /agent/runs/{runId}/followups`
* `GET /agent/runs/{runId}/timeline`
No mature third-party `oz-acp` found; `oz-agent-sdk` is REST-only, not ACP.
## Architecture
```
Zed/other ACP host  <--NDJSON JSON-RPC-->  oz-acp  <--subprocess oz CLI-->  Warp/Oz API
```
Keep the agy-acp shape, replace SQLite/protobuf with Oz JSON polling.
### Modules (TypeScript)
* `src/index.ts` — stdio NDJSON JSON-RPC loop; dispatch ACP methods
* `src/adapter.ts` — session lifecycle + prompt/cancel orchestration
* `src/oz.ts` — spawn/parse `oz` CLI (`whoami`, `model list`, `agent run`, `run get`, conversation get)
* `src/stream.ts` — poll run state + conversation; emit ACP deltas
* `src/map.ts` — Oz blocks → ACP updates (`text`→message chunks; `action`/`action_result`→`tool_call`/`tool_call_update`)
* `src/session-store.ts` — locked persist/restore under `$XDG_CONFIG_HOME/oz-acp/` (default `~/.config/oz-acp/`)
* `src/types.ts` — session + Oz response types (zod)
* `src/**/*.test.ts` — unit tests; optional live e2e gated on env
### Session model
Persist `$XDG_CONFIG_HOME/oz-acp/sessions.json` (default `~/.config/oz-acp/sessions.json`; locked write, same pattern as agy-acp):
* `sessionId` (ACP UUID)
* `conversation_id`
* `last_run_id`
* `model_id`
* `cwd`
* cursor for replay/delta: last seen message/content ids (or hash/count of emitted content keys), not SQLite step idx
### Prompt turn flow
1. Flatten ACP `prompt[]` text blocks (v1 text-only capability initially).
2. `oz agent run --output-format json -p ... --cwd <session.cwd> [--model] [--conversation if bound]`.
3. Capture `run_id`; if conversation unbound, read it from `oz run get <run_id>` once available.
4. Poll every ~400–500ms:
    * conversation → map new text/actions/results to `session/update`
    * run state → stop when `SUCCEEDED` / `FAILED` / `CANCELLED` / `ERROR` (and decide behavior for long `BLOCKED`)
5. Reply to `session/prompt` with `stopReason`: `end_turn` | `cancelled` | map failures to JSON-RPC error when no useful updates.
6. `session/cancel`: set cancel flag; kill local `oz` child if still attached; attempt API/CLI cancel for the active `run_id` if available during impl.
### ACP capabilities (v1, Zed-compatible)
Advertise like agy-acp:
* `protocolVersion: 1`
* `loadSession`, streaming-style updates, `promptCapabilities.text`
* `sessionCapabilities`: resume/list/delete
* Models via `models` + `configOptions` select (`id: "model"`), fed by `oz model list` + cache file
## Implementation approach
* **Language/tooling:** TypeScript on Node via tsx (no tsc emit required). zod for Oz/session schemas. pnpm for installs.
* **No-compile execution:**
    * package.json bin: oz-acp -> bin/oz-acp.mjs
    * bin/oz-acp.mjs shebang uses env node, registers tsx, then imports ../src/index.ts
    * tsx is a runtime dependency so npx oz-acp and linked bins work cold
    * scripts.start / scripts.dev run: tsx src/index.ts
    * tests via node test runner under tsx, or vitest with tsx
    * typecheck optional only: tsc --noEmit; not needed to run or install
    * package type: module; engines.node current LTS+
* Prefer @agentclientprotocol/sdk for agent-side stdio if it cleanly supports ACP v1 agent mode; otherwise thin hand-rolled NDJSON JSON-RPC (same as agy-acp).
* Oz transport MVP: subprocess CLI (no hard dependency on oz-agent-sdk). Optional later REST path for cancel/followups/timeline.
* Oz binary resolution: OZ_BIN_PATH, else OZ_INSTALL_PATH/oz, else PATH oz.
* Extras: OZ_EXTRA_ARGS shell-split into every oz invocation; WARP_API_KEY passthrough via env.
* cwd: honor ACP session new/load/resume cwd (Oz --cwd).
* Auth UX: soft-check oz whoami on init/new; clear error if logged out.
* Out of MVP: ACP permission bridging for Oz BLOCKED approvals, image/resource prompts, MCP passthrough from ACP mcpServers, timeline streaming, run-cloud mode toggle.
## Validation
* Unit: content mappers, stopReason mapping, session persist/restore (temp dir)
* Manual/e2e (env-gated): spawn oz-acp; initialize -> session/new -> session/prompt; assert chunks + end_turn; resume via session/load
* Requires local oz + login/credits
## Deliverables
* package.json, tsconfig.json, bin/oz-acp.mjs, src/*, README.md, AGENTS.md, .gitignore
* Runnable via pnpm exec oz-acp, npx oz-acp, or PATH-linked bin with zero compile step
* Zed agent_servers snippet using command npx/oz-acp or absolute bin path
