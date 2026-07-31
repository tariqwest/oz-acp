import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {
  applyConfigOptionValue,
  buildSessionConfigOptions,
  MODEL_CONFIG_ID,
  modelBaseId,
  resolveModelWithEffort,
  uniqueModelBases,
  type AgentProfile,
  type EffortLevel,
} from "./config-options.ts";
import {
  decideStopReason,
  flattenPromptText,
  mapConversationDelta,
} from "./map.ts";
import {
  ozAgentProfileList,
  ozAgentRun,
  ozConversationGet,
  ozModelList,
  ozWhoami,
  OzCliError,
} from "./oz.ts";
import type { AgentRunStreamEvent } from "./types.ts";
import { SessionStore, sessionFromStored } from "./session-store.ts";
import { pollRunTurn } from "./stream.ts";
import type { Session } from "./types.ts";

const require = createRequire(import.meta.url);
const PACKAGE_VERSION: string =
  (require("../package.json") as { version?: string }).version ?? "0.0.0";
const MAX_SESSIONS = 64;

type AgentContext = {
  notify: (method: string, params: unknown) => Promise<void> | void;
  signal?: AbortSignal;
};

function cwdFromParams(params: { cwd?: string } | undefined, fallback: string): string {
  const cwd = params?.cwd?.trim();
  return cwd && cwd.length > 0 ? cwd : fallback;
}

export class OzAcpAgent {
  private readonly sessions = new Map<string, Session>();
  private readonly store: SessionStore;
  private readonly defaultCwd: string;
  private availableModels: string[] = [];
  private modelsLoaded = false;
  private availableProfiles: AgentProfile[] = [];
  private profilesLoaded = false;

  constructor(opts: { store?: SessionStore; defaultCwd?: string } = {}) {
    this.store = opts.store ?? new SessionStore();
    this.defaultCwd =
      opts.defaultCwd ??
      process.cwd() ??
      process.env.HOME ??
      "/tmp";
  }

  async initModels(): Promise<void> {
    try {
      const models = await ozModelList();
      this.availableModels = models.map((m) => m.id).filter(Boolean);
      if (this.availableModels.length) {
        await this.store.saveModelsCache(this.availableModels);
        this.modelsLoaded = true;
        console.error(`[oz-acp] fetched ${this.availableModels.length} models from oz model list`);
        return;
      }
    } catch (err) {
      console.error("[oz-acp] oz model list failed:", (err as Error).message);
    }
    const cached = await this.store.loadModelsCache();
    if (cached?.length) {
      this.availableModels = cached;
      this.modelsLoaded = true;
      console.error(`[oz-acp] using cached model list (${cached.length})`);
      return;
    }
    this.availableModels = ["auto"];
    this.modelsLoaded = true;
    console.error("[oz-acp] no models available; falling back to auto");
  }

  async initProfiles(): Promise<void> {
    try {
      this.availableProfiles = await ozAgentProfileList();
      this.profilesLoaded = true;
      if (this.availableProfiles.length) {
        console.error(
          `[oz-acp] fetched ${this.availableProfiles.length} agent profiles`,
        );
      }
    } catch (err) {
      this.availableProfiles = [];
      this.profilesLoaded = true;
      console.error(
        "[oz-acp] oz agent profile list failed:",
        (err as Error).message,
      );
    }
  }

  private async ensureModels(): Promise<string[]> {
    if (!this.modelsLoaded) await this.initModels();
    return this.availableModels;
  }

  private async ensureProfiles(): Promise<AgentProfile[]> {
    if (!this.profilesLoaded) await this.initProfiles();
    return this.availableProfiles;
  }

  private async ensureSessionMeta(): Promise<void> {
    await Promise.all([this.ensureModels(), this.ensureProfiles()]);
  }

  private resolvedModelId(session: Session): string | null {
    if (!session.modelId) return null;
    if (!session.effort) return session.modelId;
    return resolveModelWithEffort(
      session.modelId,
      session.effort,
      this.availableModels,
    );
  }

  private sessionModelsJson(session: Session) {
    const models = this.availableModels.length ? this.availableModels : ["auto"];
    const current =
      this.resolvedModelId(session) || session.modelId || models[0] || "auto";
    const currentBase = modelBaseId(current);
    const bases = uniqueModelBases(models);
    const available = bases.includes(currentBase)
      ? bases
      : [currentBase, ...bases];
    return {
      // Host model pickers show base names only; effort is a separate config.
      currentModelId: currentBase,
      availableModels: available.map((base) => ({ modelId: base, name: base })),
    };
  }

  private sessionConfigOptionsJson(session: Session) {
    return buildSessionConfigOptions({
      availableModels: this.availableModels,
      profiles: this.availableProfiles,
      state: {
        modelId: this.resolvedModelId(session) ?? session.modelId,
        effort: session.effort,
        profileId: session.profileId,
        computerUse: session.computerUse,
      },
    });
  }

  private sessionConfigResult(sessionId: string, session: Session) {
    return {
      sessionId,
      models: this.sessionModelsJson(session),
      configOptions: this.sessionConfigOptionsJson(session),
    };
  }

  private emptySession(cwd: string): Session {
    return {
      conversationId: null,
      lastRunId: null,
      modelId: null,
      effort: null,
      profileId: null,
      computerUse: null,
      cwd,
      seenKeys: new Set(),
      title: null,
      activeAbort: null,
    };
  }

  private evictIfNeeded() {
    while (this.sessions.size >= MAX_SESSIONS) {
      const first = this.sessions.keys().next().value;
      if (!first) break;
      this.sessions.delete(first);
    }
  }

  private async restoreSession(sessionId: string): Promise<Session | null> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const stored = await this.store.get(sessionId);
    if (!stored) return null;
    const session = sessionFromStored(stored, this.defaultCwd);
    this.evictIfNeeded();
    this.sessions.set(sessionId, session);
    return session;
  }

  private async persist(sessionId: string, session: Session) {
    await this.store.save(sessionId, session);
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    await this.ensureSessionMeta();
    try {
      const who = await ozWhoami();
      if (who.email || who.display_name || who.uid) {
        console.error(
          `[oz-acp] authenticated as ${who.display_name || who.email || who.uid}`,
        );
      }
    } catch (err) {
      console.error(
        "[oz-acp] WARN: oz whoami failed — run `oz login` or set WARP_API_KEY:",
        (err as Error).message,
      );
    }

    return {
      protocolVersion: 1,
      agentInfo: {
        name: "oz",
        version: PACKAGE_VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          text: true,
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          resume: {},
          list: {},
          delete: {},
        },
      } as acp.AgentCapabilities,
      authMethods: [],
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    await this.ensureSessionMeta();
    const sessionId = randomUUID();
    const session = this.emptySession(cwdFromParams(params, this.defaultCwd));
    this.evictIfNeeded();
    this.sessions.set(sessionId, session);
    await this.persist(sessionId, session);
    return this.sessionConfigResult(sessionId, session) as acp.NewSessionResponse;
  }

  async loadSession(
    params: acp.LoadSessionRequest,
    cx?: AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    await this.ensureSessionMeta();
    const sessionId = params.sessionId;
    if (!sessionId) {
      throw Object.assign(new Error("missing sessionId"), { code: -32602 });
    }

    let session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), {
        code: -32000,
      });
    }

    // Allow host to refresh cwd on load.
    if (params.cwd?.trim()) {
      session.cwd = params.cwd.trim();
    }

    if (session.conversationId && cx) {
      try {
        const conversation = await ozConversationGet(session.conversationId);
        // Replay full history: temporarily clear seen for replay emission only.
        const replaySeen = new Set<string>();
        const deltas = mapConversationDelta(conversation, replaySeen);
        for (const delta of deltas) {
          session.seenKeys.add(delta.key);
          await cx.notify("session/update", {
            sessionId,
            update: delta.update,
          });
        }
      } catch (err) {
        console.error("[oz-acp] WARN: failed to replay conversation:", (err as Error).message);
      }
    }

    await this.persist(sessionId, session);
    return this.sessionConfigResult(sessionId, session) as acp.LoadSessionResponse;
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    await this.ensureSessionMeta();
    const sessionId = params.sessionId;
    if (!sessionId) {
      throw Object.assign(new Error("missing sessionId"), { code: -32602 });
    }
    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), {
        code: -32000,
      });
    }
    if (params.cwd?.trim()) session.cwd = params.cwd.trim();
    await this.persist(sessionId, session);
    return this.sessionConfigResult(sessionId, session) as acp.ResumeSessionResponse;
  }

  async listSessions(
    _params: acp.ListSessionsRequest = {},
  ): Promise<acp.ListSessionsResponse> {
    const listed = await this.store.list();
    return {
      sessions: listed.map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title ?? undefined,
        _meta: {
          conversationId: s.conversationId,
          lastRunId: s.lastRunId,
          modelId: s.modelId,
          effort: s.effort,
          profileId: s.profileId,
          computerUse: s.computerUse,
        },
      })),
    } as acp.ListSessionsResponse;
  }

  async deleteSession(params: { sessionId: string }): Promise<Record<string, never>> {
    const sessionId = params.sessionId;
    if (!sessionId) {
      throw Object.assign(new Error("missing sessionId"), { code: -32602 });
    }
    const session = this.sessions.get(sessionId);
    session?.activeAbort?.abort();
    this.sessions.delete(sessionId);
    await this.store.delete(sessionId);
    return {};
  }

  async setSessionModel(params: {
    sessionId: string;
    modelId: string;
  }): Promise<Record<string, never>> {
    const { sessionId, modelId } = params;
    if (!sessionId || !modelId) {
      throw Object.assign(new Error("missing sessionId or modelId"), {
        code: -32602,
      });
    }
    await this.ensureSessionMeta();
    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), {
        code: -32000,
      });
    }
    const next = applyConfigOptionValue({
      configId: MODEL_CONFIG_ID,
      value: modelId,
      state: {
        modelId: session.modelId,
        effort: session.effort,
        profileId: session.profileId,
        computerUse: session.computerUse,
      },
      availableModels: this.availableModels,
      profiles: this.availableProfiles,
    });
    session.modelId = next.modelId;
    session.effort = next.effort as EffortLevel | null;
    await this.persist(sessionId, session);
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const sessionId = params.sessionId;
    const configId = params.configId;
    const value = params.value as unknown;
    if (!sessionId || !configId || value === undefined || value === null || value === "") {
      throw Object.assign(new Error("missing sessionId, configId, or value"), {
        code: -32602,
      });
    }
    await this.ensureSessionMeta();
    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), {
        code: -32000,
      });
    }

    let next;
    try {
      next = applyConfigOptionValue({
        configId,
        value,
        state: {
          modelId: session.modelId,
          effort: session.effort,
          profileId: session.profileId,
          computerUse: session.computerUse,
        },
        availableModels: this.availableModels,
        profiles: this.availableProfiles,
      });
    } catch (err) {
      const message = (err as Error).message || "invalid config option";
      throw Object.assign(new Error(message), {
        code: (err as { code?: number }).code ?? -32602,
      });
    }

    session.modelId = next.modelId;
    session.effort = next.effort as EffortLevel | null;
    session.profileId = next.profileId;
    session.computerUse = next.computerUse;
    await this.persist(sessionId, session);
    return {
      configOptions: this.sessionConfigOptionsJson(session),
    } as acp.SetSessionConfigOptionResponse;
  }

  cancel(params: { sessionId: string }) {
    const session = this.sessions.get(params.sessionId);
    session?.activeAbort?.abort();
  }

  async prompt(
    params: acp.PromptRequest,
    cx: AgentContext,
  ): Promise<acp.PromptResponse> {
    await this.ensureSessionMeta();
    const sessionId = params.sessionId;
    if (!sessionId) {
      throw Object.assign(new Error("missing sessionId"), { code: -32602 });
    }

    let session = await this.restoreSession(sessionId);
    if (!session) {
      // Allow hosts that skip explicit new/load in tests: create ephemeral binding.
      session = this.emptySession(this.defaultCwd);
      this.sessions.set(sessionId, session);
    }

    const promptText = flattenPromptText(params.prompt);
    if (!promptText) {
      throw Object.assign(new Error("empty prompt"), { code: -32602 });
    }

    const abort = new AbortController();
    session.activeAbort = abort;
    const onCxAbort = () => abort.abort();
    cx.signal?.addEventListener("abort", onCxAbort, { once: true });

    const emit = async (update: Record<string, unknown>) => {
      await cx.notify("session/update", { sessionId, update });
    };

    try {
      let streamedText = false;
      let streamMessageId: string | null = null;
      let chunkIndex = 0;

      const onEvent = async (event: AgentRunStreamEvent) => {
        if (event.kind === "run_started") {
          session.lastRunId = event.runId;
          return;
        }
        if (event.kind === "conversation_started") {
          session.conversationId = event.conversationId;
          return;
        }
        if (event.kind === "agent_text") {
          const text = event.text;
          if (!text) return;
          // One messageId for the whole streamed assistant turn so hosts can
          // concatenate chunks instead of treating each as a separate message.
          if (!streamMessageId) {
            streamMessageId = `oz-stream-${session.lastRunId || sessionId}`;
          }
          const key = `stream:${streamMessageId}:${chunkIndex++}`;
          if (session.seenKeys.has(key)) return;
          session.seenKeys.add(key);
          streamedText = true;
          await emit({
            sessionUpdate: "agent_message_chunk",
            messageId: streamMessageId,
            content: { type: "text", text },
          });
        }
      };

      let started;
      try {
        started = await ozAgentRun({
          prompt: promptText,
          cwd: session.cwd,
          modelId: this.resolvedModelId(session) ?? session.modelId,
          conversationId: session.conversationId,
          profileId: session.profileId,
          computerUse: session.computerUse,
          signal: abort.signal,
          onEvent,
        });
      } catch (err) {
        if (abort.signal.aborted) {
          return { stopReason: "cancelled" };
        }
        const message =
          err instanceof OzCliError
            ? err.message
            : `failed to run oz agent: ${(err as Error).message}`;
        throw Object.assign(new Error(message), { code: -32000 });
      }

      session.lastRunId = started.run_id;
      if (started.conversation_id) {
        session.conversationId = started.conversation_id;
      }
      await this.persist(sessionId, session);

      // Live NDJSON already carried assistant text for simple turns. Still poll
      // once the child exits so tool calls / late conversation blocks show up.
      // Seed seenKeys from the conversation first so poll does not re-emit the
      // same assistant text that was already streamed.
      if (streamedText && session.conversationId && !abort.signal.aborted) {
        try {
          const conversation = await ozConversationGet(session.conversationId, {
            signal: abort.signal,
          });
          const already = mapConversationDelta(conversation, new Set());
          for (const delta of already) session.seenKeys.add(delta.key);
        } catch (err) {
          console.error(
            "[oz-acp] WARN: failed to seed seenKeys after stream:",
            (err as Error).message,
          );
        }
      }

      let pollHadUpdates = false;
      let runState: string | null = started.state ?? null;
      if (!abort.signal.aborted) {
        try {
          const result = await pollRunTurn({
            session,
            runId: started.run_id,
            emit,
            signal: abort.signal,
            // Stream path already waited for the run process; a short drain is enough.
            drainPasses: streamedText ? 1 : 3,
            intervalMs: streamedText ? 250 : 500,
          });
          pollHadUpdates = result.hadUpdates;
          runState = result.runState ?? runState;
          if (result.conversationId) session.conversationId = result.conversationId;
        } catch (err) {
          if (!abort.signal.aborted) {
            console.error(
              "[oz-acp] WARN: post-run poll failed:",
              (err as Error).message,
            );
          }
        }
      }

      // If the stream had text but poll never saw a terminal state, succeed.
      if (!runState && (streamedText || started.agentText)) {
        runState = "SUCCEEDED";
      }

      await this.persist(sessionId, session);

      const decision = decideStopReason({
        cancelled: abort.signal.aborted,
        runState,
        hadUpdates: streamedText || pollHadUpdates || Boolean(started.agentText),
      });

      if (decision.error) {
        throw Object.assign(new Error(decision.error), { code: -32000 });
      }

      return { stopReason: decision.stopReason ?? "end_turn" };
    } finally {
      cx.signal?.removeEventListener("abort", onCxAbort);
      if (session.activeAbort === abort) session.activeAbort = null;
    }
  }
}
