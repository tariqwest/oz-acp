/** ACP session config option helpers for oz-acp. */

export const MODEL_CONFIG_ID = "model";
export const EFFORT_CONFIG_ID = "effort";
export const PROFILE_CONFIG_ID = "profile";
export const COMPUTER_USE_CONFIG_ID = "computer_use";

/** Known effort tokens, longest-first for suffix matching. */
export const EFFORT_LEVELS = [
  "no-reasoning",
  "minimal-reasoning",
  "minimal",
  "xhigh",
  "medium",
  "high",
  "low",
  "max",
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const EFFORT_SET = new Set<string>(EFFORT_LEVELS);

const EFFORT_SUFFIX_RE = new RegExp(
  `^(?<base>.+)-(?<effort>${EFFORT_LEVELS.join("|")})(?<fast>-fast)?$`,
);

export type ParsedModelId = {
  base: string;
  effort: EffortLevel | null;
  fast: boolean;
  raw: string;
};

export type SelectOption = { value: string; name: string };

export type SessionConfigOption =
  | {
      id: string;
      name: string;
      category: string;
      type: "select";
      currentValue: string;
      options: SelectOption[];
    }
  | {
      id: string;
      name: string;
      category: string;
      type: "boolean";
      currentValue: boolean;
    };

export type AgentProfile = {
  id: string;
  name: string;
};

export function isEffortLevel(value: string): value is EffortLevel {
  return EFFORT_SET.has(value);
}

/** Parse effort / optional -fast suffix from an Oz model id. */
export function parseModelId(modelId: string): ParsedModelId {
  const raw = modelId.trim();
  const match = EFFORT_SUFFIX_RE.exec(raw);
  if (!match?.groups) {
    return { base: raw, effort: null, fast: false, raw };
  }
  return {
    base: match.groups.base,
    effort: match.groups.effort as EffortLevel,
    fast: Boolean(match.groups.fast),
    raw,
  };
}

/**
 * Build candidate model ids for a base + effort, preferring non-fast then fast.
 */
export function candidateModelIds(
  base: string,
  effort: EffortLevel,
  preferFast = false,
): string[] {
  const plain = `${base}-${effort}`;
  const fast = `${base}-${effort}-fast`;
  return preferFast ? [fast, plain] : [plain, fast];
}

/**
 * Resolve a concrete model id for base+effort against the available catalog.
 * Returns null when no matching variant exists.
 */
export function resolveModelWithEffort(
  modelId: string,
  effort: EffortLevel | null | undefined,
  availableModels: string[],
): string {
  const parsed = parseModelId(modelId);
  if (!effort) return modelId;

  const available = new Set(availableModels);
  // Prefer preserving -fast when the current model already uses it.
  for (const candidate of candidateModelIds(parsed.base, effort, parsed.fast)) {
    if (available.has(candidate)) return candidate;
  }
  // Fall back to any catalog entry with same base+effort.
  for (const id of availableModels) {
    const p = parseModelId(id);
    if (p.base === parsed.base && p.effort === effort) return id;
  }
  return modelId;
}

/** Effort levels available for the base of the given model id. */
export function availableEffortsForModel(
  modelId: string,
  availableModels: string[],
): EffortLevel[] {
  const { base } = parseModelId(modelId);
  const found = new Set<EffortLevel>();
  for (const id of availableModels) {
    const p = parseModelId(id);
    if (p.base === base && p.effort) found.add(p.effort);
  }
  // Stable display order from EFFORT_LEVELS (low → high-ish for UX).
  const order: EffortLevel[] = [
    "no-reasoning",
    "minimal",
    "minimal-reasoning",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  return order.filter((e) => found.has(e));
}

/** Base model id with effort / -fast suffixes removed. */
export function modelBaseId(modelId: string): string {
  return parseModelId(modelId).base;
}

/**
 * Unique base model ids in catalog order (first occurrence wins).
 * Collapses effort variants like `…-low` / `…-high` into one entry.
 */
export function uniqueModelBases(availableModels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of availableModels) {
    const base = modelBaseId(id);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

const DEFAULT_EFFORT_PREFERENCE: EffortLevel[] = [
  "medium",
  "high",
  "low",
  "xhigh",
  "max",
  "minimal",
  "minimal-reasoning",
  "no-reasoning",
];

/** Pick a default effort for a family, preferring an existing selection when valid. */
export function pickDefaultEffort(
  efforts: EffortLevel[],
  preferred?: EffortLevel | null,
): EffortLevel | null {
  if (!efforts.length) return null;
  if (preferred && efforts.includes(preferred)) return preferred;
  for (const effort of DEFAULT_EFFORT_PREFERENCE) {
    if (efforts.includes(effort)) return effort;
  }
  return efforts[0] ?? null;
}

/**
 * Resolve a host-selected model value (base or full catalog id) to a concrete
 * Oz model id + effort. Accepts both collapsed base names and full variant ids.
 */
export function resolveModelSelection(
  selectedModel: string,
  effort: EffortLevel | null | undefined,
  availableModels: string[],
): { modelId: string; effort: EffortLevel | null } {
  const raw = selectedModel.trim();
  if (!raw) return { modelId: raw, effort: effort ?? null };

  const available = new Set(availableModels);
  const parsed = parseModelId(raw);
  const base = parsed.base;
  const efforts = availableEffortsForModel(base, availableModels);

  // Exact catalog hit with an effort suffix — honor it.
  if (available.has(raw) && parsed.effort) {
    return { modelId: raw, effort: parsed.effort };
  }

  // Exact catalog hit with no effort family (e.g. auto, gemini-3.6-flash).
  if (available.has(raw) && efforts.length === 0) {
    return { modelId: raw, effort: null };
  }

  const nextEffort =
    parsed.effort && efforts.includes(parsed.effort)
      ? parsed.effort
      : pickDefaultEffort(efforts, effort);

  if (!nextEffort) {
    if (available.has(base)) return { modelId: base, effort: null };
    const match = availableModels.find((id) => modelBaseId(id) === base);
    if (match) {
      const matchParsed = parseModelId(match);
      return { modelId: match, effort: matchParsed.effort };
    }
    return { modelId: raw, effort: effort ?? null };
  }

  return {
    modelId: resolveModelWithEffort(base, nextEffort, availableModels),
    effort: nextEffort,
  };
}

export function effortLabel(effort: EffortLevel): string {
  switch (effort) {
    case "no-reasoning":
      return "No reasoning";
    case "minimal-reasoning":
      return "Minimal reasoning";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Max";
    default:
      return effort;
  }
}

export type SessionConfigState = {
  modelId: string | null | undefined;
  effort: EffortLevel | null | undefined;
  profileId: string | null | undefined;
  computerUse: boolean | null | undefined;
};

export function buildSessionConfigOptions(opts: {
  availableModels: string[];
  profiles: AgentProfile[];
  state: SessionConfigState;
  /** Optional id → display label map (e.g. UUID custom models). */
  modelLabels?: Record<string, string>;
  /** Resolves display names; defaults to identity. */
  modelDisplayName?: (modelId: string) => string;
}): SessionConfigOption[] {
  const models = opts.availableModels.length ? opts.availableModels : ["auto"];
  const currentModel = opts.state.modelId || models[0] || "auto";
  const parsed = parseModelId(currentModel);
  const currentBase = parsed.base;
  const modelBases = uniqueModelBases(models);
  const modelSelectValues = modelBases.includes(currentBase)
    ? modelBases
    : [currentBase, ...modelBases];
  const efforts = availableEffortsForModel(currentModel, models);
  const currentEffort =
    opts.state.effort && efforts.includes(opts.state.effort)
      ? opts.state.effort
      : parsed.effort && efforts.includes(parsed.effort)
        ? parsed.effort
        : efforts[0] ?? null;
  const labelOf =
    opts.modelDisplayName ??
    ((id: string) => {
      const labels = opts.modelLabels ?? {};
      return labels[id] || id;
    });

  const options: SessionConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      // Collapse effort variants: one entry per base; name may be a user label.
      currentValue: currentBase,
      options: modelSelectValues.map((base) => ({
        value: base,
        name: labelOf(base),
      })),
    },
  ];

  if (efforts.length > 0 && currentEffort) {
    options.push({
      id: EFFORT_CONFIG_ID,
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: currentEffort,
      options: efforts.map((e) => ({ value: e, name: effortLabel(e) })),
    });
  }

  if (opts.profiles.length > 0) {
    const profiles = opts.profiles;
    const currentProfile =
      opts.state.profileId && profiles.some((p) => p.id === opts.state.profileId)
        ? opts.state.profileId
        : profiles[0]!.id;
    options.push({
      id: PROFILE_CONFIG_ID,
      name: "Profile",
      category: "mode",
      type: "select",
      currentValue: currentProfile,
      options: profiles.map((p) => ({
        value: p.id,
        name: p.name || p.id,
      })),
    });
  }

  options.push({
    id: COMPUTER_USE_CONFIG_ID,
    name: "Computer use",
    category: "mode",
    type: "boolean",
    currentValue: opts.state.computerUse ?? false,
  });

  return options;
}

export function applyConfigOptionValue(input: {
  configId: string;
  value: unknown;
  state: {
    modelId: string | null;
    effort: EffortLevel | null;
    profileId: string | null;
    computerUse: boolean | null;
  };
  availableModels: string[];
  profiles: AgentProfile[];
}): {
  modelId: string | null;
  effort: EffortLevel | null;
  profileId: string | null;
  computerUse: boolean | null;
} {
  const { configId, value, availableModels, profiles } = input;
  let { modelId, effort, profileId, computerUse } = input.state;
  const models = availableModels.length ? availableModels : ["auto"];

  if (configId === MODEL_CONFIG_ID) {
    const next = String(value);
    if (!next) throw invalid("empty model value");
    const resolved = resolveModelSelection(next, effort, models);
    modelId = resolved.modelId;
    effort = resolved.effort;
    return { modelId, effort, profileId, computerUse };
  }

  if (configId === EFFORT_CONFIG_ID) {
    const next = String(value);
    if (!isEffortLevel(next)) {
      throw invalid(`invalid effort: ${next}`);
    }
    const current = modelId || models[0] || "auto";
    const efforts = availableEffortsForModel(current, models);
    if (!efforts.includes(next)) {
      throw invalid(`effort ${next} is not available for model ${current}`);
    }
    effort = next;
    modelId = resolveModelWithEffort(current, next, models);
    return { modelId, effort, profileId, computerUse };
  }

  if (configId === PROFILE_CONFIG_ID) {
    const next = String(value);
    if (!next) throw invalid("empty profile value");
    if (profiles.length && !profiles.some((p) => p.id === next)) {
      throw invalid(`unknown profile: ${next}`);
    }
    profileId = next;
    return { modelId, effort, profileId, computerUse };
  }

  if (configId === COMPUTER_USE_CONFIG_ID) {
    if (typeof value === "boolean") {
      computerUse = value;
    } else if (value === "true" || value === "1") {
      computerUse = true;
    } else if (value === "false" || value === "0") {
      computerUse = false;
    } else {
      throw invalid(`invalid computer_use value: ${String(value)}`);
    }
    return { modelId, effort, profileId, computerUse };
  }

  throw invalid(`unknown configId: ${configId}`);
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: -32602 });
}
