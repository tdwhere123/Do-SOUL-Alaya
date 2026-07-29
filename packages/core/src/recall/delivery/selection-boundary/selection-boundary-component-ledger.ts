import type { FineAssessmentCandidate } from "../fine-assessment-selection.js";
import {
  aggregateFamilyContributions,
  familyMaxContributionsById
} from "../fusion-delivery-families.js";
import { resolveFineAssessmentDeepHead } from
  "../fine-assessment-deep-head.js";
import { isWorkspaceMemoryCandidate } from
  "../../runtime/recall-service-helpers.js";
import type {
  RecallDeepHeadTrace
} from "../../rerank/deep-head.js";
import type {
  IntegratedFloodCandidateDiagnostics,
  RecallFusionStreamContributions,
  RecallSupplementaryData
} from "../../runtime/recall-service-types.js";
import {
  restoreSupplementaryData,
  validateSelectionBoundary
} from "./selection-boundary-restore.js";
import type {
  FineAssessmentSelectionBoundaryCase,
  FineAssessmentSelectionBoundaryInput,
  SelectionBoundaryNumberMap
} from "./selection-boundary-types.js";
import {
  isObservedSource,
  observeNumericSource
} from "./selection-boundary-component-ledger-sources.js";
import type {
  ComponentLedgerCandidate,
  ComponentLedgerDuplicateEvidence,
  ComponentLedgerFloodTerms,
  ComponentLedgerFusionSlice,
  ComponentLedgerSelectionInputs,
  ComponentSourceObservation,
  FineAssessmentComponentLedger,
  SelectedEmbeddingSource
} from "./selection-boundary-component-ledger-types.js";

const LEDGER_UNITS = Object.freeze({
  fused_score: "flood_integrated_final",
  rrf_family_contribution: "rrf_rank_ballot",
  agreements: "unit_interval",
  embedding_signal: "unit_interval_or_null",
  flood_terms: "flood_diagnostics_scalars"
} as const);

/**
 * Observational component ledger from a captured selection boundary.
 * Does not alter selection; identities and numbers only.
 */
export function buildFineAssessmentComponentLedger(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentComponentLedger {
  validateSelectionBoundary(boundary);
  const input = boundary.input;
  const candidates = input.ordered_candidates;
  const supplementaryData = restoreSupplementaryData(input.supplementary_data);
  const answerRelevanceScores =
    supplementaryData.answerRelevanceScoresByCandidateKey ?? new Map();
  const deepHead = resolveFineAssessmentDeepHead({
    candidates,
    answerRelevanceScores,
    supplementaryData,
    captureAnswerFeatures: input.capture_answer_features
  });
  const selectionLookups = buildSelectionLookups(input);
  return Object.freeze({
    schema_version: 1,
    units: LEDGER_UNITS,
    candidates: Object.freeze(candidates.map((candidate) =>
      buildCandidateLedger(
        candidate,
        supplementaryData,
        deepHead.traceByCandidateKey.get(candidate.fusion.candidate_key) ?? null,
        deepHead.scores.get(candidate.fusion.candidate_key) ?? null,
        selectionLookups
      )
    ))
  });
}

function buildCandidateLedger(
  candidate: FineAssessmentCandidate,
  supplementaryData: RecallSupplementaryData,
  trace: RecallDeepHeadTrace | null,
  coverageRelevance: number | null,
  selectionLookups: SelectionLookups
): ComponentLedgerCandidate {
  const eligible = isWorkspaceMemoryCandidate(candidate);
  const objectId = candidate.entry.object_id;
  const candidateKey = candidate.fusion.candidate_key;
  const sources = buildSources(candidate, supplementaryData, eligible, objectId);
  const selectedEmbedding = selectEmbeddingSource(sources, eligible);
  const fusion = buildFusionSlice(candidate);
  const flood = buildFloodTerms(candidate.fusion.flood_potential);
  return Object.freeze({
    candidate_key: candidateKey,
    object_id: objectId,
    sources,
    selected_embedding: selectedEmbedding,
    fusion,
    flood,
    evidence_agreement: trace?.evidence_agreement ?? 0,
    lexical_agreement: trace?.lexical_agreement ?? 0,
    resolved_evidence: trace?.resolved_evidence ?? 0,
    deep_head: Object.freeze({
      embedding_signal: trace?.embedding_signal ?? null,
      fusion_baseline_used: trace?.fusion_baseline_used ?? false,
      resolved_score: trace?.resolved_score ?? null,
      score_source: trace?.score_source ?? "inactive",
      trace
    }),
    selection_inputs: selectionInputsFor(
      candidateKey,
      coverageRelevance,
      selectionLookups
    ),
    duplicate_evidence: buildDuplicateEvidence(
      fusion,
      sources,
      selectedEmbedding.observation
    )
  });
}

function buildSources(
  candidate: FineAssessmentCandidate,
  supplementaryData: RecallSupplementaryData,
  eligible: boolean,
  objectId: string
): ComponentLedgerCandidate["sources"] {
  return Object.freeze({
    embedding_evidence_semantic: observeNumericSource(
      true,
      supplementaryData.evidenceSemanticScoresByCandidateKey?.get(
        candidate.fusion.candidate_key
      )
    ),
    embedding_effective_factor: observeNumericSource(
      true,
      candidate.effectiveFactors.embedding_similarity
    ),
    embedding_object_similarity: observeNumericSource(
      eligible,
      supplementaryData.embeddingSimilarityScores[objectId]
    ),
    evidence_fts: observeNumericSource(
      eligible,
      supplementaryData.evidenceFtsRanks[objectId]
    ),
    structural_candidate: observeNumericSource(
      true,
      candidate.structuralScore
    ),
    structural_supplementary: observeNumericSource(
      eligible,
      supplementaryData.structuralScores[objectId]
    ),
    source_proximity: observeNumericSource(
      eligible,
      supplementaryData.sourceProximityScores[objectId]
    ),
    lexical_fts: observeNumericSource(
      eligible,
      supplementaryData.ftsRanks[objectId]
    ),
    trigram_fts: observeNumericSource(
      eligible,
      supplementaryData.trigramFtsRanks[objectId]
    )
  });
}

function selectEmbeddingSource(
  sources: ComponentLedgerCandidate["sources"],
  eligible: boolean
): ComponentLedgerCandidate["selected_embedding"] {
  if (isObservedSource(sources.embedding_evidence_semantic)) {
    return freezeSelected("evidence_semantic", sources.embedding_evidence_semantic);
  }
  if (isObservedSource(sources.embedding_effective_factor)) {
    return freezeSelected("effective_factor", sources.embedding_effective_factor);
  }
  if (eligible && isObservedSource(sources.embedding_object_similarity)) {
    return freezeSelected(
      "object_embedding",
      sources.embedding_object_similarity
    );
  }
  return freezeSelected("none", unresolvedEmbeddingObservation(sources, eligible));
}

function unresolvedEmbeddingObservation(
  sources: ComponentLedgerCandidate["sources"],
  eligible: boolean
): ComponentSourceObservation {
  for (const observation of [
    sources.embedding_evidence_semantic,
    sources.embedding_effective_factor,
    sources.embedding_object_similarity
  ]) {
    if (observation.state === "invalid") return observation;
  }
  if (!eligible) {
    return Object.freeze({
      state: "ineligible" as const,
      raw: null,
      unit_interval: null
    });
  }
  return sources.embedding_object_similarity;
}

function freezeSelected(
  source: SelectedEmbeddingSource,
  observation: ComponentSourceObservation
): ComponentLedgerCandidate["selected_embedding"] {
  return Object.freeze({ source, observation });
}

function buildFusionSlice(
  candidate: FineAssessmentCandidate
): ComponentLedgerFusionSlice {
  const contributions = candidate.fusion.fused_rank_contribution_per_stream;
  const nonEmbeddingContributions = {
    ...contributions,
    embedding_similarity: 0
  } as RecallFusionStreamContributions;
  return Object.freeze({
    fused_score: candidate.fusion.fused_score,
    fused_rank: candidate.fusion.fused_rank,
    stream_ranks: candidate.fusion.per_stream_rank,
    stream_contributions: contributions,
    family_contributions: familyMaxContributionsById(contributions),
    rrf_family_total: aggregateFamilyContributions(contributions),
    non_embedding_object_base: aggregateFamilyContributions(
      nonEmbeddingContributions
    ),
    embedding_rrf_contribution: contributions.embedding_similarity ?? 0
  });
}

function buildFloodTerms(
  flood: Readonly<IntegratedFloodCandidateDiagnostics> | undefined
): ComponentLedgerFloodTerms {
  if (flood === undefined) {
    return Object.freeze({
      present: false,
      R_obj: null,
      Slice: null,
      A_path: null,
      B_evidence: null,
      E_direct: null,
      omega: null,
      Flood: null,
      lambda: null,
      beta: null,
      final_score: null,
      slice_status: null,
      path_status: null,
      evidence_status: null,
      e_direct_status: null,
      fuel_verified: null
    });
  }
  return Object.freeze({
    present: true,
    R_obj: flood.R_obj,
    Slice: flood.Slice,
    A_path: flood.A_path,
    B_evidence: flood.B_evidence,
    E_direct: flood.E_direct,
    omega: flood.omega,
    Flood: flood.Flood,
    lambda: flood.lambda,
    beta: flood.beta,
    final_score: flood.final_score,
    slice_status: flood.slice_status,
    path_status: flood.path_status,
    evidence_status: flood.evidence_status,
    e_direct_status: flood.e_direct_status,
    fuel_verified: flood.fuel_verified
  });
}

function buildDuplicateEvidence(
  fusion: ComponentLedgerFusionSlice,
  sources: ComponentLedgerCandidate["sources"],
  selectedEmbedding: ComponentSourceObservation
): ComponentLedgerDuplicateEvidence {
  return Object.freeze({
    embedding_in_fusion_rrf:
      fusion.embedding_rrf_contribution > 0 ||
      fusion.stream_ranks.embedding_similarity !== null,
    embedding_in_deep_head: isObservedSource(selectedEmbedding),
    evidence_fts_in_fusion_rrf:
      (fusion.stream_contributions.evidence_fts ?? 0) > 0 ||
      fusion.stream_ranks.evidence_fts !== null,
    evidence_fts_in_evidence_agreement:
      sources.evidence_fts.state !== "ineligible",
    lexical_trigram_family_max_then_geometric: true,
    flood_vs_receipt_evidence_agreement_independence_assumed: false
  });
}

type SelectionLookups = Readonly<{
  readonly deliveryRank: ReadonlyMap<string, number>;
  readonly finalRelevance: ReadonlyMap<string, number>;
  readonly coverageRelevance: ReadonlyMap<string, number>;
  readonly answerRelevanceRank: ReadonlyMap<string, number>;
  readonly finalOrder:
    | "coverage"
    | "public_relevance"
    | "delivery_rank"
    | null;
  readonly maxHeadDrop: number | null;
}>;

function buildSelectionLookups(
  input: FineAssessmentSelectionBoundaryInput
): SelectionLookups {
  return Object.freeze({
    deliveryRank: mapFromEntries(input.rank_by_candidate_key),
    finalRelevance: mapFromEntries(input.final_relevance_by_candidate_key),
    coverageRelevance: mapFromEntries(
      input.coverage_relevance_by_candidate_key
    ),
    answerRelevanceRank: mapFromEntries(
      input.answer_relevance_rank_by_candidate_key
    ),
    finalOrder: input.final_order_after_coverage ?? null,
    maxHeadDrop: input.max_head_drop_after_coverage ?? null
  });
}

function selectionInputsFor(
  candidateKey: string,
  recomputedCoverage: number | null,
  lookups: SelectionLookups
): ComponentLedgerSelectionInputs {
  return Object.freeze({
    delivery_rank: lookups.deliveryRank.get(candidateKey) ?? null,
    final_relevance: lookups.finalRelevance.get(candidateKey) ?? null,
    coverage_relevance:
      lookups.coverageRelevance.get(candidateKey) ?? recomputedCoverage,
    answer_relevance_rank:
      lookups.answerRelevanceRank.get(candidateKey) ?? null,
    final_order_after_coverage: lookups.finalOrder,
    max_head_drop_after_coverage: lookups.maxHeadDrop
  });
}

function mapFromEntries(
  entries: SelectionBoundaryNumberMap | undefined
): ReadonlyMap<string, number> {
  return new Map(entries ?? []);
}
