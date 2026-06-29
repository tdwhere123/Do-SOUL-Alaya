import type { RecallSupplementaryData } from "./recall-service-types.js";
import { type DeliveryCandidate, sessionKeyOf } from "./coverage-delivery-signals.js";

// S4 delivery-time set-coverage: the evidence axis (R_E, AUC ~0.95) is a coverage signal, not a
// point-wise rank term. Here it nudges complementary golds into the delivery window via two bounded
// utilities layered on facet diversity — never touching fused_score/fused_rank. Default-off so the
// off path stays byte-identical to facet-only coverage; only on when ALAYA_RECALL_EVIDENCE_SET_COVERAGE set.

export const EVIDENCE_SET_COVERAGE_ENV = "ALAYA_RECALL_EVIDENCE_SET_COVERAGE";

// Near-tie nudges, each bounded below one strong facet (0.12) and summed under an overall cap, so
// coverage rescues a buried complementary gold without flipping a clearly-stronger answer.
const MAX_SESSION_BONUS = 0.06;
const MAX_CLUSTER_BONUS = 0.06;
const MAX_EVIDENCE_SET_BONUS = 0.1;
// A selected candidate anchors its session for R_E propagation only if its evidence magnitude is
// strong relative to the pool — keeps weak head-session distractors from anchoring.
const ANCHOR_EVIDENCE_RATIO = 0.5;

export interface EvidenceSetCoverageState {
  readonly evidenceMax: number;
  readonly clusterWeightMax: number;
  readonly anchorSessions: Set<string>;
  readonly selectedObjectIds: Set<string>;
  // seedObjectId -> strongest inflow weight among already-selected targets it floods.
  readonly selectedSeeds: Map<string, number>;
}

export function evidenceSetCoverageEnabled(): boolean {
  const raw = process.env[EVIDENCE_SET_COVERAGE_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === "" || normalized === "0" || normalized === "false" || normalized === "off");
}

// R_E proxy, one function for both services: conformant reads the evidence axis directly; flat
// degrades to the source-proximity / source-evidence-agreement contributions, then the raw score.
export function candidateEvidenceMagnitude(
  candidate: DeliveryCandidate,
  supplementaryData: RecallSupplementaryData
): number {
  const axisEvidence = candidate.fusion.per_axis_contribution?.evidence;
  if (axisEvidence !== undefined) {
    return Math.max(0, axisEvidence);
  }
  const contribution = candidate.fusion.fused_rank_contribution_per_stream;
  const streamSum =
    Math.max(0, contribution.source_proximity ?? 0) + Math.max(0, contribution.source_evidence_agreement ?? 0);
  if (streamSum > 0) {
    return streamSum;
  }
  return Math.max(0, supplementaryData.sourceProximityScores[candidate.entry.object_id] ?? 0);
}

export function createEvidenceSetCoverageState<T extends DeliveryCandidate>(
  pool: readonly T[],
  supplementaryData: RecallSupplementaryData
): EvidenceSetCoverageState {
  let evidenceMax = 0;
  for (const candidate of pool) {
    evidenceMax = Math.max(evidenceMax, candidateEvidenceMagnitude(candidate, supplementaryData));
  }
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
    evidenceMax,
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
  if (state.evidenceMax > 0) {
    const magnitude = candidateEvidenceMagnitude(candidate, supplementaryData);
    if (magnitude >= ANCHOR_EVIDENCE_RATIO * state.evidenceMax) {
      state.anchorSessions.add(sessionKeyOf(candidate.entry));
    }
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
  if (state.evidenceMax > 0 && state.anchorSessions.has(sessionKeyOf(candidate.entry))) {
    const magnitude = candidateEvidenceMagnitude(candidate, supplementaryData);
    bonus += Math.min(MAX_SESSION_BONUS, (magnitude / state.evidenceMax) * MAX_SESSION_BONUS);
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
