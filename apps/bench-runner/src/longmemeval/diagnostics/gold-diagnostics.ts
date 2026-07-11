import { classifyGoldMissTaxonomy } from "../diagnostics-miss-taxonomy.js";
import type {
  CandidateDiagnostic,
  LongMemEvalGoldDiagnostic,
  NarrowRecallDiagnostics
} from "../diagnostics-types.js";
import { buildObjectIdentityKey } from "../diagnostics-private.js";

interface GoldDiagnosticInput {
  readonly goldMemoryIds: readonly string[];
  readonly deliveredRankById: ReadonlyMap<string, number>;
  readonly activeConstraintRankById: ReadonlyMap<string, number>;
  readonly diagnostics: NarrowRecallDiagnostics | null;
}

export function buildGoldDiagnostics(
  input: GoldDiagnosticInput
): LongMemEvalGoldDiagnostic[] {
  return input.goldMemoryIds.map((objectId) => buildGoldDiagnostic(objectId, input));
}

function buildGoldDiagnostic(
  objectId: string,
  input: GoldDiagnosticInput
): LongMemEvalGoldDiagnostic {
  const deliveredRank = input.deliveredRankById.get(objectId) ?? null;
  const activeConstraintRank = input.activeConstraintRankById.get(objectId) ?? null;
  const candidate = input.diagnostics?.candidatesByObjectIdentity.get(
    buildObjectIdentityKey("memory_entry", objectId)
  );
  const anyObjectCandidate = input.diagnostics?.candidatesByObjectId.get(objectId);
  return {
    object_id: objectId,
    candidate_status: resolveCandidateStatus(
      deliveredRank, activeConstraintRank, candidate, input.diagnostics !== null
    ),
    ...buildGoldRankingFields(candidate, deliveredRank, activeConstraintRank),
    ...buildGoldPlaneFields(candidate),
    miss_taxonomy: classifyGoldMissTaxonomy({
      deliveredRank,
      candidate,
      anyObjectCandidate,
      diagnosticsAvailable: input.diagnostics !== null
    }),
    ...buildGoldDeliveryFields(candidate)
  };
}

function resolveCandidateStatus(
  deliveredRank: number | null,
  activeConstraintRank: number | null,
  candidate: CandidateDiagnostic | undefined,
  diagnosticsAvailable: boolean
): LongMemEvalGoldDiagnostic["candidate_status"] {
  if (deliveredRank !== null) return "delivered";
  if (activeConstraintRank !== null) return "active_constraint_delivered";
  if (candidate !== undefined) return "candidate_not_delivered";
  return diagnosticsAvailable ? "candidate_absent" : "unknown";
}

function buildGoldRankingFields(
  candidate: CandidateDiagnostic | undefined,
  deliveredRank: number | null,
  activeConstraintRank: number | null
) {
  return {
    dimension: candidate?.dimension ?? null,
    final_rank: deliveredRank,
    active_constraint_rank: activeConstraintRank,
    pre_budget_rank: candidate?.preBudgetRank ?? null,
    selection_order: candidate?.selectionOrder ?? null,
    fused_rank: candidate?.fusedRank ?? null,
    fused_score: candidate?.fusedScore ?? null,
    per_stream_rank: candidate?.perStreamRank ?? null,
    fused_rank_contribution_per_stream: candidate?.fusedRankContributionPerStream ?? null,
    per_axis_rank: candidate?.perAxisRank ?? null,
    per_axis_contribution: candidate?.perAxisContribution ?? null,
    flood_potential: candidate?.floodPotential ?? null,
    flood_fuel_coverage: candidate?.floodFuelCoverage ?? null
  };
}

function buildGoldPlaneFields(candidate: CandidateDiagnostic | undefined) {
  return {
    plane_first_admitted: candidate?.planeFirstAdmitted ?? null,
    plane_winning_admission: candidate?.planeWinningAdmission ?? null,
    source_planes: candidate?.sourcePlanes ?? []
  };
}

function buildGoldDeliveryFields(candidate: CandidateDiagnostic | undefined) {
  return {
    lexical_rank: candidate?.lexicalRank ?? null,
    structural_score: candidate?.structuralScore ?? null,
    score_factors: candidate?.scoreFactors ?? null,
    source_channels: candidate?.sourceChannels ?? [],
    budget_drop_reason: candidate?.budgetDropReason ?? null,
    rank_after_fusion: candidate?.rankAfterFusion ?? null,
    rank_after_feature_rerank: candidate?.rankAfterFeatureRerank ?? null,
    rank_after_lexical_priority: candidate?.rankAfterLexicalPriority ?? null,
    rank_after_synthesis_reserve: candidate?.rankAfterSynthesisReserve ?? null,
    rank_after_structural_reserve: candidate?.rankAfterStructuralReserve ?? null,
    rank_after_coverage_selector: candidate?.rankAfterCoverageSelector ?? null,
    rank_after_session_coverage: candidate?.rankAfterSessionCoverage ?? null,
    coverage_selector_action: candidate?.coverageSelectorAction ?? null,
    session_coverage_action: candidate?.sessionCoverageAction ?? null,
    session_key: candidate?.sessionKey ?? null,
    source_cohort_key: candidate?.sourceCohortKey ?? null,
    reserved_by: candidate?.reservedBy ?? null
  };
}
