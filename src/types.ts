import { z } from "zod";

export const RunStateSchema = z.enum([
  "QUEUED",
  "PENDING",
  "CLAIMED",
  "INPROGRESS",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "ERROR",
  "CANCELLED",
  "UNKNOWN",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const RunAgentResponseSchema = z.object({
  run_id: z.string(),
  task_id: z.string().optional(),
  state: RunStateSchema.or(z.string()).optional(),
  conversation_id: z.string().nullable().optional(),
  at_capacity: z.boolean().optional(),
});
export type RunAgentResponse = z.infer<typeof RunAgentResponseSchema>;

/** One NDJSON event from `oz agent run --output-format json|ndjson`. */
export type AgentRunStreamEvent =
  | {
      kind: "run_started";
      runId: string;
      runUrl?: string;
      raw: Record<string, unknown>;
    }
  | {
      kind: "conversation_started";
      conversationId: string;
      raw: Record<string, unknown>;
    }
  | {
      kind: "agent_text";
      text: string;
      raw: Record<string, unknown>;
    }
  | {
      kind: "other";
      raw: Record<string, unknown>;
    };

export const RunItemSchema = z
  .object({
    run_id: z.string(),
    conversation_id: z.string().nullable().optional(),
    state: RunStateSchema.or(z.string()),
    title: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    status_message: z.unknown().optional(),
  })
  .passthrough();
export type RunItem = z.infer<typeof RunItemSchema>;

export const ModelListSchema = z.array(
  z
    .object({
      id: z.string(),
    })
    .passthrough(),
);
export type ModelList = z.infer<typeof ModelListSchema>;

export const WhoamiSchema = z
  .object({
    uid: z.string().optional(),
    type: z.string().optional(),
    display_name: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();

export const TextContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    message_id: z.string().optional(),
  })
  .passthrough();

export const ActionContentSchema = z
  .object({
    type: z.literal("action"),
    category: z.string().optional(),
    name: z.string().optional(),
    id: z.string(),
    input: z.unknown().optional(),
  })
  .passthrough();

export const ActionResultContentSchema = z
  .object({
    type: z.literal("action_result"),
    action_id: z.string(),
    state: z.string().optional(),
    output: z.unknown().optional(),
  })
  .passthrough();

export const EventContentSchema = z
  .object({
    type: z.literal("event"),
  })
  .passthrough();

export const ContentBlockSchema = z.union([
  TextContentSchema,
  ActionContentSchema,
  ActionResultContentSchema,
  EventContentSchema,
  z.object({ type: z.string() }).passthrough(),
]);

export const ConversationMessageSchema = z
  .object({
    role: z.string(),
    content: z.array(ContentBlockSchema).default([]),
    message_ids: z.array(z.string()).optional(),
    request_id: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export type ConversationStep = {
  id?: string;
  description?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  messages?: ConversationMessage[];
  steps?: ConversationStep[];
  [key: string]: unknown;
};

export const ConversationStepSchema: z.ZodType<ConversationStep> = z.lazy(() =>
  z
    .object({
      id: z.string().optional(),
      description: z.string().nullable().optional(),
      started_at: z.string().nullable().optional(),
      completed_at: z.string().nullable().optional(),
      messages: z.array(ConversationMessageSchema).optional(),
      steps: z.array(ConversationStepSchema).optional(),
    })
    .passthrough(),
);

export const ConversationResponseSchema = z.object({
  conversation_id: z.string(),
  steps: z.array(ConversationStepSchema).default([]),
});
export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;

export const EffortLevelSchema = z.enum([
  "no-reasoning",
  "minimal-reasoning",
  "minimal",
  "xhigh",
  "medium",
  "high",
  "low",
  "max",
]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export const StoredSessionSchema = z.object({
  conversationId: z.string().nullable().optional(),
  lastRunId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  effort: EffortLevelSchema.nullable().optional(),
  profileId: z.string().nullable().optional(),
  computerUse: z.boolean().nullable().optional(),
  cwd: z.string().optional(),
  seenKeys: z.array(z.string()).default([]),
  title: z.string().nullable().optional(),
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

export const SessionStoreSchema = z.object({
  sessions: z.record(z.string(), StoredSessionSchema).default({}),
});
export type SessionStoreFile = z.infer<typeof SessionStoreSchema>;

export type Session = {
  conversationId: string | null;
  lastRunId: string | null;
  modelId: string | null;
  effort: EffortLevel | null;
  profileId: string | null;
  computerUse: boolean | null;
  cwd: string;
  seenKeys: Set<string>;
  title: string | null;
  activeAbort: AbortController | null;
};

export const TERMINAL_RUN_STATES = new Set<string>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "ERROR",
]);

export function isTerminalRunState(state: string): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

export function isFailedRunState(state: string): boolean {
  return state === "FAILED" || state === "ERROR";
}
