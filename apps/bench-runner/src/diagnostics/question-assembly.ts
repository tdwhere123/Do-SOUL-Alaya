import { resolvePremiseInvalid } from "./abstention.js";
import { classifyMiss } from "./miss/classify-miss.js";
import { classifyQuestionMissTaxonomy } from "./miss/diagnostics-miss-taxonomy.js";
import { readDiagnosticsFieldContext } from "./gold-field-membership.js";
import { buildQuestionCohortLedger } from "./diagnostics-cohort.js";
import type {
  CandidateIdentityObservation,
  DiagnosticActiveConstraintResult,
  DiagnosticRecallResult,
  DiagnosticRecallResultInput,
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic,
  LongMemEvalReplayCandidate,
  NarrowRecallDiagnostics
} from "./schema/diagnostics-types.js";
import {
  hasLongMemEvalSeedDropReasons,
  type LongMemEvalSeedDropReasons
} from "../runs/extraction/seed-fuel/seed-drop-reasons.js";
import {
  buildObjectIdentityKey,
  createEmptyGraphExpansionPlaneCountPerEdgeType,
  createEmptyGraphExpansionPlaneCountPerHop
} from "./schema/diagnostics-private.js";
import { buildGoldObjectIds } from "./gold-object-identities.js";
import type { ConditionalFieldMeasurement, ConditionalMeasurementInput } from "../runs/measurement/conditional-field-measurement.js";

export interface QuestionDiagnosticInput extends Pick<ConditionalMeasurementInput,
  "queryText" | "workspaceId" | "requestFilters" | "referenceTime" | "snapshotDigest" | "expectedIndexSnapshotId" | "requestBudget" | "recallLatencyMs"> {
  readonly questionId: string;
  readonly questionType?: string | null;
  readonly goldMemoryIds: readonly string[];
  readonly goldEvidenceIds?: readonly string[];
  readonly goldObjectIds?: readonly string[];
  readonly answerSessionIds: readonly string[];
  readonly deliveredResults: readonly DiagnosticRecallResultInput[];
  readonly activeConstraintResults?: readonly DiagnosticActiveConstraintResult[];
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly isAbstention?: boolean;
  readonly premiseInvalid?: boolean;
  readonly degradationReason: string | null;
  readonly recallResult: unknown;
  readonly embeddingMode: "disabled" | "env";
  readonly roundIndex?: number;
  readonly seedDropReasons?: LongMemEvalSeedDropReasons;
}

export interface QuestionDiagnosticParts {
  readonly conditionalFieldMeasurement?: ConditionalFieldMeasurement | null;
  readonly diagnostics: NarrowRecallDiagnostics | null;
  readonly deliveredResults: readonly DiagnosticRecallResult[];
  readonly activeConstraintResults: readonly DiagnosticActiveConstraintResult[];
  readonly gold: readonly LongMemEvalGoldDiagnostic[];
  readonly candidates: readonly LongMemEvalReplayCandidate[];
}

export function assembleQuestionDiagnostic(
  input: QuestionDiagnosticInput,
  parts: QuestionDiagnosticParts
): LongMemEvalQuestionDiagnostic {
  const scoringInput = failClosedAbstentionHits(input);
  const goldEvidenceIds = input.goldEvidenceIds ?? [];
  const goldObjectIds = buildGoldObjectIds(input);
  const missFields = buildQuestionMissFields(scoringInput, parts);
  const candidateCollisions = classifyCandidateCollisions(parts.diagnostics);
  const candidatePoolComplete = isCandidatePoolComplete(parts);
  const premiseInvalid = input.premiseInvalid === true ? true : resolvePremiseInvalid();
  return {
    question_id: input.questionId,
    question_type: input.questionType ?? null,
    is_abstention: input.isAbstention === true,
    premise_invalid: premiseInvalid,
    round_index: input.roundIndex ?? null,
    gold_memory_ids: input.goldMemoryIds,
    gold_evidence_ids: goldEvidenceIds,
    gold_object_ids: goldObjectIds,
    answer_session_ids: input.answerSessionIds,
    delivered_results: parts.deliveredResults,
    active_constraint_results: parts.activeConstraintResults,
    hit_at_1: scoringInput.hitAt1,
    hit_at_5: scoringInput.hitAt5,
    hit_at_10: scoringInput.hitAt10,
    ...missFields,
    degradation_reason: input.degradationReason,
    conditional_field_measurement: parts.conditionalFieldMeasurement ?? null,
    ...buildRecallTelemetryFields(input, parts, candidatePoolComplete),
    query_probes: parts.diagnostics?.queryProbes ?? null,
    ranking_authority: parts.diagnostics?.rankingAuthority ?? null,
    capture_receipt: parts.diagnostics?.captureReceipt ?? null,
    lexical_bound_proofs: parts.diagnostics?.lexicalBoundProofs ?? null,
    candidate_proposition_provenance:
      parts.diagnostics?.candidatePropositionProvenance ?? null,
    retrieval_field_captures: parts.diagnostics?.retrievalFieldCaptures ?? null,
    retrieval_field_refinement_receipts:
      parts.diagnostics?.retrievalFieldRefinementReceipts ?? null,
    field_refinement_stop_certificate:
      parts.diagnostics?.fieldRefinementStopCertificate ?? null,
    query_condition: parts.diagnostics?.queryCondition ?? null,
    query_entity_extraction: parts.diagnostics?.queryEntityExtraction ?? null,
    query_fact_frame_extraction:
      parts.diagnostics?.queryFactFrameExtraction ?? null,
    query_open_semantic_factor_formation:
      parts.diagnostics?.queryOpenSemanticFactorFormation ?? null,
    query_open_semantic_factor_completeness_receipt:
      parts.diagnostics?.queryOpenSemanticFactorCompletenessReceipt ?? null,
    open_semantic_factor_compatibility_trace:
      parts.diagnostics?.openSemanticFactorCompatibilityTrace ?? null,
    open_semantic_factor_composition:
      parts.diagnostics?.openSemanticFactorComposition ?? null,
    open_semantic_factor_activation:
      parts.diagnostics?.openSemanticFactorActivation ?? null,
    kind_constraint_alignment:
      parts.diagnostics?.kindConstraintAlignment ?? null,
    open_semantic_factor_archive:
      parts.diagnostics?.openSemanticFactorArchive ?? null,
    answer_shape_plan: parts.diagnostics?.answerShapePlan ?? null,
    query_sought_facets: parts.diagnostics?.querySoughtFacets ?? null,
    candidate_pool_count: parts.diagnostics?.candidatePoolCount ?? null,
    fine_pruned_count: parts.diagnostics?.finePrunedCount ?? null,
    fine_assessment_pruned_candidates:
      parts.diagnostics?.fineAssessmentPrunedCandidates ?? [],
    candidates: parts.candidates,
    candidate_key_collisions: candidateCollisions.rows,
    cohort_ledger: buildQuestionCohortLedger({
      isAbstention: input.isAbstention === true,
      premiseInvalid,
      hitAt5: scoringInput.hitAt5,
      goldMemoryIds: input.goldMemoryIds,
      goldEvidenceIds,
      goldObjectIds,
      gold: parts.gold,
      diagnosticsAvailable: parts.diagnostics !== null,
      targetMeasurementStatus: parts.conditionalFieldMeasurement?.status ?? null,
      candidatePoolComplete,
      identityConflictObjectKeys: candidateCollisions.identityConflictObjectKeys,
      missTaxonomy: missFields.miss_taxonomy,
      seedDropReasons: input.seedDropReasons
    }),
    gold: parts.gold
  };
}

function failClosedAbstentionHits(input: QuestionDiagnosticInput): QuestionDiagnosticInput {
  if (input.isAbstention !== true) return input;
  return { ...input, hitAt1: false, hitAt5: false, hitAt10: false };
}

function buildQuestionMissFields(
  input: QuestionDiagnosticInput,
  parts: QuestionDiagnosticParts
) {
  const goldObjectIds = buildGoldObjectIds(input);
  if (parts.conditionalFieldMeasurement?.status === "validated") {
    return {
      miss_classification: input.isAbstention === true ? "abstention_uncalibrated" as const
        : input.hitAt5 ? "hit_at_5" as const : "diagnostics_unavailable" as const,
      miss_taxonomy: null,
      ...(hasLongMemEvalSeedDropReasons(input.seedDropReasons) ? { seed_drop_reasons: input.seedDropReasons } : {})
    };
  }
  return {
    miss_classification: classifyMiss({
      hitAt5: input.hitAt5,
      gold: parts.gold,
      diagnosticsAvailable: parts.diagnostics !== null,
      isAbstention: input.isAbstention === true,
      seedDropReasons: input.seedDropReasons,
      field: readDiagnosticsFieldContext(parts.diagnostics)
    }),
    miss_taxonomy: classifyQuestionMissTaxonomy({
      hitAt5: input.hitAt5,
      goldMemoryIds: input.goldMemoryIds,
      goldObjectIds,
      gold: parts.gold,
      diagnosticsAvailable: parts.diagnostics !== null,
      isAbstention: input.isAbstention === true,
      seedDropReasons: input.seedDropReasons
    }),
    ...(hasLongMemEvalSeedDropReasons(input.seedDropReasons)
      ? { seed_drop_reasons: input.seedDropReasons }
      : {})
  };
}

function buildRecallTelemetryFields(
  input: QuestionDiagnosticInput,
  parts: QuestionDiagnosticParts,
  candidatePoolComplete: boolean
) {
  const diagnostics = parts.diagnostics;
  return {
    recall_diagnostics_present: diagnostics !== null,
    recall_diagnostics_keys: diagnostics?.keys ?? [],
    packet_plan_trace: diagnostics?.packetPlanTrace ?? null,
    ...(diagnostics?.phaseLatencyMs === null || diagnostics?.phaseLatencyMs === undefined
      ? {}
      : { phase_latency_ms: diagnostics.phaseLatencyMs }),
    provider_state: diagnostics?.providerState ??
      (input.embeddingMode === "disabled" ? "provider_not_requested" : "unknown"),
    provider_degradation_reason: diagnostics?.providerDegradationReason ?? null,
    ...(diagnostics?.embeddingWorkspaceScannedCount === null || diagnostics === null
      ? {}
      : { embedding_workspace_scanned_count: diagnostics.embeddingWorkspaceScannedCount }),
    ...(diagnostics?.embeddingWorkspaceTruncated === null || diagnostics === null
      ? {}
      : { embedding_workspace_truncated: diagnostics.embeddingWorkspaceTruncated }),
    ...(diagnostics?.embeddingWorkspaceProviderKind === null || diagnostics === null
      ? {}
      : { embedding_workspace_provider_kind: diagnostics.embeddingWorkspaceProviderKind }),
    ...(diagnostics?.embeddingWorkspaceModelId === null || diagnostics === null
      ? {}
      : { embedding_workspace_model_id: diagnostics.embeddingWorkspaceModelId }),
    ...(diagnostics?.embeddingWorkspaceSchemaVersion === null || diagnostics === null
      ? {}
      : { embedding_workspace_schema_version: diagnostics.embeddingWorkspaceSchemaVersion }),
    // Absence is not a third status: retired/disabled rerank was not requested.
    answer_rerank_status: diagnostics?.answerRerankStatus ?? "not_requested",
    answer_rerank_expected_count: diagnostics?.answerRerankExpectedCount ?? 0,
    answer_rerank_scored_count: diagnostics?.answerRerankScoredCount ?? 0,
    answer_rerank_failure_class: diagnostics?.answerRerankFailureClass ?? null,
    evidence_embedding_status: diagnostics?.evidenceEmbeddingStatus ?? null,
    evidence_embedding_expected_count:
      diagnostics?.evidenceEmbeddingExpectedCount ?? null,
    evidence_embedding_scored_count:
      diagnostics?.evidenceEmbeddingScoredCount ?? null,
    evidence_embedding_inference_calls:
      diagnostics?.evidenceEmbeddingInferenceCalls ?? null,
    evidence_embedding_latency_ms:
      diagnostics?.evidenceEmbeddingLatencyMs ?? null,
    evidence_embedding_failure_class:
      diagnostics?.evidenceEmbeddingFailureClass ?? null,
    evidence_embedding_selection_receipt:
      diagnostics?.evidenceEmbeddingSelectionReceipt ?? null,
    graph_expansion_plane_count_per_hop: diagnostics?.graphExpansionPlaneCountPerHop ??
      createEmptyGraphExpansionPlaneCountPerHop(),
    graph_expansion_plane_count_per_edge_type:
      diagnostics?.graphExpansionPlaneCountPerEdgeType ??
      createEmptyGraphExpansionPlaneCountPerEdgeType(),
    candidate_pool_complete: candidatePoolComplete
  };
}

function isCandidatePoolComplete(parts: QuestionDiagnosticParts): boolean {
  const measurement = parts.conditionalFieldMeasurement;
  if (measurement?.status === "validated") {
    return isClosedFieldCompleteness(measurement.completeness);
  }
  if (measurement?.status === "invalid") return false;
  return parts.diagnostics?.candidatePoolComplete === true;
}

function isClosedFieldCompleteness(
  completeness: Extract<ConditionalFieldMeasurement, { status: "validated" }>["completeness"]
): boolean {
  return isClosedFieldStatus(completeness.logical_index) &&
    isClosedFieldStatus(completeness.observed_coverage);
}

function isClosedFieldStatus(status: string): boolean {
  return status === "complete" || status === "exhausted_empty";
}

function classifyCandidateCollisions(
  diagnostics: NarrowRecallDiagnostics | null
): Readonly<{
  rows: LongMemEvalQuestionDiagnostic["candidate_key_collisions"];
  identityConflictObjectKeys: readonly string[];
}> {
  if (diagnostics === null) return { rows: [], identityConflictObjectKeys: [] };
  const groups = groupCandidateIdentityObservations(
    diagnostics.candidateIdentityObservations
  );
  const rows = groups
    .filter((group) => hasReportableCollision(group))
    .map(({ objectId, observations }) => ({
      object_id: objectId,
      candidate_keys: observations.map((item) => item.sourceCandidateKey).sort()
    }));
  return {
    rows,
    identityConflictObjectKeys: groups
      .filter(({ observations }) => hasIdentityConflict(observations))
      .map(({ objectIdentity }) => objectIdentity)
  };
}

interface CandidateIdentityGroup {
  readonly objectId: string;
  readonly objectIdentity: string;
  readonly observations: readonly CandidateIdentityObservation[];
}

function groupCandidateIdentityObservations(
  observations: readonly CandidateIdentityObservation[]
): readonly CandidateIdentityGroup[] {
  const byIdentity = new Map<string, CandidateIdentityObservation[]>();
  for (const observation of observations) {
    const identity = buildObjectIdentityKey(
      observation.candidate.objectKind,
      observation.candidate.objectId
    );
    const group = byIdentity.get(identity) ?? [];
    group.push(observation);
    byIdentity.set(identity, group);
  }
  return [...byIdentity.entries()].map(([objectIdentity, group]) => Object.freeze({
    objectId: group[0]!.candidate.objectId,
    objectIdentity,
    observations: Object.freeze(group)
  }));
}

function hasReportableCollision(group: CandidateIdentityGroup): boolean {
  const keys = group.observations.map((item) => item.sourceCandidateKey);
  return new Set(keys).size !== keys.length ||
    (group.observations.length > 1 && group.observations.some((item) => item.legacy)) ||
    hasIdentityConflict(group.observations);
}

function hasIdentityConflict(observations: readonly CandidateIdentityObservation[]): boolean {
  const candidates = observations.map((item) => item.candidate);
  const first = candidates[0];
  if (first === undefined) return false;
  return knownValuesConflict(candidates.map((row) => row.createdAt)) ||
    knownValuesConflict(candidates.map((row) => row.dimension)) ||
    knownValuesConflict(candidates.map((row) => row.sessionKey)) ||
    knownValuesConflict(candidates.map((row) => row.answerFeatures === null
      ? null
      : JSON.stringify(row.answerFeatures)));
}

function knownValuesConflict(values: readonly (string | null)[]): boolean {
  const known = values.filter((value): value is string => value !== null);
  return new Set(known).size > 1;
}
