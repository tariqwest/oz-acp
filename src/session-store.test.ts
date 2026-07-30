import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SessionStore, sessionFromStored } from "./session-store.ts";
import type { Session } from "./types.ts";

async function tempPaths() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "oz-acp-test-"));
  return {
    stateDir,
    stateFile: path.join(stateDir, "sessions.json"),
    lockFile: path.join(stateDir, "sessions.lock"),
    modelsCacheFile: path.join(stateDir, "models_cache.json"),
  };
}

describe("SessionStore", () => {
  it("persists and restores sessions", async () => {
    const paths = await tempPaths();
    const store = new SessionStore(paths);
    const session: Session = {
      conversationId: "conv-1",
      lastRunId: "run-1",
      modelId: "auto",
      cwd: "/tmp/project",
      seenKeys: new Set(["a", "b"]),
      title: "Demo",
      activeAbort: null,
    };

    await store.save("sess-1", session);
    const loaded = await store.get("sess-1");
    assert.ok(loaded);
    assert.equal(loaded.conversationId, "conv-1");
    assert.equal(loaded.lastRunId, "run-1");
    assert.deepEqual(loaded.seenKeys, ["a", "b"]);

    const restored = sessionFromStored(loaded, "/fallback");
    assert.equal(restored.cwd, "/tmp/project");
    assert.equal(restored.seenKeys.has("a"), true);

    await store.delete("sess-1");
    assert.equal(await store.get("sess-1"), null);

    await fs.rm(paths.stateDir, { recursive: true, force: true });
  });

  it("caches models", async () => {
    const paths = await tempPaths();
    const store = new SessionStore(paths);
    await store.saveModelsCache(["auto", "gpt-5"]);
    assert.deepEqual(await store.loadModelsCache(), ["auto", "gpt-5"]);
    await fs.rm(paths.stateDir, { recursive: true, force: true });
  });
});
