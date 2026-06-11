import { DYNAMICS_CONSTANTS, type ActivationWeights, type ActivationWeightsPatch, type RecallPolicy } from "@do-soul/alaya-protocol";
import { RECALL_FUSION_STREAMS } from "@do-soul/alaya-core";
import type { RecallWeightOverridesSummary } from "@do-soul/alaya-eval";

export const ALAYA_RECALL_WEIGHT_OVERRIDES_ENV = "ALAYA_RECALL_WEIGHT_OVERRIDES";

const ACTIVATION_WEIGHT_KEYS = [
  "scope_match",
  "domain_match",
  "retention",
  "freshness",
  "relevance",
  "graph_support",
  "budget_penalty",
  "conflict_penalty"
] as const satisfies readonly (keyof ActivationWeights)[];

const ADDITIVE_WEIGHT_KEYS = [
  "NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT",
  "CONFIDENCE_DIRECT_WEIGHT",
  "PATH_PLASTICITY_WEIGHT"
] as const;

// see also: packages/core/src/recall/fusion-delivery.ts:resolveRrfFusionWeights and
// packages/core/src/recall/scoring.ts:resolveFusionScoringWeights (read these non-stream knobs
// alongside per-stream weights)
const FUSION_NON_STREAM_KEYS = [
  "RRF_K",
  "rrf_k",
  "QUERY_EVIDENCE_BASE_TRANSFER_MAX",
  "QUERY_EVIDENCE_BASE_WEIGHT_FLOOR"
] as const;

// invariant: per-stream keys derive from RECALL_FUSION_STREAMS, so every
// allowed key maps to a real weight slot in resolveRrfFusionWeights and a
// new stream is sweepable without editing this list.
const FUSION_WEIGHT_KEYS = [
  ...RECALL_FUSION_STREAMS,
  ...FUSION_NON_STREAM_KEYS
] as const;

type AdditiveWeightKey = (typeof ADDITIVE_WEIGHT_KEYS)[number];

type AdditiveWeightPatch = Partial<Record<AdditiveWeightKey, number>>;

export interface BenchRecallWeightOverrides {
  readonly source: "cli" | "env";
  readonly activationWeightsPatch?: ActivationWeightsPatch;
  readonly additive?: AdditiveWeightPatch;
  readonly fusionWeights?: Readonly<Record<string, number>>;
  readonly summary: RecallWeightOverridesSummary;
}

export function resolveBenchRecallWeightOverrides(input: {
  readonly cliJson?: string;
  readonly envJson?: string;
}): BenchRecallWeightOverrides | undefined {
  const cliJson = normalizeOptionalJson(input.cliJson);
  const envJson = normalizeOptionalJson(input.envJson);
  if (cliJson === undefined && envJson === undefined) {
    return undefined;
  }

  const source = cliJson === undefined ? "env" : "cli";
  const rawJson = cliJson ?? envJson;
  if (rawJson === undefined) {
    return undefined;
  }

  const parsed = parseJsonObject(rawJson, source);
  const allowedTopLevel = new Set([
    "activation_weights_phase4b",
    "additive",
    "fusion_weights"
  ]);
  rejectUnknownKeys(parsed, allowedTopLevel, "weight overrides");

  const activationWeightsPatch = parseActivationWeightsPatch(
    parsed.activation_weights_phase4b
  );
  const additive = parseAdditiveWeights(parsed.additive);
  const fusionWeights = parseFusionWeights(parsed.fusion_weights);

  if (
    activationWeightsPatch === undefined &&
    additive === undefined &&
    fusionWeights === undefined
  ) {
    throw new Error(`${source} recall weight overrides must include at least one supported override`);
  }

  const summary: RecallWeightOverridesSummary = {
    source,
    ...(activationWeightsPatch === undefined
      ? {}
      : { activation_weights_phase4b: resolveActivationWeightsForSummary(activationWeightsPatch) }),
    ...(additive === undefined ? {} : { additive }),
    ...(fusionWeights === undefined ? {} : { fusion_weights: fusionWeights })
  };

  return Object.freeze({
    source,
    ...(activationWeightsPatch === undefined ? {} : { activationWeightsPatch }),
    ...(additive === undefined ? {} : { additive }),
    ...(fusionWeights === undefined ? {} : { fusionWeights }),
    summary
  });
}

export function applyBenchRecallWeightOverrides(
  policy: RecallPolicy,
  overrides: BenchRecallWeightOverrides | undefined
): RecallPolicy {
  if (overrides === undefined) {
    return policy;
  }

  return {
    ...policy,
    ...(overrides.activationWeightsPatch === undefined
      ? {}
      : {
          domain_weight_overrides: {
            ...policy.domain_weight_overrides,
            "bench-seed": overrides.activationWeightsPatch,
            "bench-reviewed": overrides.activationWeightsPatch
          }
        }),
    ...((overrides.additive === undefined && overrides.fusionWeights === undefined)
      ? {}
      : {
          scoring_weight_overrides: {
            ...policy.scoring_weight_overrides,
            ...(overrides.additive === undefined ? {} : { additive: overrides.additive }),
            ...(overrides.fusionWeights === undefined ? {} : { fusion_weights: overrides.fusionWeights })
          }
        })
  };
}

export function formatBenchRecallWeightOverrides(
  overrides: BenchRecallWeightOverrides
): string {
  const parts = [`source=${overrides.source}`];
  if (overrides.summary.activation_weights_phase4b !== undefined) {
    parts.push(
      `activation_weights_phase4b={${formatNumberMap(overrides.summary.activation_weights_phase4b)}}`
    );
  }
  if (overrides.summary.additive !== undefined) {
    parts.push(`additive={${formatNumberMap(overrides.summary.additive)}}`);
  }
  if (overrides.summary.fusion_weights !== undefined) {
    parts.push(`fusion_weights={${formatNumberMap(overrides.summary.fusion_weights)}}`);
  }
  return parts.join(" ");
}

function normalizeOptionalJson(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function parseJsonObject(rawJson: string, source: "cli" | "env"): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`${source} recall weight overrides must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} recall weight overrides must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseActivationWeightsPatch(value: unknown): ActivationWeightsPatch | undefined {
  if (value === undefined) {
    return undefined;
  }
  const object = parseObject(value, "activation_weights_phase4b");
  rejectUnknownKeys(object, new Set(ACTIVATION_WEIGHT_KEYS), "activation_weights_phase4b");

  const patch: Partial<Record<keyof ActivationWeights, number>> = {};
  for (const key of ACTIVATION_WEIGHT_KEYS) {
    if (object[key] === undefined) {
      continue;
    }
    patch[key] = readFiniteNumber(object[key], `activation_weights_phase4b.${key}`, {
      min: 0,
      max: 1
    });
  }
  if (Object.keys(patch).length === 0) {
    return undefined;
  }

  assertActivationWeightsSumToOne(resolveActivationWeightsForSummary(patch));
  return Object.freeze(patch) as ActivationWeightsPatch;
}

function parseAdditiveWeights(value: unknown): AdditiveWeightPatch | undefined {
  if (value === undefined) {
    return undefined;
  }
  const object = parseObject(value, "additive");
  rejectUnknownKeys(object, new Set(ADDITIVE_WEIGHT_KEYS), "additive");

  const patch: AdditiveWeightPatch = {};
  for (const key of ADDITIVE_WEIGHT_KEYS) {
    if (object[key] === undefined) {
      continue;
    }
    patch[key] = readFiniteNumber(object[key], `additive.${key}`, { min: 0 });
  }
  return Object.keys(patch).length === 0 ? undefined : Object.freeze(patch);
}

function parseFusionWeights(value: unknown): Readonly<Record<string, number>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const object = parseObject(value, "fusion_weights");
  rejectUnknownKeys(object, new Set(FUSION_WEIGHT_KEYS), "fusion_weights");
  const weights: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(object)) {
    if (key.trim().length === 0) {
      throw new Error("fusion_weights keys must be non-empty strings");
    }
    weights[key] = readFiniteNumber(rawValue, `fusion_weights.${key}`, { min: 0 });
  }
  return Object.keys(weights).length === 0 ? undefined : Object.freeze(weights);
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  object: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown key(s): ${unknown.sort().join(", ")}`);
  }
}

function readFiniteNumber(
  value: unknown,
  label: string,
  bounds: Readonly<{ readonly min?: number; readonly max?: number }>
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new Error(`${label} must be >= ${bounds.min}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new Error(`${label} must be <= ${bounds.max}`);
  }
  return value;
}

function resolveActivationWeightsForSummary(
  patch: Readonly<Partial<Record<keyof ActivationWeights, number>>>
): ActivationWeights {
  return Object.freeze({
    ...DYNAMICS_CONSTANTS.activation_weights_phase4b,
    ...patch
  }) as ActivationWeights;
}

function assertActivationWeightsSumToOne(weights: Readonly<ActivationWeights>): void {
  const sum = ACTIVATION_WEIGHT_KEYS.reduce((total, key) => total + weights[key], 0);
  if (Math.abs(sum - 1) >= 1e-6) {
    throw new Error(`activation_weights_phase4b must sum to 1.0 after defaults, got ${sum}`);
  }
}

function formatNumberMap(values: Readonly<Record<string, number | undefined>>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${formatCompactNumber(value)}`)
    .join(",");
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(6)).toString();
}
