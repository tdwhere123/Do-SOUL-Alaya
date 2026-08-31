import type { ManifestationState, MemoryEntry } from "@do-soul/alaya-protocol";
import { clampManifestationByGovernance } from "../../relations/path-relations/path-manifestation-policy.js";
import { clamp01 } from "../runtime/recall-service-helpers.js";
import { RECALL_FLOOD_EDGE_REASONS } from
  "../runtime/recall-service-types.js";
import type {
  FloodAxisInactiveReason,
  FloodFuelCoverageSummary,
  IntegratedFloodCandidateDiagnostics,
  RecallFloodEdgeTraceV1,
  RecallPathInflowAvailability,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import { resolveConformantPathWeight } from "./conformant-fusion-scoring.js";
import { resolveSliceAxis } from "./flood-slice-axis.js";

export type {
  FloodAxisInactiveReason,
  FloodFuelCoverageSummary,
  IntegratedFloodCandidateDiagnostics
} from "../runtime/recall-service-types.js";

export interface IntegratedFloodAxisInputs {
  readonly R_obj: number;
  readonly A_path: number;
  readonly B_evidence: number;
}

interface ResolvedFloodValueAxis {
  readonly value: number;
  readonly status: FloodAxisInactiveReason;
}

interface ResolvedFloodFuelAxis extends ResolvedFloodValueAxis {
  readonly countsAsFuel: boolean;
}

function manifestationOmega(
  entry: Readonly<MemoryEntry>,
  governanceCeiling: ManifestationState | undefined
): number {
  const effective = clampManifestationByGovernance(
    entry.manifestation_state ?? "full_eligible",
    governanceCeiling ?? "full_eligible"
  );
  switch (effective) {
    case "full_eligible":
      return 1;
    case "excerpt":
      return 0.75;
    case "hint":
      return 0.35;
    case "hidden":
      return 0.05;
    default:
      return 0.5;
  }
}

function resolvePathAxis(
  rawPath: number,
  hasInflow: boolean,
  availability: RecallPathInflowAvailability | undefined,
  eligible: boolean
): ResolvedFloodFuelAxis {
  if (!eligible) {
    // Capsules are outside the path-transfer population.
    return { value: 1, status: "inactive:not_applicable", countsAsFuel: false };
  }
  if (availability === "unavailable") {
    return { value: 0, status: "inactive:index_unavailable", countsAsFuel: false };
  }
  if (availability === "storage_error") {
    return { value: 0, status: "inactive:storage_error", countsAsFuel: false };
  }
  if (!hasInflow) {
    return { value: 1, status: "inactive:pass_through", countsAsFuel: false };
  }
  const value = clamp01(rawPath);
  if (value <= 0) {
    return { value: 0, status: "inactive:no_fuel", countsAsFuel: false };
  }
  return { value, status: "active", countsAsFuel: true };
}

function resolveEvidenceAxis(rawEvidence: number, hasEvidenceVectors: boolean): ResolvedFloodFuelAxis {
  if (!hasEvidenceVectors) {
    return { value: 1, status: "inactive:pass_through", countsAsFuel: false };
  }
  const value = clamp01(rawEvidence);
  if (value <= 0) {
    return { value: 0, status: "inactive:no_evidence", countsAsFuel: false };
  }
  return { value, status: "active", countsAsFuel: true };
}

function hasEvidenceVectors(
  objectId: string,
  supplementaryData: RecallSupplementaryData
): boolean {
  const vector = supplementaryData.evidenceSupportVectorsByMemoryId?.[objectId];
  return vector !== undefined && vector.length > 0;
}

function hasPathInflow(
  objectId: string,
  supplementaryData: RecallSupplementaryData
): boolean {
  const inflow = supplementaryData.pathInflowByTarget?.[objectId];
  return inflow !== undefined && inflow.length > 0;
}

function verifiedFloodFuel(
  slice: ResolvedFloodFuelAxis,
  path: ResolvedFloodFuelAxis,
  evidence: ResolvedFloodFuelAxis
): boolean {
  return slice.countsAsFuel && slice.value > 0 && path.countsAsFuel && evidence.countsAsFuel;
}

/**
 * invariant: structural/flood prior must not overturn high object likelihood.
 * g(L)=1−R_obj closes the flood bonus as R_obj → 1 (Π_eff shrinks toward identity).
 */
export function structuralLikelihoodGate(R_obj: number): number {
  return clamp01(1 - clamp01(R_obj));
}

type IntegratedFloodScoreParams = Readonly<{
  readonly entry: Readonly<MemoryEntry>;
  readonly memorySupplementEligible?: boolean;
  readonly axisInputs: IntegratedFloodAxisInputs;
  readonly supplementaryData: RecallSupplementaryData;
  readonly pathWeight?: number;
}>;

interface ResolvedIntegratedFloodScore {
  readonly lambda: number;
  readonly beta: number;
  readonly slice: ResolvedFloodFuelAxis;
  readonly path: ResolvedFloodFuelAxis;
  readonly evidence: ResolvedFloodFuelAxis;
  readonly fuelVerified: boolean;
  readonly flood: number;
  readonly omega: number;
  readonly eDirect: number;
  readonly eDirectStatus: FloodAxisInactiveReason;
  readonly base: number;
  readonly lGate: number;
}

// Identity residual scale: an env beta was a forever-off multiplier.
const EVIDENCE_RESIDUAL_SCALE = 1;

function resolveIntegratedFloodScore(
  params: IntegratedFloodScoreParams
): ResolvedIntegratedFloodScore {
  const lambda = params.pathWeight ?? resolveConformantPathWeight();
  const beta = EVIDENCE_RESIDUAL_SCALE;
  const memorySupplementEligible = params.memorySupplementEligible ?? true;
  const slice = resolveSliceAxis(params.entry, params.supplementaryData);
  const path = resolvePathAxis(
    params.axisInputs.A_path,
    hasPathInflow(params.entry.object_id, params.supplementaryData),
    params.supplementaryData.pathInflowAvailability,
    memorySupplementEligible
  );
  const evidence = resolveEvidenceAxis(
    params.axisInputs.B_evidence,
    memorySupplementEligible &&
      hasEvidenceVectors(params.entry.object_id, params.supplementaryData)
  );
  const fuelVerified = verifiedFloodFuel(slice, path, evidence);
  const flood = fuelVerified ? slice.value * path.value * evidence.value : 0;
  const omega = manifestationOmega(
    params.entry,
    memorySupplementEligible
      ? params.supplementaryData.governanceCeilingByMemoryId[params.entry.object_id]
      : undefined
  );
  const eDirect = clamp01(params.axisInputs.B_evidence);
  const eDirectStatus: FloodAxisInactiveReason =
    eDirect > 0 ? "active" : "inactive:no_evidence";
  const base = clamp01(params.axisInputs.R_obj);
  const lGate = structuralLikelihoodGate(base);
  return {
    lambda, beta, slice, path, evidence, fuelVerified, flood, omega,
    eDirect, eDirectStatus, base, lGate
  };
}

function computeFinalFloodScore(resolved: ResolvedIntegratedFloodScore): number {
  // Ranking scalar is family-max R_obj. Path/evidence residuals stay diagnostic;
  // adding them at object-score scale inverted higher-R_obj candidates.
  return clamp01(resolved.base);
}

function buildIntegratedFloodDiagnostics(
  resolved: ResolvedIntegratedFloodScore,
  score: number
): IntegratedFloodCandidateDiagnostics {
  return Object.freeze({
    R_obj: resolved.base,
    Slice: resolved.slice.value,
    A_path: resolved.path.value,
    B_evidence: resolved.evidence.value,
    E_direct: resolved.eDirect,
    omega: resolved.omega,
    Flood: resolved.flood,
    lambda: resolved.lambda,
    beta: resolved.beta,
    final_score: score,
    slice_status: resolved.slice.status,
    path_status: resolved.path.status,
    evidence_status: resolved.evidence.status,
    e_direct_status: resolved.eDirectStatus,
    fuel_verified: resolved.fuelVerified
  });
}

export function computeIntegratedFloodScore(
  params: IntegratedFloodScoreParams
): Readonly<{ readonly score: number; readonly diagnostics: IntegratedFloodCandidateDiagnostics }> {
  const resolved = resolveIntegratedFloodScore(params);
  const score = computeFinalFloodScore(resolved);
  return Object.freeze({
    score,
    diagnostics: buildIntegratedFloodDiagnostics(resolved, score)
  });
}

export function buildFloodFuelCoverageSummary(
  diagnostics: readonly IntegratedFloodCandidateDiagnostics[]
): FloodFuelCoverageSummary {
  let coldStartCount = 0;
  let fuelVerifiedCount = 0;
  let sliceActiveCount = 0;
  let pathActiveCount = 0;
  let evidenceActiveCount = 0;
  for (const row of diagnostics) {
    if (!row.fuel_verified) {
      coldStartCount += 1;
    } else {
      fuelVerifiedCount += 1;
    }
    if (row.slice_status === "active") {
      sliceActiveCount += 1;
    }
    if (row.path_status === "active") {
      pathActiveCount += 1;
    }
    if (row.evidence_status === "active") {
      evidenceActiveCount += 1;
    }
  }
  return Object.freeze({
    candidates_total: diagnostics.length,
    cold_start_count: coldStartCount,
    fuel_verified_count: fuelVerifiedCount,
    slice_active_count: sliceActiveCount,
    path_active_count: pathActiveCount,
    evidence_active_count: evidenceActiveCount,
    ...buildH1CoverageSummary(diagnostics)
  });
}

function buildH1CoverageSummary(
  diagnostics: readonly IntegratedFloodCandidateDiagnostics[]
): Pick<
  FloodFuelCoverageSummary,
  "h1_candidate_count" | "h1_transferable_count" |
  "h1_edge_winner_count" | "h1_direct_winner_count" |
  "h1_overlay_applied_count" |
  "h1_evaluated_edge_count" | "h1_seed_overlap_edge_count" |
  "h1_transferred_edge_count" | "h1_rejected_edge_count" |
  "h1_newly_admitted_frontier_target_count" | "h1_reason_counts"
> {
  const h1Rows = diagnostics.flatMap((row) =>
    row.h1_max_product === undefined ? [] : [row.h1_max_product]);
  const reasonCounts = emptyH1ReasonCounts();
  for (const row of h1Rows) {
    for (const reason of RECALL_FLOOD_EDGE_REASONS) {
      reasonCounts[reason] += row.transition_counts.reason_counts[reason];
    }
  }
  const edgeWinners = h1Rows.filter((row) => row.winner === "edge").length;
  return Object.freeze({
    h1_candidate_count: h1Rows.length,
    h1_transferable_count: h1Rows.filter(
      (row) => row.strongest_transfer > 0
    ).length,
    h1_edge_winner_count: edgeWinners,
    h1_direct_winner_count: h1Rows.length - edgeWinners,
    h1_overlay_applied_count: diagnostics.filter(
      (row) => row.h1_overlay?.applied === true
    ).length,
    h1_evaluated_edge_count: sumTransitions(h1Rows, "evaluated_edge_count"),
    h1_seed_overlap_edge_count: sumTransitions(h1Rows, "seed_overlap_edge_count"),
    h1_transferred_edge_count: sumTransitions(h1Rows, "transferred_edge_count"),
    h1_rejected_edge_count: sumTransitions(h1Rows, "rejected_edge_count"),
    h1_newly_admitted_frontier_target_count: h1Rows.filter(
      (row) => row.frontier_admitted
    ).length,
    h1_reason_counts: Object.freeze(reasonCounts)
  });
}

function emptyH1ReasonCounts(): Record<
  RecallFloodEdgeTraceV1["reason"],
  number
> {
  return Object.fromEntries(
    RECALL_FLOOD_EDGE_REASONS.map((reason) => [reason, 0])
  ) as Record<RecallFloodEdgeTraceV1["reason"], number>;
}

function sumTransitions(
  rows: readonly NonNullable<
    IntegratedFloodCandidateDiagnostics["h1_max_product"]
  >[],
  key: "evaluated_edge_count" | "seed_overlap_edge_count" |
    "transferred_edge_count" | "rejected_edge_count"
): number {
  return rows.reduce((sum, row) => sum + row.transition_counts[key], 0);
}
