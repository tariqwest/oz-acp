# oz-acp

TypeScript ACP stdio adapter for Warp Oz CLI.

- **Primary runtime / dev:** Bun (install, run, test, scripts, `bunx`)
- **Node compatibility entry:** `bin/oz-acp.mjs` uses tsx under Node so `npx` / npm global / Node-only hosts work without Bun
- **No emit step** for either path

## Setup

```bash
bun install
chmod +x bin/oz-acp.mjs
bun test
bun run typecheck
```

| Entry | Command |
|---|---|
| Dev | `bun src/index.ts` / `bun run dev` |
| Package bin under Bun | `bun bin/oz-acp.mjs` / `bunx oz-acp` |
| Package bin under Node (npx) | `node bin/oz-acp.mjs` / `npx oz-acp` |

## Commands

```bash
bun install
bun run dev                # bun --watch src/index.ts
bun start                  # bun src/index.ts (stdio ACP server)
bun test                   # bun test src
bun run typecheck          # tsc --noEmit
bun run start:node         # force Node+tsx start
bun run test:node          # Node+tsx/`node:test` parity
bun bin/oz-acp.mjs         # package bin on Bun
node bin/oz-acp.mjs        # package bin on Node (tsx; npx path)
bun run formula <ver>      # print Homebrew formula (preview)
bun run release <ver>      # GitHub release + Homebrew tap (default); add --npm; --no-homebrew to skip tap
```

Lockfile: `bun.lock` (do not reintroduce pnpm lockfiles).

## Architecture

- `src/index.ts` — ACP SDK `ndJsonStream` + request handlers on stdio
- `src/adapter.ts` — session lifecycle, models/config options, prompt orchestration
- `src/config-options.ts` — ACP config option builders (model/effort/profile/computer_use)
- `src/oz.ts` — spawn/parse `oz` CLI JSON / NDJSON agent run stream
- `src/stream.ts` — poll run + conversation until terminal state
- `src/map.ts` — Oz conversation blocks → ACP `session/update` payloads
- `src/session-store.ts` — `$XDG_CONFIG_HOME/oz-acp` persistence (default `~/.config/oz-acp`)
- `src/model-labels.ts` — optional UUID → display label map (reads user config only)
- `src/types.ts` — zod schemas
- `bin/oz-acp.mjs` — package bin; Bun imports `src/index.ts` directly, Node spawns tsx (npx-compatible)
- `scripts/release.mjs` — GitHub release + Homebrew tap update (coupled by default; optional npm); checks via Bun
- `scripts/generate-homebrew-formula.mjs` — Homebrew formula generator (used by release; local preview via `bun run formula`)
- `scripts/examples/probe-model-labels.mjs` — **example only** (not wired into the adapter): infer UUID labels by probing models

## Key paths

| Path | Purpose |
|---|---|
| `$XDG_CONFIG_HOME/oz-acp/sessions.json` (default `~/.config/oz-acp/sessions.json`) | session → conversation/run/model bindings |
| `$XDG_CONFIG_HOME/oz-acp/models_cache.json` (default `~/.config/oz-acp/models_cache.json`) | cached `oz model list` ids |
| `$XDG_CONFIG_HOME/oz-acp/model_labels.json` (default `~/.config/oz-acp/model_labels.json`) | optional id → display label map for UUID/custom models |

## Oz CLI surface used

- `oz whoami --output-format json`
- `oz model list --output-format json`
- `oz agent run --prompt ... --cwd ... [--model] [--conversation] --output-format ndjson` (NDJSON event stream even if `json` is requested)
- `oz run get <run_id> --output-format json`
- `oz run conversation get <id> --output-format json`
- `oz run get <run_id> --conversation --output-format json`

## Notes

- ACP protocol version 1 (Zed-compatible): `session/prompt` returns `stopReason`.
- `oz agent run` stdout is NDJSON: `run_started` → `conversation_started` → `{type:"agent",text}` (and possibly more). Do not `JSON.parse` the full stdout as one object.
- Model pickers expose one base name per family (`claude-4-8-opus`); effort is a separate config option that maps back to Oz ids like `claude-4-8-opus-high`.
- **Upstream gap (custom / 3p model labels):** `oz model list` JSON is id-only (`[{ "id": "..." }]`). First-party ids are readable; custom/BYO/third-party models often appear as bare UUIDs with no `name` / `display_name` / `provider`. ACP pickers would otherwise show opaque ids.
  - **Mitigation in oz-acp:** optional user file `$XDG_CONFIG_HOME/oz-acp/model_labels.json` (default `~/.config/oz-acp/model_labels.json`). `src/model-labels.ts` maps id → display label; unlabeled UUIDs fall back to `Custom <first8>`. Selection values remain real Oz ids.
  - **Not automatic:** the adapter never discovers gateway names by itself. Users edit the JSON manually or generate it with external tooling.
  - **Example probe (not productized):** `scripts/examples/probe-model-labels.mjs` shows a lightweight ACP-less approach—`oz agent run` per UUID with a marker prompt, then infer a label from reply text and/or error paths (`[provider/model]`, `model` fields). It is environment-agnostic (no assumed self-hosted router). End users should fork extractors for OpenRouter-style routers, OpenAI-compatible gateways, or their own request-log correlation. See README § Custom / BYO / third-party model labels.
  - **Preferred upstream shape:** optional `name`, `display_name`, `provider` alongside `id` on `oz model list` so local maps are unnecessary.
- `oz run message watch` is agent-inbox messaging, not used for transcript streaming.
- Cancellation aborts in-flight CLI children via `AbortSignal`; remote run cancel API is out of MVP.
- Keep stderr logging only — stdout is the ACP transport.
