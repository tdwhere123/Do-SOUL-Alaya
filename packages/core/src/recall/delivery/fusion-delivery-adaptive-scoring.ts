import type { RecallPolicy, RecallScoreFactors } from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import { clamp01 } from "../runtime/recall-service-helpers.js";
import { recallEnvRaw } from "../../config/recall-env-access.js";
import type {
  CoarseRecallCandidate,
  RecallFusionStream,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import { resolveDefaultFusionWeightForIntent } from "../scoring/temporal-fusion-scoring.js";

const EMBEDDING_PATH_MODULATION_GAIN = 0.25;
const RECALL_RRF_DEFAULT_K = 60;

export type ResolvedRecallFusionWeights = Readonly<{
  readonly kByStream: Readonly<Record<RecallFusionStream, number>>;
  readonly weights: Readonly<Record<RecallFusionStream, number>>;
}>;

export type FusionContributionCandidate = Readonly<Pick<
  CoarseRecallCandidate,
  "entry" | "originPlane" | "objectKind" | "structuralScore"
> & {
  readonly effectiveFactors: Readonly<RecallScoreFactors>;
}>;

type FusionContributionParams = Readonly<{
  readonly candidate: FusionContributionCandidate;
  readonly supplementaryData: RecallSupplementaryData;
  readonly resolved: ResolvedRecallFusionWeights;
  readonly stream: RecallFusionStream;
  readonly rank: number;
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
      readPositiveInteger(overrides[`${stream}_rrf_k`], fallbackK)
    ])
  ) as Record<RecallFusionStream, number>;
  return Object.freeze({
    kByStream: Object.freeze(kByStream),
    weights: Object.freeze(weights)
  });
}

export function resolveFusionContribution(params: FusionContributionParams): number {
  const k = params.resolved.kByStream[params.stream];
  const base = params.resolved.weights[params.stream] / (k + params.rank);
  return applyEmbeddingPathModulation(
    base,
    params.candidate,
    params.supplementaryData,
    params.stream
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
  stream: RecallFusionStream
): number {
  if ((stream !== "path_expansion" && stream !== "graph_expansion") || !pathEmbModulationEnabled()) {
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

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : fallback;
}
