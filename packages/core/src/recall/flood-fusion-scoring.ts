import {
  applyEmbeddingPathModulation,
  scoreLaneReliability,
  type FusionContributionCandidate,
  type ResolvedRecallFusionWeights
} from "./fusion-delivery-adaptive-scoring.js";
import type { RecallQueryIntent } from "./recall-query-plan.js";
import type { RecallFusionStream, RecallSupplementaryData } from "./recall-service-types.js";
import { clamp01 } from "../shared/clamp.js";
import { readEnvBoolean } from "../shared/read-env-boolean.js";

// Opt-in (ALAYA_RECALL_FLOOD_FUSION): fuse normalized raw magnitudes instead of 1/(k+rank). Off → RRF rank path stays byte-identical.
export function floodFusionEnabled(): boolean {
  return readEnvBoolean("ALAYA_RECALL_FLOOD_FUSION");
}

// Opt-in (ALAYA_RECALL_FLOOD_GOVERNANCE, flood only): per-node inflow cap that bounds the
// correlated lexical family so it can't out-vote orthogonal answer-signals via redundant streams.
export function floodGovernanceEnabled(): boolean {
  return readEnvBoolean("ALAYA_RECALL_FLOOD_GOVERNANCE");
}

const LEXICAL_FAMILY_FLOOD_STREAMS: ReadonlySet<RecallFusionStream> = new Set<RecallFusionStream>([
  "lexical_fts", "trigram_fts", "evidence_fts", "evidence_structural_agreement"
]);

export function isLexicalFamilyFloodStream(stream: RecallFusionStream): boolean {
  return LEXICAL_FAMILY_FLOOD_STREAMS.has(stream);
}

// Cap the correlated lexical family at best-single-stream × cap so redundant streams can't bury
// multi-gold; orthogonal answer-signals stay unbounded. full_gold-priority, flag-gated off.
const LEXICAL_GOVERNANCE_CAP = 1.3;
export function cappedLexicalFloodSum(sum: number, max: number): number {
  return Math.min(sum, max * LEXICAL_GOVERNANCE_CAP);
}

export type FloodStreamScores = Readonly<{
  readonly scoreByKey: ReadonlyMap<string, number>;
  readonly max: number;
}>;

type FloodFusionContributionParams = Readonly<{
  readonly candidate: FusionContributionCandidate;
  readonly supplementaryData: RecallSupplementaryData;
  readonly resolved: ResolvedRecallFusionWeights;
  readonly stream: RecallFusionStream;
  readonly rawScore: number;
  readonly streamMax: number;
}>;

// Opt-in (ALAYA_RECALL_BEST_EVIDENCE, flood only): per-family max + cross-family confidence-weighted
// noisy-OR instead of summing votes — a minority-strong lens surfaces without additive weight. Off → additive.
export function bestEvidenceEnabled(): boolean {
  return readEnvBoolean("ALAYA_RECALL_BEST_EVIDENCE");
}

export type StreamFamily =
  | "lexical" | "embedding" | "path" | "temporal" | "structural" | "facet" | "activation";

const STREAM_FAMILY: Readonly<Record<RecallFusionStream, StreamFamily>> = {
  lexical_fts: "lexical", trigram_fts: "lexical", synthesis_fts: "lexical",
  evidence_fts: "lexical", evidence_structural_agreement: "lexical",
  embedding_similarity: "embedding",
  path_expansion: "path", graph_expansion: "path", entity_seed: "path",
  temporal_recency: "temporal",
  source_proximity: "structural", source_evidence_agreement: "structural",
  structural: "structural", subject_alignment: "structural", existing_score: "structural",
  facet_overlap: "facet",
  workspace_activation: "activation"
};

export function streamFamily(stream: RecallFusionStream): StreamFamily {
  return STREAM_FAMILY[stream];
}

// Per-family noisy-OR trust in [0,1]; embedding > lexical = semantic outranks surface. Override: ALAYA_RECALL_BE_CONF_JSON.
const DEFAULT_FAMILY_CONFIDENCE: Readonly<Record<StreamFamily, number>> = {
  lexical: 0.55, embedding: 0.7, path: 0.45, temporal: 0.5, structural: 0.35, facet: 0.55, activation: 0.3
};

const FamilyConfidenceOverrideSchema = {
  safeParse(value: unknown): { success: true; data: Readonly<Record<string, number>> } | { success: false } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { success: false };
    }
    const data: Record<string, number> = {};
    for (const [family, rawValue] of Object.entries(value)) {
      if (typeof rawValue !== "number" || rawValue < 0 || rawValue > 1) {
        return { success: false };
      }
      data[family] = rawValue;
    }
    return { success: true, data };
  }
};

let familyConfidenceCache: Record<StreamFamily, number> | null = null;
export function familyConfidence(): Readonly<Record<StreamFamily, number>> {
  if (familyConfidenceCache === null) {
    familyConfidenceCache = { ...DEFAULT_FAMILY_CONFIDENCE };
    const raw = process.env.ALAYA_RECALL_BE_CONF_JSON;
    if (raw !== undefined && raw.length > 0) {
      try {
        const parsed = FamilyConfidenceOverrideSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          for (const [family, value] of Object.entries(parsed.data)) {
            if (family in familyConfidenceCache) {
              familyConfidenceCache[family as StreamFamily] = value;
            }
          }
        }
      } catch {
        // keep defaults on malformed override
      }
    }
  }
  return familyConfidenceCache;
}

// reliability · (rawScore / streamMax) in [0,1]: the per-stream relevance, no additive weight.
export function resolveBestEvidenceRelevance(params: FloodFusionContributionParams): number {
  if (params.streamMax <= 0 || params.rawScore <= 0) {
    return 0;
  }
  const reliability = scoreLaneReliability({
    candidate: params.candidate,
    supplementaryData: params.supplementaryData,
    stream: params.stream
  });
  return Math.min(1, reliability * (params.rawScore / params.streamMax));
}

// Confidence-weighted noisy-OR over per-family max relevance.
export function combineBestEvidenceFamilies(relevanceByStream: ReadonlyMap<RecallFusionStream, number>): number {
  const conf = familyConfidence();
  const familyMax = new Map<StreamFamily, number>();
  for (const [stream, relevance] of relevanceByStream) {
    const family = STREAM_FAMILY[stream];
    if (relevance > (familyMax.get(family) ?? 0)) {
      familyMax.set(family, relevance);
    }
  }
  let complement = 1;
  for (const [family, relevance] of familyMax) {
    complement *= 1 - conf[family] * relevance;
  }
  return 1 - complement;
}

// Opt-in (ALAYA_RECALL_SYNTHESIS): object-axis correction — de-correlate the correlated lexical surface
// views (max+λ·rest) and gate them by embedding agreement (γ+(1−γ)·embRel). Gated intents only; others byte-identical.
export function synthesisFusionEnabled(): boolean {
  return readEnvBoolean("ALAYA_RECALL_SYNTHESIS");
}

const ALL_RECALL_INTENTS: readonly RecallQueryIntent[] = [
  "single_fact", "multi_fact", "list", "temporal", "preference", "knowledge_update"
];
const DEFAULT_SYNTHESIS_GATE_INTENTS: ReadonlySet<RecallQueryIntent> = new Set<RecallQueryIntent>(["preference"]);

let synthesisGateIntentsCache: ReadonlySet<RecallQueryIntent> | null = null;
export function synthesisGateIntents(): ReadonlySet<RecallQueryIntent> {
  if (synthesisGateIntentsCache === null) {
    const raw = process.env.ALAYA_RECALL_SYN_GATE_INTENTS;
    if (raw === undefined || raw.length === 0) {
      synthesisGateIntentsCache = DEFAULT_SYNTHESIS_GATE_INTENTS;
    } else {
      const set = new Set<RecallQueryIntent>();
      for (const token of raw.split(",").map((value) => value.trim())) {
        if ((ALL_RECALL_INTENTS as readonly string[]).includes(token)) {
          set.add(token as RecallQueryIntent);
        }
      }
      synthesisGateIntentsCache = set;
    }
  }
  return synthesisGateIntentsCache;
}

export function synthesisIntentGated(intent: RecallQueryIntent): boolean {
  return synthesisGateIntents().has(intent);
}

function readUnitEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

// Within-facet corroboration: λ=1 → additive sum (baseline), λ=0 → pure max (one surface truth).
export function synthesisDecorrLambda(): number {
  return readUnitEnv("ALAYA_RECALL_SYN_DECORR_LAMBDA", 0.5);
}

// Embedding gate floor γ: gate = γ + (1−γ)·embRel. γ=1 → no gate (baseline).
export function synthesisGateFloor(): number {
  return readUnitEnv("ALAYA_RECALL_SYN_GATE_FLOOR", 0.5);
}

// Opt-in (ALAYA_RECALL_EMBED_GATE): the embedding gate decoupled from the synthesis assembly —
// gate the lexical surface family by embedding agreement in the additive path, no de-correlation.
// Recall-win only with a retrieval-grade embedding (gte); an STS model (MiniLM) demotes single_fact gold. Off → byte-identical.
export function embeddingGateEnabled(): boolean {
  return readEnvBoolean("ALAYA_RECALL_EMBED_GATE");
}

// γ for the standalone gate; default 0 (full gate) is the gte-seed A/B optimum.
export function embeddingGateFloor(): number {
  return readUnitEnv("ALAYA_RECALL_EMBED_GATE_FLOOR", 0);
}

// single_fact is lexical truth; the semantic gate must not demote it. Default exempts it; override via ALAYA_RECALL_EMBED_GATE_INTENTS.
const DEFAULT_EMBED_GATE_INTENTS: ReadonlySet<RecallQueryIntent> = new Set<RecallQueryIntent>([
  "multi_fact", "list", "temporal", "preference", "knowledge_update"
]);
export function embeddingGateAppliesToIntent(intent: RecallQueryIntent): boolean {
  const raw = process.env.ALAYA_RECALL_EMBED_GATE_INTENTS;
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_EMBED_GATE_INTENTS.has(intent);
  }
  return raw.split(",").some((part) => part.trim() === intent);
}

// max + λ·(sum − max): collapse correlated within-family views to one corroborated relevance.
export function decorrelateFamily(contributions: readonly number[], lambda: number): number {
  let sum = 0;
  let max = 0;
  for (const value of contributions) {
    sum += value;
    if (value > max) {
      max = value;
    }
  }
  return max + lambda * (sum - max);
}

// Bounded noisy-OR de-correlation NOR_ρ: 1 − (1−c₁x₍₁₎)·∏_{i≥2}(1−(1−ρ)cᵢx₍ᵢ₎). The weighted-max
// anchor is cᵢxᵢ (not raw x); correlated views enter scaled by (1−ρ). ρ=1 → maxᵢ(cᵢxᵢ)
// (anti double-count), ρ=0 → full noisy-OR 1−∏(1−cᵢxᵢ). Always in [0,1];
// appending a 0 is a no-op; empty → 0.
export function noisyOrDecorrelate(
  values: readonly number[],
  confidences: readonly number[],
  rho: number
): number {
  if (values.length === 0) {
    return 0;
  }
  const weighted = (index: number): number =>
    clamp01(confidences[index] ?? 1) * clamp01(values[index] ?? 0);
  if (clamp01(rho) >= 1) {
    let bestWeighted = -1;
    for (let index = 0; index < values.length; index++) {
      const term = weighted(index);
      if (term > bestWeighted) {
        bestWeighted = term;
      }
    }
    return clamp01(bestWeighted);
  }
  const lambda = 1 - clamp01(rho);
  const order = values.map((_, index) => index).sort((a, b) => weighted(b) - weighted(a));
  let complement = 1;
  order.forEach((index, position) => {
    const term = clamp01(confidences[index] ?? 1) * clamp01(values[index] ?? 0);
    complement *= 1 - (position === 0 ? term : lambda * term);
  });
  return clamp01(1 - complement);
}

// γ + (1−γ)·embRel: suppress surface relevance that words-but-not-meaning topic-neighbors earn.
// embRel is pool-relative (cosine / pool-max), NOT raw cosine — raw cosine is comparable only within
// one model, so a raw-magnitude gate tracks the model's absolute scale, not semantic standing.
// γ=1 → no gate; no embedding signal → unchanged (gate acts only where it can discriminate).
export function gateSurfaceByEmbedding(
  surfaceRelevance: number,
  candidate: FusionContributionCandidate,
  floor: number,
  embeddingPoolMax: number
): number {
  const embeddingSimilarity = candidate.effectiveFactors.embedding_similarity;
  if (typeof embeddingSimilarity !== "number" || embeddingSimilarity <= 0 || embeddingPoolMax <= 0) {
    return surfaceRelevance;
  }
  const embRel = clamp01(embeddingSimilarity / embeddingPoolMax);
  return surfaceRelevance * (floor + (1 - floor) * embRel);
}

// Governance ceiling (ALAYA_RECALL_SYN_GOVERN): bound the correlated surface mass so it cannot
// out-vote orthogonal answer-signals. Default off so it A/Bs independently of the de-corr/gate.
export function synthesisGovernanceEnabled(): boolean {
  return readEnvBoolean("ALAYA_RECALL_SYN_GOVERN");
}

function readFloatEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

export function synthesisGovernRatio(): number {
  return readFloatEnv("ALAYA_RECALL_SYN_GOV_RATIO", 2, 0);
}

export function synthesisGovernFloor(): number {
  return readFloatEnv("ALAYA_RECALL_SYN_GOV_FLOOR", 0.5, 0);
}

// Surface is left intact when no orthogonal answer-signal exists; otherwise capped at floor + ratio·orthogonal.
export function applySynthesisGovernance(surfaceMass: number, orthogonalMass: number): number {
  if (orthogonalMass <= 0) {
    return surfaceMass;
  }
  return Math.min(surfaceMass, synthesisGovernFloor() + synthesisGovernRatio() * orthogonalMass);
}

// weight · reliability · (rawScore / streamMax): faithful magnitude preservation (vs RRF's
// rank-collapse), same modulation as the RRF path; streamMax<=0 contributes nothing.
export function resolveFloodFusionContribution(params: FloodFusionContributionParams): number {
  if (params.streamMax <= 0 || params.rawScore <= 0) {
    return 0;
  }
  const reliability = scoreLaneReliability({
    candidate: params.candidate,
    supplementaryData: params.supplementaryData,
    stream: params.stream
  });
  const normScore = params.rawScore / params.streamMax;
  const base = params.resolved.weights[params.stream] * reliability * normScore;
  return applyEmbeddingPathModulation(base, params.candidate, params.supplementaryData, params.stream);
}
