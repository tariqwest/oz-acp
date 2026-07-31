/** User-configurable display labels for Oz model ids (esp. UUID custom models). */

import fsp from "node:fs/promises";
import path from "node:path";

export const MODEL_LABELS_FILENAME = "model_labels.json";

/** UUID v1–v5-ish id used by custom/BYO Oz models. */
export const UUID_MODEL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ModelLabelsFile = {
  /** Map of Oz model id (usually UUID) → human label. */
  labels: Record<string, string>;
  /** Optional notes from probe / user. */
  notes?: string;
  updatedAt?: string;
  source?: string;
};

export function isUuidModelId(modelId: string): boolean {
  return UUID_MODEL_RE.test(modelId.trim());
}

export function normalizeModelLabels(
  input: unknown,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;

  const root = input as Record<string, unknown>;
  const source =
    root.labels && typeof root.labels === "object" && !Array.isArray(root.labels)
      ? (root.labels as Record<string, unknown>)
      : root;

  for (const [rawKey, rawVal] of Object.entries(source)) {
    if (rawKey === "notes" || rawKey === "updatedAt" || rawKey === "source") {
      // Flat-map form should not treat metadata keys as ids when nested under labels only.
      if (source === root && (rawKey === "notes" || rawKey === "updatedAt" || rawKey === "source")) {
        continue;
      }
    }
    const key = rawKey.trim();
    if (!key) continue;
    let label = "";
    if (typeof rawVal === "string") {
      label = rawVal.trim();
    } else if (rawVal && typeof rawVal === "object" && !Array.isArray(rawVal)) {
      const obj = rawVal as Record<string, unknown>;
      const candidate =
        obj.label ?? obj.name ?? obj.display_name ?? obj.displayName ?? obj.model;
      if (typeof candidate === "string") label = candidate.trim();
    }
    if (label) out[key] = label;
  }
  return out;
}

export function parseModelLabelsFile(raw: string): ModelLabelsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { labels: {} };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { labels: {} };
  }
  const obj = parsed as Record<string, unknown>;
  const labels = normalizeModelLabels(parsed);
  return {
    labels,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
    source: typeof obj.source === "string" ? obj.source : undefined,
  };
}

/**
 * Resolve a display name for a model id.
 * Lookup order: exact id → base id → short UUID fallback → raw id.
 */
export function displayNameForModel(
  modelId: string,
  labels: Record<string, string> = {},
): string {
  const id = modelId.trim();
  if (!id) return id;
  if (labels[id]) return labels[id];

  // Allow labeling either full or base ids.
  // (UUID models have no effort suffix, so base === id.)
  const labeled = labels[id];
  if (labeled) return labeled;

  if (isUuidModelId(id)) {
    // Compact fallback so pickers are less noisy before a label is configured.
    return `Custom ${id.slice(0, 8)}`;
  }
  return id;
}

export async function loadModelLabelsFile(
  filePath: string,
): Promise<ModelLabelsFile> {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return parseModelLabelsFile(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { labels: {} };
    }
    console.error(
      "[oz-acp] WARN: failed to load model labels:",
      (err as Error).message,
    );
    return { labels: {} };
  }
}

export async function saveModelLabelsFile(
  filePath: string,
  file: ModelLabelsFile,
): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const payload: ModelLabelsFile = {
    labels: normalizeModelLabels(file.labels ?? {}),
    notes: file.notes,
    updatedAt: file.updatedAt ?? new Date().toISOString(),
    source: file.source,
  };
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, filePath);
}

/** Merge new labels into existing map (new values win). */
export function mergeModelLabels(
  base: Record<string, string>,
  extra: Record<string, string>,
): Record<string, string> {
  return { ...base, ...normalizeModelLabels(extra) };
}
