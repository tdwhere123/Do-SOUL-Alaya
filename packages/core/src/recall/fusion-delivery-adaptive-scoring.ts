import type { MemoryEntry, RecallPolicy, RecallScoreFactors } from "@do-soul/alaya-protocol";
import { countOrthogonalLexicalFields, lexicalDecorrEnabled } from "./lexical-decorrelation.js";
import { classifyRecallIntent } from "./recall-query-plan.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import { clamp01 } from "./recall-service-helpers.js";
import type { RecallFusionStream, RecallSupplementaryData } from "./recall-service-types.js";
import { resolveDefaultFusionWeightForIntent } from "./temporal-fusion-scoring.js";

const EMBEDDING_PATH_MODULATION_GAIN = 0.25;
const RECALL_RRF_DEFAULT_K = 60;

export type ResolvedRecallFusionWeights = Readonly<{
  readonly kByStream: Readonly<Record<RecallFusionStream, number>>;
  readonly weights: Readonly<Record<RecallFusionStream, number>>;
}>;

export type FusionContributionCandidate = Readonly<{
  readonly entry: Readonly<MemoryEntry>;
  readonly effectiveFactors: Readonly<RecallScoreFactors>;
  readonly structuralScore?: number | null;
}>;

type FusionContributionParams = Readonly<{
  readonly candidate: FusionContributionCandidate;
  readonly supplementaryData: RecallSupplementaryData;
  readonly resolved: ResolvedRecallFusionWeights;
  readonly stream: RecallFusionStream;
  readonly rank: number;
}>;

type LaneReliabilityParams = Readonly<{
  readonly candidate: FusionContributionCandidate;
  readonly supplementaryData: RecallSupplementaryData;
  readonly stream: RecallFusionStream;
}>;

export function resolveRrfFusionWeights(params: Readonly<{
  readonly policy: Readonly<RecallPolicy>;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly streams: readonly RecallFusionStream[];
  readonly baseWeights: Readonly<Record<RecallFusionStream, number>>;
}>): ResolvedRecallFusionWeights {
  const overrides = parseFusionWeightOverrides(params.policy.scoring_weight_overrides?.fusion_weights);
  const fallbackK = readPositiveInteger(overrides.RRF_K ?? overrides.rrf_k, RECALL_RRF_DEFAULT_K);
  const weights = Object.fromEntries(
    params.streams.map((stream) => {
      const baseWeight = resolveDefaultFusionWeightForIntent(stream, params.baseWeights[stream], params.queryProbes);
      return [stream, overrides[stream] ?? baseWeight];
    })
  ) as Record<RecallFusionStream, number>;
  const kByStream = Object.fromEntries(
    params.streams.map((stream) => [
      stream,
      readPositiveInteger(overrides[`${stream}_rrf_k`], resolveDefaultRrfK(stream, fallbackK, params.queryProbes))
    ])
  ) as Record<RecallFusionStream, number>;
  return Object.freeze({
    kByStream: Object.freeze(kByStream),
    weights: Object.freeze(weights)
  });
}

export function resolveFusionContribution(params: FusionContributionParams): number {
  const reliability = scoreLaneReliability(params);
  const k = params.resolved.kByStream[params.stream];
  const base = params.resolved.weights[params.stream] * reliability / (k + params.rank);
  return applyEmbeddingPathModulation(base, params.candidate, params.supplementaryData, params.stream);
}

// Same embedding cosine modulation the RRF path applies; shared so flood mode does not duplicate it.
export function applyEmbeddingPathModulation(
  contribution: number,
  candidate: FusionContributionCandidate,
  supplementaryData: RecallSupplementaryData,
  stream: RecallFusionStream
): number {
  if (stream !== "path_expansion" && stream !== "graph_expansion") {
    return contribution;
  }
  const cos = clamp01(supplementaryData.embeddingSimilarityScores?.[candidate.entry.object_id] ?? 0.5);
  return contribution * (1 + EMBEDDING_PATH_MODULATION_GAIN * Math.max(0, 2 * cos - 1));
}

function parseFusionWeightOverrides(value: unknown): Readonly<Record<string, number>> {
  const record = toUnknownRecord(value);
  if (record === null) {
    return Object.freeze({});
  }
  const entries: Array<readonly [string, number]> = [];
  for (const [key, candidate] of Object.entries(record)) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      entries.push([key, candidate]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

function toUnknownRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function resolveDefaultRrfK(
  stream: RecallFusionStream,
  fallbackK: number,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  const intent = classifyRecallIntent(queryProbes);
  if (stream === "subject_alignment" && intent === "preference") return 40;
  if (stream === "temporal_recency" && (intent === "temporal" || intent === "knowledge_update")) return 40;
  if (stream === "embedding_similarity" || stream === "source_evidence_agreement") return 45;
  if (stream === "source_proximity" || stream === "entity_seed") return 55;
  if (stream === "lexical_fts") return 72;
  if (stream === "trigram_fts" || stream === "structural" || stream === "workspace_activation") return 90;
  if (stream === "evidence_fts") return 68;
  if (stream === "evidence_structural_agreement") return 75;
  if (stream === "graph_expansion" || stream === "path_expansion") return fallbackK;
  if (stream === "synthesis_fts") return 80;
  return fallbackK;
}

export function scoreLaneReliability(params: LaneReliabilityParams): number {
  if (!isLexicalFamilyStream(params.stream)) {
    return 1;
  }
  const context = buildLexicalFamilyContext(params.candidate, params.supplementaryData);
  if (params.stream === "trigram_fts") {
    return scoreTrigramReliability(params.supplementaryData.queryProbes, context);
  }
  if (params.stream === "evidence_structural_agreement") {
    return context.hasIndependentSupport ? 0.9 : 0.75;
  }
  if (params.stream === "evidence_fts") {
    return context.hasIndependentSupport ? 1 : scoreBroadLexicalReliability(params.supplementaryData.queryProbes, context, 0.85);
  }
  return scoreBroadLexicalReliability(params.supplementaryData.queryProbes, context, 0.9);
}

type LexicalFamilyContext = Readonly<{
  readonly lexicalFamilyHitCount: number;
  readonly orthogonalFieldCount: number;
  readonly hasIndependentSupport: boolean;
}>;

// Redundant when >=3 lexical lanes pile onto fewer orthogonal fields; flag off collapses to the raw lane-count gate.
function isRedundantLexicalFamily(context: LexicalFamilyContext): boolean {
  if (context.lexicalFamilyHitCount < 3 || context.hasIndependentSupport) {
    return false;
  }
  return !lexicalDecorrEnabled() || context.lexicalFamilyHitCount > context.orthogonalFieldCount;
}

function scoreBroadLexicalReliability(
  queryProbes: Readonly<RecallQueryProbes>,
  context: LexicalFamilyContext,
  floor: number
): number {
  if (!isRedundantLexicalFamily(context)) {
    return 1;
  }
  const intent = classifyRecallIntent(queryProbes);
  return intent === "single_fact" ? floor : Math.max(0.75, floor - 0.1);
}

function scoreTrigramReliability(
  queryProbes: Readonly<RecallQueryProbes>,
  context: LexicalFamilyContext
): number {
  const scriptSpecific = queryProbes.char_ngrams.length > 0 || queryProbes.lexical_terms.some((term) => term.length >= 12);
  const base = scriptSpecific ? 0.85 : 0.7;
  if (isRedundantLexicalFamily(context)) {
    return Math.max(0.55, base - 0.15);
  }
  return base;
}

function buildLexicalFamilyContext(
  candidate: FusionContributionCandidate,
  supplementaryData: RecallSupplementaryData
): LexicalFamilyContext {
  const objectId = candidate.entry.object_id;
  const evidenceHit = (supplementaryData.evidenceFtsRanks[objectId] ?? 0) > 0;
  const structuralHit = (candidate.structuralScore ?? supplementaryData.structuralScores[objectId] ?? 0) > 0;
  const lexicalFamilyHitCount = [
    supplementaryData.ftsRanks[objectId],
    supplementaryData.trigramFtsRanks[objectId],
    supplementaryData.evidenceFtsRanks[objectId],
    evidenceHit && structuralHit ? 1 : 0
  ].filter((score) => (score ?? 0) > 0).length;
  return Object.freeze({
    lexicalFamilyHitCount,
    orthogonalFieldCount: countOrthogonalLexicalFields(candidate, supplementaryData),
    hasIndependentSupport:
      (candidate.effectiveFactors.embedding_similarity ?? 0) > 0 ||
      (supplementaryData.sourceProximityScores[objectId] ?? 0) > 0 ||
      (supplementaryData.sourceCohortKeys[objectId]?.length ?? 0) > 0 ||
      (supplementaryData.graphExpansionScores[objectId] ?? 0) > 0 ||
      (supplementaryData.entitySeedScores[objectId] ?? 0) > 0 ||
      (supplementaryData.pathExpansionScores[objectId] ?? 0) > 0 ||
      (supplementaryData.graphSupportCounts[objectId] ?? 0) > 0
  });
}

function isLexicalFamilyStream(stream: RecallFusionStream): boolean {
  return (
    stream === "lexical_fts" ||
    stream === "trigram_fts" ||
    stream === "evidence_fts" ||
    stream === "evidence_structural_agreement"
  );
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : fallback;
}
