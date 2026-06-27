import {
  applyEmbeddingPathModulation,
  scoreLaneReliability,
  type FusionContributionCandidate,
  type ResolvedRecallFusionWeights
} from "./fusion-delivery-adaptive-scoring.js";
import type { RecallFusionStream, RecallSupplementaryData } from "./recall-service-types.js";

// Opt-in (ALAYA_RECALL_FLOOD_FUSION): fuse normalized raw magnitudes instead of 1/(k+rank). Off → RRF rank path stays byte-identical.
export function floodFusionEnabled(): boolean {
  const raw = process.env.ALAYA_RECALL_FLOOD_FUSION;
  return raw === "on" || raw === "1" || raw === "true";
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
