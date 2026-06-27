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
