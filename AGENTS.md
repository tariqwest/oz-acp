# oz-acp

TypeScript ACP stdio adapter for Warp Oz CLI. Runs via Node + tsx with no emit step.

## Setup

```bash
pnpm install
chmod +x bin/oz-acp.mjs
pnpm test
pnpm typecheck
```

Bin entry: `node bin/oz-acp.mjs` (no `tsc` emit; tsx loads `src/index.ts`).

## Commands

```bash
pnpm install
pnpm start                 # tsx src/index.ts (stdio ACP server)
pnpm test                  # tsx --test
pnpm typecheck             # tsc --noEmit
node bin/oz-acp.mjs        # same as published bin
pnpm release <ver>         # GitHub release; add --npm to publish
```

## Architecture

- `src/index.ts` — ACP SDK `ndJsonStream` + request handlers on stdio
- `src/adapter.ts` — session lifecycle, models/config options, prompt orchestration
- `src/config-options.ts` — ACP config option builders (model/effort/profile/computer_use)
- `src/oz.ts` — spawn/parse `oz` CLI JSON
- `src/stream.ts` — poll run + conversation until terminal state
- `src/map.ts` — Oz conversation blocks → ACP `session/update` payloads
- `src/session-store.ts` — `$XDG_CONFIG_HOME/oz-acp` persistence (default `~/.config/oz-acp`)
- `src/types.ts` — zod schemas
- `bin/oz-acp.mjs` — Node shebang, registers tsx, imports `src/index.ts`

## Key paths

| Path | Purpose |
|---|---|
| `$XDG_CONFIG_HOME/oz-acp/sessions.json` (default `~/.config/oz-acp/sessions.json`) | session → conversation/run/model bindings |
| `$XDG_CONFIG_HOME/oz-acp/models_cache.json` (default `~/.config/oz-acp/models_cache.json`) | cached `oz model list` ids |

## Oz CLI surface used

- `oz whoami --output-format json`
- `oz model list --output-format json`
- `oz agent run --prompt ... --cwd ... [--model] [--conversation] --output-format json`
- `oz run get <run_id> --output-format json`
- `oz run conversation get <id> --output-format json`
- `oz run get <run_id> --conversation --output-format json`

## Notes

- ACP protocol version 1 (Zed-compatible): `session/prompt` returns `stopReason`.
- Model pickers expose one base name per family (`claude-4-8-opus`); effort is a separate config option that maps back to Oz ids like `claude-4-8-opus-high`.
- `oz run message watch` is agent-inbox messaging, not used for transcript streaming.
- Cancellation aborts in-flight CLI children via `AbortSignal`; remote run cancel API is out of MVP.
- Keep stderr logging only — stdout is the ACP transport.
