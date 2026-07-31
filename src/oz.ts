import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { split as splitShellWords } from "./shell-words.ts";
import {
  ConversationResponseSchema,
  ModelListSchema,
  RunItemSchema,
  WhoamiSchema,
  type AgentRunStreamEvent,
  type ConversationResponse,
  type ModelList,
  type RunAgentResponse,
  type RunItem,
} from "./types.ts";
import { z } from "zod";

export class OzCliError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    message: string,
    opts: { exitCode?: number | null; stderr?: string; stdout?: string } = {},
  ) {
    super(message);
    this.name = "OzCliError";
    this.exitCode = opts.exitCode ?? null;
    this.stderr = opts.stderr ?? "";
    this.stdout = opts.stdout ?? "";
  }
}

export function resolveOzBin(): string {
  const binPath = process.env.OZ_BIN_PATH?.trim();
  if (binPath) return binPath;
  const installPath = process.env.OZ_INSTALL_PATH?.trim();
  if (installPath) {
    return `${installPath.replace(/\/$/, "")}/oz`;
  }
  return "oz";
}

function extraArgs(): string[] {
  const raw = process.env.OZ_EXTRA_ARGS?.trim();
  if (!raw) return [];
  try {
    return splitShellWords(raw);
  } catch (err) {
    console.error("[oz-acp] WARN: failed to parse OZ_EXTRA_ARGS, ignoring:", err);
    return [];
  }
}

export type OzExecOptions = {
  args: string[];
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type OzExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runOz(opts: OzExecOptions): Promise<OzExecResult> {
  const bin = resolveOzBin();
  const args = [...extraArgs(), ...opts.args];

  return await new Promise<OzExecResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => {
      child.kill("SIGTERM");
      // Escalate if needed.
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1500).unref();
    };

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, opts.timeoutMs);
      timer.unref();
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      timer && clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(
        new OzCliError(`failed to spawn oz (${bin}): ${err.message}`, {
          stderr,
          stdout,
        }),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      timer && clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
      });
    });
  });
}

async function runOzJson<T>(
  args: string[],
  parse: (value: unknown) => T,
  opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const result = await runOz({
    args: [...args, "--output-format", "json"],
    cwd: opts.cwd,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });

  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new OzCliError(
      detail
        ? `oz ${args.join(" ")} failed: ${detail}`
        : `oz ${args.join(" ")} exited with code ${result.exitCode}`,
      result,
    );
  }

  const text = result.stdout.trim();
  if (!text) {
    throw new OzCliError(`oz ${args.join(" ")} returned empty stdout`, result);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new OzCliError(
      `oz ${args.join(" ")} returned invalid JSON: ${(err as Error).message}`,
      result,
    );
  }

  return parse(parsed);
}

export async function ozWhoami(signal?: AbortSignal) {
  return runOzJson(["whoami"], (v) => WhoamiSchema.parse(v), {
    signal,
    timeoutMs: 15_000,
  });
}

export async function ozModelList(signal?: AbortSignal): Promise<ModelList> {
  return runOzJson(["model", "list"], (v) => ModelListSchema.parse(v), {
    signal,
    timeoutMs: 30_000,
  });
}

const AgentProfileListSchema = z.array(
  z
    .object({
      id: z.string(),
      name: z.string().optional(),
    })
    .passthrough(),
);

export type AgentProfileInfo = {
  id: string;
  name: string;
};

export async function ozAgentProfileList(
  signal?: AbortSignal,
): Promise<AgentProfileInfo[]> {
  const list = await runOzJson(
    ["agent", "profile", "list"],
    (v) => AgentProfileListSchema.parse(v),
    {
      signal,
      timeoutMs: 15_000,
    },
  );
  return list
    .filter((p) => p.id)
    .map((p) => ({
      id: p.id,
      name: (p.name && String(p.name).trim()) || p.id,
    }));
}

export type AgentRunInput = {
  prompt: string;
  cwd: string;
  modelId?: string | null;
  conversationId?: string | null;
  profileId?: string | null;
  /** When non-null, written into a temp agent config file as computer_use_enabled. */
  computerUse?: boolean | null;
  signal?: AbortSignal;
  /** Called for each NDJSON event as it arrives (line-buffered). */
  onEvent?: (event: AgentRunStreamEvent) => void | Promise<void>;
};

export type AgentRunResult = RunAgentResponse & {
  conversation_id: string | null;
  agentText: string;
  events: AgentRunStreamEvent[];
};

/**
 * Parse one stdout line from `oz agent run --output-format json|ndjson`.
 * Oz emits NDJSON events even when `--output-format json` is set.
 */
export function parseAgentRunNdjsonLine(line: string): AgentRunStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = typeof raw.type === "string" ? raw.type : "";
  const eventType = typeof raw.event_type === "string" ? raw.event_type : "";

  if (type === "system" && eventType === "run_started" && typeof raw.run_id === "string") {
    return {
      kind: "run_started",
      runId: raw.run_id,
      runUrl: typeof raw.run_url === "string" ? raw.run_url : undefined,
      raw,
    };
  }

  if (
    type === "system" &&
    eventType === "conversation_started" &&
    typeof raw.conversation_id === "string"
  ) {
    return {
      kind: "conversation_started",
      conversationId: raw.conversation_id,
      raw,
    };
  }

  // Live agent tokens / final assistant text chunks.
  if (type === "agent" && typeof raw.text === "string") {
    return { kind: "agent_text", text: raw.text, raw };
  }

  // Some builds may emit assistant text without type=agent.
  if (typeof raw.text === "string" && (type === "assistant" || type === "message")) {
    return { kind: "agent_text", text: raw.text, raw };
  }

  return { kind: "other", raw };
}

export function summarizeAgentRunEvents(events: AgentRunStreamEvent[]): {
  runId: string | null;
  conversationId: string | null;
  agentText: string;
} {
  let runId: string | null = null;
  let conversationId: string | null = null;
  let agentText = "";
  for (const event of events) {
    if (event.kind === "run_started") runId = event.runId;
    else if (event.kind === "conversation_started") {
      conversationId = event.conversationId;
    } else if (event.kind === "agent_text") {
      agentText += event.text;
    }
  }
  return { runId, conversationId, agentText };
}

/**
 * Run `oz agent run` and consume its NDJSON event stream.
 *
 * Important: even with `--output-format json`, Oz prints multiple NDJSON lines
 * (`run_started`, `conversation_started`, `agent` text, …), not one object.
 */
export async function ozAgentRun(input: AgentRunInput): Promise<AgentRunResult> {
  const args = [
    "agent",
    "run",
    "--prompt",
    input.prompt,
    "--cwd",
    input.cwd,
    // ndjson is the natural shape; json currently emits the same multi-line stream.
    "--output-format",
    "ndjson",
  ];
  if (input.modelId) {
    args.push("--model", input.modelId);
  }
  if (input.conversationId) {
    args.push("--conversation", input.conversationId);
  }
  if (input.profileId) {
    args.push("--profile", input.profileId);
  }

  let tempConfigPath: string | null = null;
  if (typeof input.computerUse === "boolean") {
    tempConfigPath = path.join(
      os.tmpdir(),
      `oz-acp-run-${process.pid}-${Date.now()}.json`,
    );
    const config: Record<string, unknown> = {
      computer_use_enabled: input.computerUse,
    };
    if (input.modelId) config.model_id = input.modelId;
    await fsp.writeFile(tempConfigPath, JSON.stringify(config), "utf8");
    args.push("--file", tempConfigPath);
  }

  const bin = resolveOzBin();
  const fullArgs = [...extraArgs(), ...args];
  const events: AgentRunStreamEvent[] = [];
  let stdout = "";
  let stderr = "";

  try {
    const result = await new Promise<OzExecResult>((resolve, reject) => {
      const child = spawn(bin, fullArgs, {
        cwd: input.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let settled = false;
      let lineBuf = "";
      const pending: Promise<void>[] = [];

      const handleLine = (line: string) => {
        const event = parseAgentRunNdjsonLine(line);
        if (!event) return;
        events.push(event);
        if (input.onEvent) {
          pending.push(
            Promise.resolve(input.onEvent(event)).catch((err) => {
              console.error(
                "[oz-acp] WARN: onEvent handler failed:",
                (err as Error).message,
              );
            }),
          );
        }
      };

      const onAbort = () => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 1500).unref();
      };

      if (input.signal) {
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Agent turns can be long; no hard timeout by default (host cancel uses signal).
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        lineBuf += chunk;
        let idx: number;
        while ((idx = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          handleLine(line);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener("abort", onAbort);
        reject(
          new OzCliError(`failed to spawn oz (${bin}): ${err.message}`, {
            stderr,
            stdout,
          }),
        );
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener("abort", onAbort);
        if (lineBuf.trim()) handleLine(lineBuf);
        void Promise.all(pending).finally(() => {
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 0,
          });
        });
      });
    });

    const summary = summarizeAgentRunEvents(events);

    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      // If the stream already produced a run id + agent text, treat as soft failure
      // only when there is truly no useful result.
      if (!summary.runId && !summary.agentText) {
        throw new OzCliError(
          detail
            ? `oz agent run failed: ${detail}`
            : `oz agent run exited with code ${result.exitCode}`,
          result,
        );
      }
      console.error(
        `[oz-acp] WARN: oz agent run exit ${result.exitCode} after partial stream:`,
        detail.slice(0, 400),
      );
    }

    if (!summary.runId) {
      throw new OzCliError(
        "oz agent run produced no run_started event",
        result,
      );
    }

    return {
      run_id: summary.runId,
      conversation_id: summary.conversationId,
      agentText: summary.agentText,
      events,
      state: summary.agentText || result.exitCode === 0 ? "SUCCEEDED" : "FAILED",
    };
  } finally {
    if (tempConfigPath) {
      await fsp.unlink(tempConfigPath).catch(() => undefined);
    }
  }
}

export async function ozRunGet(
  runId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<RunItem> {
  return runOzJson(["run", "get", runId], (v) => RunItemSchema.parse(v), {
    signal: opts.signal,
    timeoutMs: 30_000,
  });
}

export async function ozConversationGet(
  conversationId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ConversationResponse> {
  return runOzJson(
    ["run", "conversation", "get", conversationId],
    (v) => ConversationResponseSchema.parse(v),
    {
      signal: opts.signal,
      timeoutMs: 30_000,
    },
  );
}

export async function ozRunConversation(
  runId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ConversationResponse> {
  return runOzJson(
    ["run", "get", runId, "--conversation"],
    (v) => ConversationResponseSchema.parse(v),
    {
      signal: opts.signal,
      timeoutMs: 30_000,
    },
  );
}
