import type {
  MemoryEntry,
  RecallPolicy,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import type {
  CoarseRecallCandidate,
  RecallConformantAxis,
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks,
  RecallSupplementaryData
} from "./recall-service-types.js";

export type RecallFusionCandidateInput = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
}>;
export type FusedRecallCandidateInput = Readonly<RecallFusionCandidateInput & {
  readonly fusion: RecallFusionBreakdown;
}>;

export type PreliminaryFusionCandidate = Readonly<{
  readonly candidateKey: string;
  readonly objectId: string;
  readonly objectKind: RecallFusionBreakdown["object_kind"];
  readonly originPlane: RecallFusionBreakdown["origin_plane"];
  readonly entry: Readonly<MemoryEntry>;
  readonly effectiveScore: number;
  readonly perStreamRank: RecallFusionStreamRanks;
  readonly contributions: RecallFusionStreamContributions;
  readonly fusedScore: number;
  readonly facetOverlapCount: number;
  // invariant: conformant ordering uses axis rank and the collapsed R_a tie-break vector.
  readonly axisRank?: Readonly<Record<RecallConformantAxis, number | null>>;
  readonly axisRa?: Readonly<Record<RecallConformantAxis, number>>;
}>;
