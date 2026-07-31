import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseAgentRunNdjsonLine,
  summarizeAgentRunEvents,
} from "./oz.ts";

const SAMPLE = `
{"type":"system","event_type":"run_started","run_id":"019fb5ee-c07b-712f-a8fd-f6f7d7cdae28","run_url":"https://oz.warp.dev/runs/019fb5ee-c07b-712f-a8fd-f6f7d7cdae28"}
{"type":"system","event_type":"conversation_started","conversation_id":"d05f9173-d8f9-4351-8da7-8e98b2da5e81"}
{"type":"agent","text":"ACP_STREAM_OK\\n"}
`.trim();

describe("parseAgentRunNdjsonLine", () => {
  it("parses run_started, conversation_started, and agent text", () => {
    const events = SAMPLE.split("\n").map((line) => parseAgentRunNdjsonLine(line));
    assert.equal(events[0]?.kind, "run_started");
    if (events[0]?.kind === "run_started") {
      assert.equal(events[0].runId, "019fb5ee-c07b-712f-a8fd-f6f7d7cdae28");
    }
    assert.equal(events[1]?.kind, "conversation_started");
    if (events[1]?.kind === "conversation_started") {
      assert.equal(
        events[1].conversationId,
        "d05f9173-d8f9-4351-8da7-8e98b2da5e81",
      );
    }
    assert.equal(events[2]?.kind, "agent_text");
    if (events[2]?.kind === "agent_text") {
      assert.equal(events[2].text, "ACP_STREAM_OK\n");
    }
  });

  it("returns null for empty/invalid lines", () => {
    assert.equal(parseAgentRunNdjsonLine(""), null);
    assert.equal(parseAgentRunNdjsonLine("not-json"), null);
  });
});

describe("summarizeAgentRunEvents", () => {
  it("aggregates ids and agent text", () => {
    const events = SAMPLE.split("\n")
      .map((line) => parseAgentRunNdjsonLine(line))
      .filter((e): e is NonNullable<typeof e> => Boolean(e));
    const summary = summarizeAgentRunEvents(events);
    assert.equal(summary.runId, "019fb5ee-c07b-712f-a8fd-f6f7d7cdae28");
    assert.equal(
      summary.conversationId,
      "d05f9173-d8f9-4351-8da7-8e98b2da5e81",
    );
    assert.equal(summary.agentText, "ACP_STREAM_OK\n");
  });
});
