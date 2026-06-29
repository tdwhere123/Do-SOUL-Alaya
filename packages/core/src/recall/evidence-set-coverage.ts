import type { RecallSupplementaryData } from "./recall-service-types.js";
import { type DeliveryCandidate, sessionKeyOf } from "./coverage-delivery-signals.js";
import { flatBaselineEnabled } from "./conformant-fusion-scoring.js";

// S4 delivery-time set-coverage (rank-then-cover): keys on set membership/complementarity, not magnitude
// — a flat nudge for a complementary member of an evidence-anchored session and for joining a selected
// answers_with cluster. Evidence is read as a boolean anchor flag (R_E not re-scored), never touches
// fused_score/fused_rank. Production default; ALAYA_RECALL_FLAT_BASELINE=on reverts to legacy coverage.

// Flat, set-membership nudges, each bounded below one strong facet (0.1) and summed under an overall
// cap, so coverage rescues a buried complementary gold without flipping a clearly-stronger answer.
const SESSION_COVERAGE_BONUS = 0.06;
const MAX_CLUSTER_BONUS = 0.06;
export const MAX_EVIDENCE_SET_BONUS = 0.1;

export interface EvidenceSetCoverageState {
  readonly clusterWeightMax: number;
  readonly anchorSessions: Set<string>;
  readonly selectedObjectIds: Set<string>;
  // seedObjectId -> strongest inflow weight among already-selected targets it floods.
  readonly selectedSeeds: Map<string, number>;
}

// Default-on; the flat-baseline kill-switch reverts to legacy facet/session coverage.
export function evidenceSetCoverageEnabled(): boolean {
  return !flatBaselineEnabled();
}

// Set-membership flag (boolean, never a magnitude): the candidate carries evidence support via the
// conformant evidence axis or the flat source-proximity / source-evidence-agreement streams. Used
// only to decide which sessions anchor; the session bonus is flat, so R_E is never re-scored here.
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
  if (state.anchorSessions.has(sessionKeyOf(candidate.entry))) {
    bonus += SESSION_COVERAGE_BONUS;
  }
  const clusterWeight = bestClusterWeight(state, candidate, supplementaryData);
  if (clusterWeight > 0 && state.clusterWeightMax > 0) {
    bonus += Math.min(MAX_CLUSTER_BONUS, (clusterWeight / state.clusterWeightMax) * MAX_CLUSTER_BONUS);
  }
  return Math.min(bonus, MAX_EVIDENCE_SET_BONUS);
}

// Strongest answers_with edge tying this candidate to the selected set: as a seed flooding a
// selected target, as a target flooded by a selected object, or via a shared seed.
function bestClusterWeight(
  state: EvidenceSetCoverageState,
  candidate: DeliveryCandidate,
  supplementaryData: RecallSupplementaryData
): number {
  const objectId = candidate.entry.object_id;
  let best = state.selectedSeeds.get(objectId) ?? 0;
  for (const edge of supplementaryData.pathInflowByTarget?.[objectId] ?? []) {
    if (state.selectedObjectIds.has(edge.seedObjectId) || state.selectedSeeds.has(edge.seedObjectId)) {
      best = Math.max(best, edge.weight);
    }
  }
  return best;
}
