import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  SessionStore,
  defaultStorePaths,
  sessionFromStored,
} from "./session-store.ts";
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

describe("defaultStorePaths", () => {
  it("uses XDG_CONFIG_HOME/oz-acp when set", () => {
    const paths = defaultStorePaths(
      { XDG_CONFIG_HOME: "/custom/config", HOME: "/home/user" },
      "/home/user",
    );
    assert.equal(paths.stateDir, path.join("/custom/config", "oz-acp"));
    assert.equal(paths.stateFile, path.join("/custom/config", "oz-acp", "sessions.json"));
    assert.equal(paths.lockFile, path.join("/custom/config", "oz-acp", "sessions.lock"));
    assert.equal(
      paths.modelsCacheFile,
      path.join("/custom/config", "oz-acp", "models_cache.json"),
    );
  });

  it("falls back to ~/.config/oz-acp when XDG_CONFIG_HOME is unset", () => {
    const paths = defaultStorePaths({ HOME: "/home/user" }, "/home/user");
    assert.equal(paths.stateDir, path.join("/home/user", ".config", "oz-acp"));
    assert.equal(
      paths.stateFile,
      path.join("/home/user", ".config", "oz-acp", "sessions.json"),
    );
  });

  it("ignores blank XDG_CONFIG_HOME", () => {
    const paths = defaultStorePaths(
      { XDG_CONFIG_HOME: "   ", HOME: "/home/user" },
      "/home/user",
    );
    assert.equal(paths.stateDir, path.join("/home/user", ".config", "oz-acp"));
  });
});

describe("SessionStore", () => {
  it("persists and restores sessions", async () => {
    const paths = await tempPaths();
    const store = new SessionStore(paths);
const session: Session = {
      conversationId: "conv-1",
      lastRunId: "run-1",
      modelId: "claude-4-8-opus-high",
      effort: "high",
      profileId: "Unsynced",
      computerUse: true,
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
    assert.equal(loaded.effort, "high");
    assert.equal(loaded.profileId, "Unsynced");
    assert.equal(loaded.computerUse, true);
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
