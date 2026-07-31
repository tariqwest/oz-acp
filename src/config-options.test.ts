import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyConfigOptionValue,
  availableEffortsForModel,
  buildSessionConfigOptions,
  COMPUTER_USE_CONFIG_ID,
  EFFORT_CONFIG_ID,
  MODEL_CONFIG_ID,
  parseModelId,
  PROFILE_CONFIG_ID,
  resolveModelSelection,
  resolveModelWithEffort,
  uniqueModelBases,
} from "./config-options.ts";

const MODELS = [
  "auto",
  "claude-4-8-opus-low",
  "claude-4-8-opus-medium",
  "claude-4-8-opus-high",
  "claude-4-8-opus-xhigh",
  "claude-4-8-opus-xhigh-fast",
  "claude-4-8-opus-max",
  "gemini-3.6-flash",
];

describe("parseModelId", () => {
  it("parses effort and fast suffix", () => {
    assert.deepEqual(parseModelId("claude-4-8-opus-xhigh-fast"), {
      base: "claude-4-8-opus",
      effort: "xhigh",
      fast: true,
      raw: "claude-4-8-opus-xhigh-fast",
    });
    assert.equal(parseModelId("gemini-3.6-flash").effort, null);
    assert.equal(parseModelId("auto").effort, null);
  });
});

describe("resolveModelWithEffort", () => {
  it("switches effort while preserving fast when possible", () => {
    assert.equal(
      resolveModelWithEffort("claude-4-8-opus-high", "low", MODELS),
      "claude-4-8-opus-low",
    );
    assert.equal(
      resolveModelWithEffort("claude-4-8-opus-xhigh-fast", "max", MODELS),
      "claude-4-8-opus-max",
    );
    assert.equal(
      resolveModelWithEffort("claude-4-8-opus-xhigh-fast", "xhigh", MODELS),
      "claude-4-8-opus-xhigh-fast",
    );
  });

  it("leaves models without effort variants unchanged", () => {
    assert.equal(
      resolveModelWithEffort("gemini-3.6-flash", "high", MODELS),
      "gemini-3.6-flash",
    );
  });
});

describe("availableEffortsForModel", () => {
  it("returns ordered efforts for a family", () => {
    assert.deepEqual(availableEffortsForModel("claude-4-8-opus-high", MODELS), [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    assert.deepEqual(availableEffortsForModel("gemini-3.6-flash", MODELS), []);
  });
});

describe("uniqueModelBases", () => {
  it("collapses effort variants to one base entry", () => {
    assert.deepEqual(uniqueModelBases(MODELS), [
      "auto",
      "claude-4-8-opus",
      "gemini-3.6-flash",
    ]);
  });
});

describe("resolveModelSelection", () => {
  it("expands a base model name with preferred or default effort", () => {
    assert.deepEqual(resolveModelSelection("claude-4-8-opus", "high", MODELS), {
      modelId: "claude-4-8-opus-high",
      effort: "high",
    });
    assert.deepEqual(resolveModelSelection("claude-4-8-opus", null, MODELS), {
      modelId: "claude-4-8-opus-medium",
      effort: "medium",
    });
  });

  it("preserves full catalog ids and effortless models", () => {
    assert.deepEqual(
      resolveModelSelection("claude-4-8-opus-max", "low", MODELS),
      { modelId: "claude-4-8-opus-max", effort: "max" },
    );
    assert.deepEqual(resolveModelSelection("gemini-3.6-flash", "high", MODELS), {
      modelId: "gemini-3.6-flash",
      effort: null,
    });
  });
});

describe("buildSessionConfigOptions", () => {
  it("includes model, effort, profile, and computer_use when applicable", () => {
    const options = buildSessionConfigOptions({
      availableModels: MODELS,
      profiles: [
        { id: "Unsynced", name: "Default" },
        { id: "yolo", name: "YOLO" },
      ],
      state: {
        modelId: "claude-4-8-opus-high",
        effort: "high",
        profileId: "yolo",
        computerUse: true,
      },
    });
    const byId = Object.fromEntries(options.map((o) => [o.id, o]));
    assert.equal(byId[MODEL_CONFIG_ID]?.type, "select");
    assert.equal(byId[MODEL_CONFIG_ID]?.currentValue, "claude-4-8-opus");
    assert.deepEqual(
      byId[MODEL_CONFIG_ID]?.type === "select"
        ? byId[MODEL_CONFIG_ID].options.map((o) => o.value)
        : [],
      ["auto", "claude-4-8-opus", "gemini-3.6-flash"],
    );
    assert.equal(byId[EFFORT_CONFIG_ID]?.type, "select");
    assert.equal(byId[EFFORT_CONFIG_ID]?.currentValue, "high");
    assert.equal(byId[PROFILE_CONFIG_ID]?.currentValue, "yolo");
    assert.equal(byId[COMPUTER_USE_CONFIG_ID]?.type, "boolean");
    assert.equal(byId[COMPUTER_USE_CONFIG_ID]?.currentValue, true);
  });

  it("omits effort when model has no effort variants", () => {
    const options = buildSessionConfigOptions({
      availableModels: MODELS,
      profiles: [],
      state: {
        modelId: "gemini-3.6-flash",
        effort: null,
        profileId: null,
        computerUse: false,
      },
    });
    assert.equal(
      options.some((o) => o.id === EFFORT_CONFIG_ID),
      false,
    );
    assert.equal(
      options.some((o) => o.id === PROFILE_CONFIG_ID),
      false,
    );
  });
});

describe("applyConfigOptionValue", () => {
  const baseState = {
    modelId: "claude-4-8-opus-high" as string | null,
    effort: "high" as const,
    profileId: null as string | null,
    computerUse: null as boolean | null,
  };

  it("updates model and derives effort", () => {
    const next = applyConfigOptionValue({
      configId: MODEL_CONFIG_ID,
      value: "claude-4-8-opus-max",
      state: baseState,
      availableModels: MODELS,
      profiles: [],
    });
    assert.equal(next.modelId, "claude-4-8-opus-max");
    assert.equal(next.effort, "max");
  });

  it("accepts collapsed base model names and keeps preferred effort", () => {
    const next = applyConfigOptionValue({
      configId: MODEL_CONFIG_ID,
      value: "claude-4-8-opus",
      state: baseState,
      availableModels: MODELS,
      profiles: [],
    });
    assert.equal(next.modelId, "claude-4-8-opus-high");
    assert.equal(next.effort, "high");
  });

  it("updates effort and rewrites model id", () => {
    const next = applyConfigOptionValue({
      configId: EFFORT_CONFIG_ID,
      value: "low",
      state: baseState,
      availableModels: MODELS,
      profiles: [],
    });
    assert.equal(next.effort, "low");
    assert.equal(next.modelId, "claude-4-8-opus-low");
  });

  it("updates profile and computer_use", () => {
    const next = applyConfigOptionValue({
      configId: PROFILE_CONFIG_ID,
      value: "yolo",
      state: baseState,
      availableModels: MODELS,
      profiles: [{ id: "yolo", name: "YOLO" }],
    });
    assert.equal(next.profileId, "yolo");

    const cu = applyConfigOptionValue({
      configId: COMPUTER_USE_CONFIG_ID,
      value: true,
      state: baseState,
      availableModels: MODELS,
      profiles: [],
    });
    assert.equal(cu.computerUse, true);
  });

  it("rejects unknown config ids", () => {
    assert.throws(
      () =>
        applyConfigOptionValue({
          configId: "temperature",
          value: "0.2",
          state: baseState,
          availableModels: MODELS,
          profiles: [],
        }),
      /unknown configId/,
    );
  });
});
