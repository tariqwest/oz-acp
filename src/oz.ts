import { spawn } from "node:child_process";
import { split as splitShellWords } from "./shell-words.ts";
import {
  ConversationResponseSchema,
  ModelListSchema,
  RunAgentResponseSchema,
  RunItemSchema,
  WhoamiSchema,
  type ConversationResponse,
  type ModelList,
  type RunAgentResponse,
  type RunItem,
} from "./types.ts";

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

export type AgentRunInput = {
  prompt: string;
  cwd: string;
  modelId?: string | null;
  conversationId?: string | null;
  signal?: AbortSignal;
};

export async function ozAgentRun(input: AgentRunInput): Promise<RunAgentResponse> {
  const args = ["agent", "run", "--prompt", input.prompt, "--cwd", input.cwd];
  if (input.modelId) {
    args.push("--model", input.modelId);
  }
  if (input.conversationId) {
    args.push("--conversation", input.conversationId);
  }
  return runOzJson(args, (v) => RunAgentResponseSchema.parse(v), {
    cwd: input.cwd,
    signal: input.signal,
    // Starting a run can take a bit while snapshotting; keep generous.
    timeoutMs: 120_000,
  });
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
