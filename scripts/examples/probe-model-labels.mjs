#!/usr/bin/env node
/**
 * EXAMPLE helper — not part of the oz-acp runtime and not wired into the adapter.
 *
 * Problem: `oz model list --output-format json` is id-only. Custom / third-party /
 * BYO models often appear as bare UUIDs, so ACP hosts show "Custom <first8>"
 * until you populate ~/.config/oz-acp/model_labels.json.
 *
 * This script demonstrates one way to *infer* labels: run a short probe prompt
 * against each UUID model (a lightweight "ACP-less" mock of what a host would do)
 * and derive a human name from the model reply and/or error text.
 *
 * It is intentionally generic. It does **not** assume a particular gateway,
 * log store, or self-hosted router. Adapt the extractors below for your setup.
 *
 * Usage (from a clone, or copy the file anywhere):
 *   node scripts/examples/probe-model-labels.mjs [options]
 *   bun scripts/examples/probe-model-labels.mjs [options]
 *
 * Options:
 *   --labels-file PATH   Output path (default: $XDG_CONFIG_HOME/oz-acp/model_labels.json)
 *   --models a,b,c       Only probe these Oz model ids
 *   --uuid-only          Only UUID-shaped ids (default)
 *   --all-models         Probe every id from `oz model list`
 *   --limit N            Max models to probe
 *   --cwd PATH           Working directory for `oz agent run` (default: process cwd)
 *   --sleep-ms N         Delay between probes (default: 1500)
 *   --dry-run            List models / plan only
 *   --merge              Merge into existing labels file (default)
 *   --replace            Replace labels instead of merging
 *   --keep-going         Continue after a failed probe
 *   --source TAG         Written into model_labels.json "source" field
 *   --help
 *
 * After running, restart / re-init the ACP host session so oz-acp reloads labels.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(code = 0) {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const block = text.match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? "";
  console.log(
    block
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").replace(/^\s*$/, ""))
      .join("\n")
      .trim(),
  );
  process.exit(code);
}

function fail(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    labelsFile: null,
    models: null,
    uuidOnly: true,
    limit: null,
    cwd: process.cwd(),
    sleepMs: 1500,
    dryRun: false,
    merge: true,
    keepGoing: false,
    source: "scripts/examples/probe-model-labels.mjs",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--help" || a === "-h") usage(0);
    const take = () => {
      const v = argv[++i];
      if (v == null) fail(`${a} requires a value`);
      return v;
    };
    if (a === "--labels-file" || a.startsWith("--labels-file=")) {
      opts.labelsFile = a.includes("=") ? a.slice(a.indexOf("=") + 1) : take();
      continue;
    }
    if (a === "--models" || a.startsWith("--models=")) {
      const raw = a.includes("=") ? a.slice(a.indexOf("=") + 1) : take();
      opts.models = String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (a === "--uuid-only") {
      opts.uuidOnly = true;
      continue;
    }
    if (a === "--all-models") {
      opts.uuidOnly = false;
      continue;
    }
    if (a === "--limit" || a.startsWith("--limit=")) {
      opts.limit = Number(a.includes("=") ? a.slice(a.indexOf("=") + 1) : take());
      continue;
    }
    if (a === "--cwd" || a.startsWith("--cwd=")) {
      opts.cwd = a.includes("=") ? a.slice(a.indexOf("=") + 1) : take();
      continue;
    }
    if (a === "--sleep-ms" || a.startsWith("--sleep-ms=")) {
      opts.sleepMs = Number(a.includes("=") ? a.slice(a.indexOf("=") + 1) : take());
      continue;
    }
    if (a === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (a === "--merge") {
      opts.merge = true;
      continue;
    }
    if (a === "--replace") {
      opts.merge = false;
      continue;
    }
    if (a === "--keep-going") {
      opts.keepGoing = true;
      continue;
    }
    if (a === "--source" || a.startsWith("--source=")) {
      opts.source = a.includes("=") ? a.slice(a.indexOf("=") + 1) : take();
      continue;
    }
    fail(`unknown option: ${a}`);
  }
  return opts;
}

function defaultLabelsPath(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const home = env.HOME || os.homedir();
  const dir = xdg
    ? path.join(xdg, "oz-acp")
    : path.join(home, ".config", "oz-acp");
  return path.join(dir, "model_labels.json");
}

function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd || process.cwd(),
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    error: res.error,
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listOzModels() {
  const res = runCapture("oz", ["model", "list", "--output-format", "json"]);
  if (res.status !== 0) {
    fail(`oz model list failed: ${(res.stderr || res.stdout).trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    fail(`oz model list invalid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) fail("oz model list did not return an array");
  return parsed.map((m) => m?.id).filter((id) => typeof id === "string" && id);
}

/**
 * Lightweight stand-in for an ACP host turn: spawn `oz agent run` with a
 * unique marker prompt and collect NDJSON agent text + stderr.
 */
function runOzAgent({ modelId, prompt, cwd }) {
  const args = [
    "agent",
    "run",
    "--prompt",
    prompt,
    "--cwd",
    cwd,
    "--model",
    modelId,
    "--output-format",
    "ndjson",
  ];
  const res = runCapture("oz", args, { cwd });
  const events = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* ignore non-JSON lines */
    }
  }
  const runStarted = events.find(
    (e) => e?.type === "system" && e?.event_type === "run_started",
  );
  const agentText = events
    .filter((e) => e?.type === "agent" && typeof e.text === "string")
    .map((e) => e.text)
    .join("");
  return {
    ok: res.status === 0 && Boolean(runStarted?.run_id),
    status: res.status,
    runId: runStarted?.run_id ?? null,
    agentText,
    stdout: res.stdout,
    stderr: res.stderr,
    events,
  };
}

/**
 * Heuristics to pull a display label out of probe output.
 * Customize these for your provider / gateway / error shapes.
 */
function extractLabelCandidates({ agentText, stderr, stdout, marker }) {
  const blobs = [agentText, stderr, stdout].filter(Boolean).join("\n");
  const candidates = [];

  // 1) Bracketed provider paths often appear in streaming errors:
  //    [openrouter/anthropic/claude-sonnet-4], [my-gateway/combo-name]
  for (const m of blobs.matchAll(/\[([a-z0-9][\w./:@+-]{2,120})\]/gi)) {
    const inner = m[1].trim();
    if (!inner || inner === marker) continue;
    if (/^\d+$/.test(inner)) continue;
    if (/html|http|error|reset|timeout/i.test(inner) && !inner.includes("/")) {
      continue;
    }
    candidates.push(inner);
  }

  // 2) "model": "..." / model=... fragments in JSON-ish errors
  for (const m of blobs.matchAll(
    /["']?(?:model|resolved_model|requested_model|combo(?:_?name)?)["']?\s*[:=]\s*["']([^"'\n]{2,120})["']/gi,
  )) {
    candidates.push(m[1].trim());
  }

  // 3) If the model obeyed the self-identify instruction, take a short first line
  if (agentText) {
    const cleaned = agentText
      .replaceAll(marker, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of cleaned) {
      // Prefer lines that look like model ids / slugs, not full sentences.
      if (line.length <= 80 && !/[.?!]$/.test(line)) {
        if (/^[\w./:@+-]+$/.test(line) || line.includes("/")) {
          candidates.push(line);
        }
      }
      // Also accept "I am X" / "Model: X"
      const id = line.match(
        /(?:^i am\s+|^model\s*[:=]\s*|^name\s*[:=]\s*)(.+)$/i,
      );
      if (id?.[1]) candidates.push(id[1].trim().replace(/^["']|["']$/g, ""));
    }
  }

  return dedupeLabels(candidates);
}

function dedupeLabels(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = String(raw || "").trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

/** Rank candidates so gateway/combo slugs beat noisy HTML / generic words. */
function pickBestLabel(candidates) {
  if (!candidates.length) return null;
  const ranked = [...candidates].sort((a, b) => scoreLabel(b) - scoreLabel(a));
  return ranked[0] || null;
}

function scoreLabel(s) {
  let n = 0;
  if (s.includes("/")) n += 20;
  if (/^(auto|openrouter|openai|anthropic|google|groq|together|fireworks|deepseek|ollama)\//i.test(s)) {
    n += 15;
  }
  if (/gpt|claude|gemini|sonnet|opus|grok|kimi|qwen|deepseek|llama|mistral/i.test(s)) {
    n += 8;
  }
  if (/embed|tts|whisper|moderation/i.test(s)) n -= 30;
  if (/<!doctype|html|internal error/i.test(s)) n -= 100;
  if (UUID_RE.test(s)) n -= 50;
  n -= Math.max(0, s.length - 64) * 0.05;
  return n;
}

function loadExistingLabels(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.labels && typeof parsed.labels === "object") {
      return { ...parsed.labels };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.labelsFile = opts.labelsFile || defaultLabelsPath();

  console.log("Probe plan (example; not wired into oz-acp)");
  console.log(`  labels file: ${opts.labelsFile}`);
  console.log(`  cwd:         ${opts.cwd}`);
  console.log(`  uuid only:   ${opts.uuidOnly}`);
  console.log(`  dry-run:     ${opts.dryRun}`);

  let modelIds = opts.models;
  if (!modelIds) {
    modelIds = listOzModels();
    if (opts.uuidOnly) modelIds = modelIds.filter((id) => UUID_RE.test(id));
  }
  if (opts.limit && opts.limit > 0) modelIds = modelIds.slice(0, opts.limit);
  if (!modelIds.length) fail("no models to probe");

  console.log(`  models:      ${modelIds.length}`);
  for (const id of modelIds) console.log(`    - ${id}`);
  if (opts.dryRun) {
    console.log("[dry-run] exiting before probes");
    return;
  }

  const existing = opts.merge ? loadExistingLabels(opts.labelsFile) : {};
  const labels = { ...existing };
  const report = [];

  for (let i = 0; i < modelIds.length; i++) {
    const modelId = modelIds[i];
    const marker = `OZACP_LABEL_PROBE_${Date.now()}_${i}_${modelId.slice(0, 8)}`;
    // Ask for a short self-id; many custom backends also echo useful paths on error.
    const prompt = [
      `You are being probed only to discover which model backend you are.`,
      `Reply with a single short machine-readable model slug or name on one line`,
      `(for example provider/model-name). Do not explain.`,
      `Also include this exact marker somewhere in the reply: ${marker}`,
    ].join(" ");

    console.log(`\n==> [${i + 1}/${modelIds.length}] ${modelId}`);
    console.log(`    marker: ${marker}`);

    const run = runOzAgent({ modelId, prompt, cwd: opts.cwd });
    const candidates = extractLabelCandidates({
      agentText: run.agentText,
      stderr: run.stderr,
      stdout: run.stdout,
      marker,
    });
    const label = pickBestLabel(candidates);

    if (!label) {
      const detail = (run.stderr || run.stdout || run.agentText || "")
        .trim()
        .slice(0, 400);
      console.error(`    WARN: could not infer label${detail ? `: ${detail}` : ""}`);
      report.push({
        modelId,
        ok: false,
        marker,
        runId: run.runId,
        error: detail || "no label candidates",
        candidates,
      });
      if (!opts.keepGoing) fail(`probe failed for ${modelId}`);
    } else {
      labels[modelId] = label;
      console.log(`    label:  ${label}`);
      if (candidates.length > 1) {
        console.log(`    other:  ${candidates.filter((c) => c !== label).slice(0, 5).join(", ")}`);
      }
      report.push({
        modelId,
        ok: true,
        marker,
        runId: run.runId,
        label,
        candidates,
      });
    }

    if (i < modelIds.length - 1 && opts.sleepMs > 0) sleep(opts.sleepMs);
  }

  await fsp.mkdir(path.dirname(opts.labelsFile), { recursive: true });
  const payload = {
    labels,
    updatedAt: new Date().toISOString(),
    source: opts.source,
    notes:
      "Example probe output. Labels inferred from short oz agent run prompts " +
      "(reply text and/or error paths). Not used by oz-acp unless present at " +
      "this path; edit freely. See README § Custom / BYO / third-party model labels.",
  };
  const tmp = `${opts.labelsFile}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, opts.labelsFile);

  const reportPath = path.join(
    path.dirname(opts.labelsFile),
    "model_labels_probe_report.json",
  );
  await fsp.writeFile(
    reportPath,
    `${JSON.stringify({ report, labels }, null, 2)}\n`,
    "utf8",
  );

  const ok = report.filter((r) => r.ok).length;
  const failN = report.length - ok;
  console.log(`\nDone. labeled=${ok} failed=${failN}`);
  console.log(`labels: ${opts.labelsFile}`);
  console.log(`report: ${reportPath}`);
  if (failN && !opts.keepGoing) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
