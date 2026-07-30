import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {
  decideStopReason,
  flattenPromptText,
  mapConversationDelta,
} from "./map.ts";
import {
  ozAgentRun,
  ozConversationGet,
  ozModelList,
  ozWhoami,
  OzCliError,
} from "./oz.ts";
import { SessionStore, sessionFromStored } from "./session-store.ts";
import { pollRunTurn } from "./stream.ts";
import type { Session } from "./types.ts";

const PACKAGE_VERSION = "0.1.0";
const MODEL_CONFIG_ID = "model";
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

  private async ensureModels(): Promise<string[]> {
    if (!this.modelsLoaded) await this.initModels();
    return this.availableModels;
  }

  private sessionModelsJson(modelId: string | null | undefined) {
    const models = this.availableModels.length ? this.availableModels : ["auto"];
    const current = modelId || models[0] || "auto";
    return {
      currentModelId: current,
      availableModels: models.map((id) => ({ modelId: id, name: id })),
    };
  }

  private sessionConfigOptionsJson(modelId: string | null | undefined) {
    const models = this.availableModels.length ? this.availableModels : ["auto"];
    const current = modelId || models[0] || "auto";
    return [
      {
        id: MODEL_CONFIG_ID,
        name: "Model",
        category: "model",
        type: "select",
        currentValue: current,
        options: models.map((id) => ({ value: id, name: id })),
      },
    ];
  }

  private sessionConfigResult(sessionId: string, session: Session) {
    return {
      sessionId,
      models: this.sessionModelsJson(session.modelId),
      configOptions: this.sessionConfigOptionsJson(session.modelId),
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
    await this.ensureModels();
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
    await this.ensureModels();
    const sessionId = randomUUID();
    const session: Session = {
      conversationId: null,
      lastRunId: null,
      modelId: null,
      cwd: cwdFromParams(params, this.defaultCwd),
      seenKeys: new Set(),
      title: null,
      activeAbort: null,
    };
    this.evictIfNeeded();
    this.sessions.set(sessionId, session);
    await this.persist(sessionId, session);
    return this.sessionConfigResult(sessionId, session) as acp.NewSessionResponse;
  }

  async loadSession(
    params: acp.LoadSessionRequest,
    cx?: AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    await this.ensureModels();
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
    await this.ensureModels();
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
    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), {
        code: -32000,
      });
    }
    session.modelId = modelId;
    await this.persist(sessionId, session);
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const sessionId = params.sessionId;
    const configId = params.configId;
    const value = params.value;
    if (!sessionId || !configId || value == null || value === "") {
      throw Object.assign(new Error("missing sessionId, configId, or value"), {
        code: -32602,
      });
    }
    if (configId !== MODEL_CONFIG_ID) {
      throw Object.assign(new Error(`unknown configId: ${configId}`), {
        code: -32602,
      });
    }
    const session = await this.restoreSession(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown sessionId: ${sessionId}`), {
        code: -32000,
      });
    }
    session.modelId = String(value);
    await this.persist(sessionId, session);
    return {
      configOptions: this.sessionConfigOptionsJson(session.modelId),
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
    await this.ensureModels();
    const sessionId = params.sessionId;
    if (!sessionId) {
      throw Object.assign(new Error("missing sessionId"), { code: -32602 });
    }

    let session = await this.restoreSession(sessionId);
    if (!session) {
      // Allow hosts that skip explicit new/load in tests: create ephemeral binding.
      session = {
        conversationId: null,
        lastRunId: null,
        modelId: null,
        cwd: this.defaultCwd,
        seenKeys: new Set(),
        title: null,
        activeAbort: null,
      };
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
      let started;
      try {
        started = await ozAgentRun({
          prompt: promptText,
          cwd: session.cwd,
          modelId: session.modelId,
          conversationId: session.conversationId,
          signal: abort.signal,
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
      await this.persist(sessionId, session);

      const result = await pollRunTurn({
        session,
        runId: started.run_id,
        emit,
        signal: abort.signal,
      });

      await this.persist(sessionId, session);

      const decision = decideStopReason({
        cancelled: abort.signal.aborted,
        runState: result.runState,
        hadUpdates: result.hadUpdates,
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
