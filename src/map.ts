import type { ConversationResponse, ConversationStep } from "./types.ts";

export type AcpSessionUpdate = Record<string, unknown>;

export type MappedDelta = {
  key: string;
  update: AcpSessionUpdate;
};

function toolKind(name: string | undefined, category: string | undefined): string {
  const lower = `${category ?? ""} ${name ?? ""}`.toLowerCase();
  if (lower.includes("write") || lower.includes("edit") || lower.includes("patch")) {
    return "edit";
  }
  if (lower.includes("delete") || lower.includes("remove")) return "delete";
  if (lower.includes("move") || lower.includes("rename")) return "move";
  if (lower.includes("read") || lower.includes("view") || lower.includes("list") || lower.includes("files")) {
    return "read";
  }
  if (lower.includes("grep") || lower.includes("search") || lower.includes("find")) {
    return "search";
  }
  if (
    lower.includes("command") ||
    lower.includes("execute") ||
    lower.includes("terminal") ||
    lower.includes("run_command")
  ) {
    return "execute";
  }
  if (lower.includes("think") || lower.includes("reason") || lower.includes("plan") || lower.includes("skill")) {
    return "think";
  }
  if (lower.includes("url") || lower.includes("fetch") || lower.includes("http")) {
    return "fetch";
  }
  return "other";
}

function formatRaw(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function actionTitle(name: string | undefined, category: string | undefined): string {
  if (name && category) return `${category}: ${name}`;
  return name || category || "tool";
}

function mapActionState(state: string | undefined): string {
  switch ((state ?? "").toLowerCase()) {
    case "running":
    case "in_progress":
    case "in-progress":
      return "in_progress";
    case "failed":
    case "error":
      return "failed";
    case "denied":
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "completed":
    case "succeeded":
    case "success":
    default:
      return state ? "completed" : "completed";
  }
}

function walkSteps(steps: ConversationStep[] | undefined): ConversationStep[] {
  if (!steps?.length) return [];
  const out: ConversationStep[] = [];
  for (const step of steps) {
    out.push(step);
    out.push(...walkSteps(step.steps));
  }
  return out;
}

function contentKey(
  stepId: string | undefined,
  messageIndex: number,
  contentIndex: number,
  kind: string,
  id?: string,
): string {
  return [stepId ?? "step", messageIndex, contentIndex, kind, id ?? ""].join(":");
}

/**
 * Convert Oz conversation JSON into ACP session/update payloads for unseen content.
 * Uses stable keys so callers can track `seenKeys` across polls and session loads.
 */
export function mapConversationDelta(
  conversation: ConversationResponse,
  seenKeys: ReadonlySet<string>,
): MappedDelta[] {
  const deltas: MappedDelta[] = [];
  const steps = walkSteps(conversation.steps);

  for (const step of steps) {
    const messages = step.messages ?? [];
    for (let mi = 0; mi < messages.length; mi += 1) {
      const message = messages[mi]!;
      const role = (message.role || "").toLowerCase();
      const content = message.content ?? [];

      for (let ci = 0; ci < content.length; ci += 1) {
        const block = content[ci] as Record<string, unknown>;
        const type = String(block.type ?? "");

        if (type === "text") {
          const text = String(block.text ?? "");
          if (!text) continue;
          const messageId =
            typeof block.message_id === "string"
              ? block.message_id
              : message.message_ids?.[0];
          const key = contentKey(step.id, mi, ci, "text", messageId || text.slice(0, 24));
          if (seenKeys.has(key)) continue;

          let sessionUpdate = "agent_message_chunk";
          if (role === "user") sessionUpdate = "user_message_chunk";
          else if (role === "system") sessionUpdate = "agent_thought_chunk";
          else if (role === "assistant" || role === "tool") {
            sessionUpdate = "agent_message_chunk";
          }

          const update: AcpSessionUpdate = {
            sessionUpdate,
            content: { type: "text", text },
          };
          if (messageId) update.messageId = messageId;
          deltas.push({ key, update });
          continue;
        }

        if (type === "action") {
          const actionId = String(block.id ?? `action-${mi}-${ci}`);
          const key = contentKey(step.id, mi, ci, "action", actionId);
          if (seenKeys.has(key)) continue;
          const name = typeof block.name === "string" ? block.name : undefined;
          const category = typeof block.category === "string" ? block.category : undefined;
          const rawInput = formatRaw(block.input);
          const update: AcpSessionUpdate = {
            sessionUpdate: "tool_call",
            toolCallId: actionId,
            title: actionTitle(name, category),
            kind: toolKind(name, category),
            status: "pending",
          };
          if (rawInput) {
            update.rawInput = block.input;
            update.content = [
              {
                type: "content",
                content: { type: "text", text: rawInput },
              },
            ];
          }
          deltas.push({ key, update });
          continue;
        }

        if (type === "action_result") {
          const actionId = String(block.action_id ?? `action-result-${mi}-${ci}`);
          const state = typeof block.state === "string" ? block.state : "completed";
          const key = contentKey(step.id, mi, ci, "action_result", `${actionId}:${state}`);
          if (seenKeys.has(key)) continue;
          const rawOutput = formatRaw(block.output);
          const update: AcpSessionUpdate = {
            sessionUpdate: "tool_call_update",
            toolCallId: actionId,
            status: mapActionState(state),
          };
          if (rawOutput) {
            update.rawOutput = block.output;
            update.content = [
              {
                type: "content",
                content: { type: "text", text: rawOutput },
              },
            ];
          }
          deltas.push({ key, update });
          continue;
        }

        // Ignore events / unknown blocks for MVP.
      }
    }
  }

  return deltas;
}

export function flattenPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) {
    return typeof prompt === "string" ? prompt : "";
  }
  return prompt
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (typeof b.text === "string") return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function decideStopReason(opts: {
  cancelled: boolean;
  runState: string | null;
  hadUpdates: boolean;
}): { stopReason?: "end_turn" | "cancelled"; error?: string } {
  if (opts.cancelled) return { stopReason: "cancelled" };
  if (!opts.runState) {
    return { error: "oz run ended without a known state" };
  }
  if (opts.runState === "CANCELLED") return { stopReason: "cancelled" };
  if (opts.runState === "SUCCEEDED") return { stopReason: "end_turn" };
  if (opts.runState === "FAILED" || opts.runState === "ERROR") {
    if (opts.hadUpdates) return { stopReason: "end_turn" };
    return { error: `oz run ${opts.runState.toLowerCase()}` };
  }
  // Unexpected terminal-ish states
  if (opts.hadUpdates) return { stopReason: "end_turn" };
  return { error: `oz run stopped in state ${opts.runState}` };
}
