import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideStopReason,
  flattenPromptText,
  mapConversationDelta,
} from "./map.ts";
import { split } from "./shell-words.ts";
import type { ConversationResponse } from "./types.ts";

describe("flattenPromptText", () => {
  it("joins text blocks", () => {
    assert.equal(
      flattenPromptText([
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]),
      "hello\nworld",
    );
  });

  it("handles bare string", () => {
    assert.equal(flattenPromptText("hi"), "hi");
  });
});

describe("mapConversationDelta", () => {
  const conversation: ConversationResponse = {
    conversation_id: "c1",
    steps: [
      {
        id: "s1",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hi", message_id: "u1" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "action",
                id: "call-1",
                category: "command",
                name: "run_command",
                input: { command: "ls" },
              },
              { type: "text", text: "Looking...", message_id: "a1" },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "action_result",
                action_id: "call-1",
                state: "completed",
                output: { stdout: "ok" },
              },
            ],
          },
        ],
      },
    ],
  };

  it("maps text, tool_call, and tool_call_update", () => {
    const deltas = mapConversationDelta(conversation, new Set());
    const kinds = deltas.map((d) => d.update.sessionUpdate);
    assert.deepEqual(kinds, [
      "user_message_chunk",
      "tool_call",
      "agent_message_chunk",
      "tool_call_update",
    ]);
    assert.equal(deltas[1]!.update.toolCallId, "call-1");
    assert.equal(deltas[1]!.update.kind, "execute");
    assert.equal(deltas[3]!.update.status, "completed");
  });

  it("skips already-seen keys", () => {
    const first = mapConversationDelta(conversation, new Set());
    const seen = new Set(first.map((d) => d.key));
    const second = mapConversationDelta(conversation, seen);
    assert.equal(second.length, 0);
  });
});

describe("decideStopReason", () => {
  it("returns cancelled", () => {
    assert.deepEqual(
      decideStopReason({ cancelled: true, runState: "INPROGRESS", hadUpdates: false }),
      { stopReason: "cancelled" },
    );
  });

  it("returns end_turn on success", () => {
    assert.deepEqual(
      decideStopReason({ cancelled: false, runState: "SUCCEEDED", hadUpdates: true }),
      { stopReason: "end_turn" },
    );
  });

  it("errors on failed with no updates", () => {
    const r = decideStopReason({
      cancelled: false,
      runState: "FAILED",
      hadUpdates: false,
    });
    assert.equal(r.stopReason, undefined);
    assert.match(r.error ?? "", /failed/i);
  });
});

describe("shell-words split", () => {
  it("splits plain args", () => {
    assert.deepEqual(split("--foo bar"), ["--foo", "bar"]);
  });

  it("keeps quoted values", () => {
    assert.deepEqual(split(`--prompt "hello world"`), ["--prompt", "hello world"]);
  });
});
