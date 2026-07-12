import type {
  MemoryEntry,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import type {
  CoarseRecallCandidate,
  RecallConformantAxis,
  RecallFusionBreakdown,
  RecallFusionStreamContributions,
  RecallFusionStreamRanks,
  IntegratedFloodCandidateDiagnostics
} from "../runtime/recall-service-types.js";

export type RecallFusionCandidateInput = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
}>;
export type FusedRecallCandidateInput = Readonly<RecallFusionCandidateInput & {
  readonly fusion: RecallFusionBreakdown;
}>;

export type KeyedRecallFusionCandidate = Readonly<{
  readonly candidateKey: string;
  readonly candidate: RecallFusionCandidateInput;
}>;

export type RecallFusionCandidateStreamSnapshot = Readonly<{
  readonly candidateKey: string;
  readonly candidate: RecallFusionCandidateInput;
  readonly perStreamRank: RecallFusionStreamRanks;
  readonly contributions: RecallFusionStreamContributions;
  readonly objectBase: number;
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
  // invariant: conformant axis fields are diagnostics; fusedScore owns ordering.
  readonly axisRank?: Readonly<Record<RecallConformantAxis, number | null>>;
  readonly axisRa?: Readonly<Record<RecallConformantAxis, number>>;
  readonly floodPotential?: IntegratedFloodCandidateDiagnostics;
}>;
