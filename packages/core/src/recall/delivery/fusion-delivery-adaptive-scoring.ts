import type { MemoryEntry, RecallPolicy, RecallScoreFactors } from "@do-soul/alaya-protocol";
import { classifyRecallIntent, hasTemporalQuerySignal } from "../query/recall-query-plan.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import { clamp01 } from "../runtime/recall-service-helpers.js";
import { recallEnvRaw } from "../../config/recall-env-access.js";
import type { RecallFusionStream, RecallSupplementaryData } from "../runtime/recall-service-types.js";
import { resolveDefaultFusionWeightForIntent } from "../scoring/temporal-fusion-scoring.js";
import type { ConflictGateContext } from "./fusion-delivery-conflict-gate.js";

const EMBEDDING_PATH_MODULATION_GAIN = 0.25;
const RECALL_RRF_DEFAULT_K = 60;

export type { ConflictGateContext } from "./fusion-delivery-conflict-gate.js";
export {
  buildConflictGateContext,
  CONFLICT_FUSION_STREAMS,
  isConflictFusionStream,
  selectWouldOutrankSuppressedKeys,
  shouldSuppressConflictStreamContribution,
  zeroConflictStreamContributions
} from "./fusion-delivery-conflict-gate.js";

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
  readonly candidateKey?: string;
  readonly conflictGate?: ConflictGateContext;
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
  // Conflict would-outrank suppression is applied after all raw lane contributions are known
  // (fusion-delivery-scoring-snapshot), so this path only builds the unsuppressed RRF term.
  const k = params.resolved.kByStream[params.stream];
  const base = params.resolved.weights[params.stream] / (k + params.rank);
  return applyEmbeddingPathModulation(
    base,
    params.candidate,
    params.supplementaryData,
    params.stream,
    params.conflictGate
  );
}

// Same embedding cosine modulation the RRF path applies; shared so flood mode does not duplicate it.
// Diagnostic switch (ALAYA_RECALL_PATH_EMB_MODULATION=off) for the raw-cosine path/graph boost.
// Default (unset) keeps the raw modulation = byte-identical.
function pathEmbModulationEnabled(): boolean {
  const raw = recallEnvRaw("ALAYA_RECALL_PATH_EMB_MODULATION");
  return raw !== "off" && raw !== "0" && raw !== "false";
}

export function applyEmbeddingPathModulation(
  contribution: number,
  candidate: FusionContributionCandidate,
  supplementaryData: RecallSupplementaryData,
  stream: RecallFusionStream,
  conflictGate?: ConflictGateContext
): number {
  if ((stream !== "path_expansion" && stream !== "graph_expansion") || !pathEmbModulationEnabled()) {
    return contribution;
  }
  // When emb is decisive, path×cosine boost would amplify the same conflict lanes that bury emb-top.
  if (conflictGate?.poolEmbeddingDecisive === true) {
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
  if (stream === "temporal_recency" && hasTemporalQuerySignal(queryProbes, intent)) return 40;
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

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : fallback;
}
