import { recallEnvRaw } from "../../config/recall-env-access.js";
import type { RecallSupplementaryData } from "../runtime/recall-service-types.js";
import { type DeliveryCandidate, sessionKeyOf } from "./coverage-delivery-signals.js";

// Evidence-set completion nudge for same-session evidence members already
// anchored in the selected set.
const EVIDENCE_SET_COMPLETION_BONUS = 0.06;
export const MAX_EVIDENCE_SET_BONUS = 0.1;

export interface EvidenceSetCoverageState {
  readonly clusterWeightMax: number;
  readonly anchorSessions: Set<string>;
  readonly selectedObjectIds: Set<string>;
  readonly selectedSeeds: Map<string, number>;
}

export function evidenceSetCoverageEnabled(): boolean {
  const override = recallEnvRaw("ALAYA_RECALL_S4_COVERAGE");
  return override !== "0" && override !== "off" && override !== "false";
}

function isEvidenceMember(
  candidate: DeliveryCandidate,
  supplementaryData: RecallSupplementaryData
): boolean {
  const axisEvidence = candidate.fusion.per_axis_contribution?.evidence;
  if (axisEvidence !== undefined) {
    return axisEvidence > 0;
  }
  const contribution = candidate.fusion.fused_rank_contribution_per_stream;
  if ((contribution.source_proximity ?? 0) > 0 || (contribution.source_evidence_agreement ?? 0) > 0) {
    return true;
  }
  const rank = candidate.fusion.per_stream_rank;
  if (rank.source_proximity !== null || rank.source_evidence_agreement !== null) {
    return true;
  }
  return (supplementaryData.sourceProximityScores[candidate.entry.object_id] ?? 0) > 0;
}

export function createEvidenceSetCoverageState<T extends DeliveryCandidate>(
  pool: readonly T[],
  supplementaryData: RecallSupplementaryData
): EvidenceSetCoverageState {
  let clusterWeightMax = 0;
  const inflow = supplementaryData.pathInflowByTarget;
  if (inflow !== undefined) {
    for (const candidate of pool) {
      for (const edge of inflow[candidate.entry.object_id] ?? []) {
        clusterWeightMax = Math.max(clusterWeightMax, edge.weight);
      }
    }
  }
  return {
    clusterWeightMax,
    anchorSessions: new Set<string>(),
    selectedObjectIds: new Set<string>(),
    selectedSeeds: new Map<string, number>()
  };
}

export function recordEvidenceSetSelection(
  state: EvidenceSetCoverageState,
  candidate: DeliveryCandidate,
  supplementaryData: RecallSupplementaryData
): void {
  state.selectedObjectIds.add(candidate.entry.object_id);
  if (isEvidenceMember(candidate, supplementaryData)) {
    state.anchorSessions.add(sessionKeyOf(candidate.entry));
  }
  for (const edge of supplementaryData.pathInflowByTarget?.[candidate.entry.object_id] ?? []) {
    if (edge.weight > (state.selectedSeeds.get(edge.seedObjectId) ?? 0)) {
      state.selectedSeeds.set(edge.seedObjectId, edge.weight);
    }
  }
}

export function evidenceSetCoverageBonus(
  state: EvidenceSetCoverageState,
  candidate: DeliveryCandidate,
  supplementaryData: RecallSupplementaryData
): number {
  let bonus = 0;
  if (state.anchorSessions.has(sessionKeyOf(candidate.entry)) && isEvidenceMember(candidate, supplementaryData)) {
    bonus += EVIDENCE_SET_COMPLETION_BONUS;
  }
  // answers_with flood is always on: path π already votes via A_path (and was
  // deduped out of path_expansion RRF). Re-applying cluster weight here would
  // be a third count of the same edge — withhold permanently.
  return Math.min(bonus, MAX_EVIDENCE_SET_BONUS);
}
