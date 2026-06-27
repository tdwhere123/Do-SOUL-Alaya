import {
  applyEmbeddingPathModulation,
  scoreLaneReliability,
  type FusionContributionCandidate,
  type ResolvedRecallFusionWeights
} from "./fusion-delivery-adaptive-scoring.js";
import type { RecallQueryIntent } from "./recall-query-plan.js";
import type { RecallFusionStream, RecallSupplementaryData } from "./recall-service-types.js";

// Opt-in (ALAYA_RECALL_FLOOD_FUSION): fuse normalized raw magnitudes instead of 1/(k+rank). Off → RRF rank path stays byte-identical.
export function floodFusionEnabled(): boolean {
  const raw = process.env.ALAYA_RECALL_FLOOD_FUSION;
  return raw === "on" || raw === "1" || raw === "true";
}

// Opt-in (ALAYA_RECALL_FLOOD_GOVERNANCE, flood only): per-node inflow cap that bounds the
// correlated lexical family so it can't out-vote orthogonal answer-signals via redundant streams.
export function floodGovernanceEnabled(): boolean {
  const raw = process.env.ALAYA_RECALL_FLOOD_GOVERNANCE;
  return raw === "on" || raw === "1" || raw === "true";
}

const LEXICAL_FAMILY_FLOOD_STREAMS: ReadonlySet<RecallFusionStream> = new Set<RecallFusionStream>([
  "lexical_fts", "trigram_fts", "evidence_fts", "evidence_structural_agreement"
]);

export function isLexicalFamilyFloodStream(stream: RecallFusionStream): boolean {
  return LEXICAL_FAMILY_FLOOD_STREAMS.has(stream);
}

// Governance: 4 redundant lexical streams summing to ~4x on one candidate over-concentrates the top
// and buries multi-gold. Cap the family's combined inflow at its best single stream x cap; orthogonal
// answer-signals (embedding/path/temporal/structural) are never bounded. This is the full_gold-priority
// form (wins multi-fact coverage at an any-gold/single-fact cost — kept flag-gated, default off).
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

// Opt-in (ALAYA_RECALL_BEST_EVIDENCE, flood only): combine streams as conditional relevance lenses
// instead of summing votes. Per-family max de-correlates the lexical family (one relevance, not 13
// votes); cross-family confidence-weighted noisy-OR lets a minority-but-strong lens (embedding on an
// inference-gap gold) surface without high additive weight. Off -> additive path stays byte-identical.
export function bestEvidenceEnabled(): boolean {
  const raw = process.env.ALAYA_RECALL_BEST_EVIDENCE;
  return raw === "on" || raw === "1" || raw === "true";
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

// Per-family confidence in [0,1]: how much a family's relevance claim is trusted in the noisy-OR.
// Embedding > lexical encodes "semantic relevance outranks surface relevance for answer-relation".
// Override via ALAYA_RECALL_BE_CONF_JSON ({family: number}).
const DEFAULT_FAMILY_CONFIDENCE: Readonly<Record<StreamFamily, number>> = {
  lexical: 0.55, embedding: 0.7, path: 0.45, temporal: 0.5, structural: 0.35, facet: 0.55, activation: 0.3
};

let familyConfidenceCache: Record<StreamFamily, number> | null = null;
export function familyConfidence(): Readonly<Record<StreamFamily, number>> {
  if (familyConfidenceCache === null) {
    familyConfidenceCache = { ...DEFAULT_FAMILY_CONFIDENCE };
    const raw = process.env.ALAYA_RECALL_BE_CONF_JSON;
    if (raw !== undefined && raw.length > 0) {
      try {
        const parsed = JSON.parse(raw) as Partial<Record<StreamFamily, number>>;
        for (const [family, value] of Object.entries(parsed)) {
          if (typeof value === "number" && family in familyConfidenceCache) {
            familyConfidenceCache[family as StreamFamily] = Math.max(0, Math.min(1, value));
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

// Opt-in (ALAYA_RECALL_SYNTHESIS): object-axis correction before the RRF cross-section. The lexical
// streams are correlated views of one surface facet, so they de-correlate to a single relevance
// (max + λ·rest) instead of N additive votes; for answer-relation intents the surface facet is gated
// by embedding agreement (γ + (1−γ)·embRel) so topic-neighbors that share words but not meaning are
// suppressed. Scoped to gated intents — every other intent stays byte-identical to additive RRF.
export function synthesisFusionEnabled(): boolean {
  const raw = process.env.ALAYA_RECALL_SYNTHESIS;
  return raw === "on" || raw === "1" || raw === "true";
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

// max + λ·(sum − max): collapse correlated lexical views to one corroborated surface relevance.
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
