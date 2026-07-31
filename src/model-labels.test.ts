import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  displayNameForModel,
  isUuidModelId,
  loadModelLabelsFile,
  mergeModelLabels,
  normalizeModelLabels,
  parseModelLabelsFile,
  saveModelLabelsFile,
} from "./model-labels.ts";
import { buildSessionConfigOptions, MODEL_CONFIG_ID } from "./config-options.ts";

describe("isUuidModelId", () => {
  it("detects UUID model ids", () => {
    assert.equal(isUuidModelId("c770946e-4fa3-481e-9768-dd10d5e01fde"), true);
    assert.equal(isUuidModelId("claude-4-8-opus-high"), false);
  });
});

describe("normalizeModelLabels / parseModelLabelsFile", () => {
  it("accepts nested labels and object values", () => {
    assert.deepEqual(
      normalizeModelLabels({
        labels: {
          "c770946e-4fa3-481e-9768-dd10d5e01fde": "omniroute/gpt-5.5",
          "05446706-2ea8-4578-b523-5c1728503c84": {
            model: "openrouter/anthropic/claude-sonnet-4",
          },
        },
        notes: "probe",
      }),
      {
        "c770946e-4fa3-481e-9768-dd10d5e01fde": "omniroute/gpt-5.5",
        "05446706-2ea8-4578-b523-5c1728503c84":
          "openrouter/anthropic/claude-sonnet-4",
      },
    );
  });

  it("accepts flat maps and skips metadata keys", () => {
    const file = parseModelLabelsFile(
      JSON.stringify({
        "aaa": "Label A",
        notes: "ignore me as label",
        updatedAt: "2026-01-01",
      }),
    );
    assert.deepEqual(file.labels, { aaa: "Label A" });
    assert.equal(file.notes, "ignore me as label");
  });
});

describe("displayNameForModel", () => {
  it("uses configured labels and UUID fallback", () => {
    const labels = {
      "c770946e-4fa3-481e-9768-dd10d5e01fde": "omni/gpt-5.5",
    };
    assert.equal(
      displayNameForModel("c770946e-4fa3-481e-9768-dd10d5e01fde", labels),
      "omni/gpt-5.5",
    );
    assert.equal(
      displayNameForModel("05446706-2ea8-4578-b523-5c1728503c84", labels),
      "Custom 05446706",
    );
    assert.equal(displayNameForModel("claude-4-8-opus", labels), "claude-4-8-opus");
  });
});

describe("load/save model labels file", () => {
  it("round-trips labels on disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oz-acp-labels-"));
    const file = path.join(dir, "model_labels.json");
    await saveModelLabelsFile(file, {
      labels: { "c770946e-4fa3-481e-9768-dd10d5e01fde": "omni/gpt" },
      source: "test",
      notes: "roundtrip",
    });
    const loaded = await loadModelLabelsFile(file);
    assert.equal(loaded.labels["c770946e-4fa3-481e-9768-dd10d5e01fde"], "omni/gpt");
    assert.equal(loaded.source, "test");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("mergeModelLabels", () => {
  it("lets newer labels win", () => {
    assert.deepEqual(
      mergeModelLabels({ a: "1", b: "2" }, { b: "3", c: "4" }),
      { a: "1", b: "3", c: "4" },
    );
  });
});

describe("buildSessionConfigOptions with labels", () => {
  it("shows configured names for UUID models", () => {
    const uuid = "c770946e-4fa3-481e-9768-dd10d5e01fde";
    const options = buildSessionConfigOptions({
      availableModels: ["auto", uuid, "claude-4-8-opus-high"],
      profiles: [],
      modelLabels: { [uuid]: "omniroute · gpt-5.5" },
      modelDisplayName: (id) => displayNameForModel(id, { [uuid]: "omniroute · gpt-5.5" }),
      state: {
        modelId: uuid,
        effort: null,
        profileId: null,
        computerUse: false,
      },
    });
    const model = options.find((o) => o.id === MODEL_CONFIG_ID);
    assert.ok(model && model.type === "select");
    const entry = model.options.find((o) => o.value === uuid);
    assert.equal(entry?.name, "omniroute · gpt-5.5");
  });
});
