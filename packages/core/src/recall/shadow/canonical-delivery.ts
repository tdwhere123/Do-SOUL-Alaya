import {
  RecallCandidateSchema,
  type FineAssessmentConfig,
  type RecallCandidate
} from "@do-soul/alaya-protocol";
import { clampManifestationByGovernance } from
  "../../path-graph/path-relations/path-manifestation-policy.js";
import type {
  FineAssessParams,
  FineAssessResult
} from "../delivery/fine-assessment.js";
import {
  assertUniqueCandidateField,
  assignManifestation,
  buildRecallCandidateDedupeKey,
  createContentPreview,
  estimateTokens,
  isWorkspaceMemoryCandidate,
  normalizeActivationScore
} from "../runtime/recall-service-helpers.js";
import type { CoarseRecallCandidate } from "../runtime/recall-service-types.js";
import type { CoverageSelectionObjectiveReceipt } from
  "../delivery/coverage-selection.js";
import {
  D0_IDENTITY_DIGEST,
  SHADOW_ALGORITHM_ID,
  SHADOW_ALGORITHM_VERSION,
  SHADOW_CAPTURE_OPERATOR_ID
} from "./identity.js";
import {
  captureShadowIntegration,
  failClosedShadowTrace,
  isFailClosedShadowTrace,
  type FineAssessmentShadowTrace,
  type ShadowCapturedTrace,
  type ShadowFailClosedTrace,
  type ShadowIntegrateInput
} from "./integrate.js";

export const CANONICAL_D0_IDENTITY = Object.freeze({
  algorithm_id: SHADOW_ALGORITHM_ID,
  version: SHADOW_ALGORITHM_VERSION,
  digest: D0_IDENTITY_DIGEST
});

export function resolveFineAssessmentDeliveryPath(
  config: FineAssessmentConfig
): "legacy" | "canonical" {
  return config.delivery_path ?? "canonical";
}

export function deliverCanonicalFineAssessment(
  params: FineAssessParams
): FineAssessResult {
  assertUniqueCandidateField(params.candidates);
  const shadowTrace = captureShadowIntegration(toShadowInput(params));
  if (isFailClosedShadowTrace(shadowTrace)) {
    return failClosedCanonicalResult(params, shadowTrace);
  }
  const candidates = materializePrefix(params, shadowTrace.prefix_proposal);
  if (candidates === null) {
    return failClosedCanonicalResult(params, mappingFailClosed());
  }
  return capturedCanonicalResult(params, shadowTrace, candidates);
}

function toShadowInput(params: FineAssessParams): ShadowIntegrateInput {
  return {
    candidates: params.candidates,
    policy: params.policy,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    observationField: params.shadowObservationField,
    psi: params.shadowPsi,
    c0Activation: "active",
    memoryKeywordLanes: params.memoryKeywordLanes,
    nowIso: params.now()
  };
}

function capturedCanonicalResult(
  params: FineAssessParams,
  shadowTrace: ShadowCapturedTrace,
  candidates: readonly Readonly<RecallCandidate>[]
): FineAssessResult {
  return Object.freeze({
    ...emptyCanonicalShell(params, shadowTrace),
    candidates
  });
}

function failClosedCanonicalResult(
  params: FineAssessParams,
  shadowTrace: ShadowFailClosedTrace
): FineAssessResult {
  return Object.freeze({
    ...emptyCanonicalShell(params, shadowTrace),
    candidates: Object.freeze([])
  });
}

function emptyCanonicalShell(
  params: FineAssessParams,
  shadowTrace: FineAssessmentShadowTrace
) {
  return {
    diagnostics: Object.freeze([]),
    coverageSelectionObjective: canonicalObjective(),
    preparedCandidates: Object.freeze([]),
    prunedCandidates: Object.freeze([]),
    coarsePoolSize: params.candidates.length,
    fineEvaluated: params.candidates.length,
    finePrunedCount: 0,
    finePriorityOverflowCount: 0,
    shadowTrace,
    delivery_path: "canonical" as const,
    d0_identity: CANONICAL_D0_IDENTITY,
    ranking_authority: "d0_prefix" as const
  };
}

function canonicalObjective(): CoverageSelectionObjectiveReceipt {
  return Object.freeze({
    schema_version: 1,
    operator_id: SHADOW_CAPTURE_OPERATOR_ID,
    mathematical_class: null,
    configuration_digest: D0_IDENTITY_DIGEST
  });
}

function mappingFailClosed(): ShadowFailClosedTrace {
  return failClosedShadowTrace("invalid_state", "active");
}

function materializePrefix(
  params: FineAssessParams,
  prefix: readonly string[]
): readonly Readonly<RecallCandidate>[] | null {
  const byKey = indexCoarseByKey(params.candidates);
  const ordered: CoarseRecallCandidate[] = [];
  for (const key of prefix) {
    const candidate = byKey.get(key);
    if (candidate === undefined) return null;
    ordered.push(candidate);
  }
  return Object.freeze(ordered.map((candidate) =>
    materializeCanonicalCandidate(candidate, params)
  ));
}

function indexCoarseByKey(
  candidates: FineAssessParams["candidates"]
): ReadonlyMap<string, CoarseRecallCandidate> {
  return new Map(candidates.map((candidate) => [
    buildRecallCandidateDedupeKey(candidate),
    candidate
  ]));
}

function materializeCanonicalCandidate(
  candidate: CoarseRecallCandidate,
  params: FineAssessParams
): Readonly<RecallCandidate> {
  const entry = candidate.entry;
  const activation = normalizeActivationScore(entry.activation_score);
  const manifestation = clampManifestationByGovernance(
    assignManifestation(activation),
    governanceCeiling(candidate, params)
  );
  const channels = sourceChannels(candidate);
  return RecallCandidateSchema.parse({
    object_id: entry.object_id,
    object_kind: candidate.objectKind ?? "memory_entry",
    activation_score: activation,
    relevance_score: 0,
    content_preview: createContentPreview(
      entry.content,
      manifestation,
      candidate.originPlane
    ),
    token_estimate: estimateTokens(entry.content, params.tokenEstimator),
    manifestation,
    dimension: entry.dimension,
    scope_class: entry.scope_class,
    origin_plane: candidate.originPlane ?? "workspace_local",
    selection_reason: "d0.safe-dominance-capture.v1 prefixSK",
    ...(candidate.isAdvisory === undefined ? {} : { is_advisory: candidate.isAdvisory }),
    ...(channels === undefined ? {} : { source_channels: channels })
  });
}

function governanceCeiling(
  candidate: CoarseRecallCandidate,
  params: FineAssessParams
) {
  return isWorkspaceMemoryCandidate(candidate)
    ? params.supplementaryData.governanceCeilingByMemoryId[candidate.entry.object_id]
      ?? "full_eligible"
    : "full_eligible";
}

function sourceChannels(
  candidate: CoarseRecallCandidate
): readonly string[] | undefined {
  if (candidate.sourceChannels !== undefined) return candidate.sourceChannels;
  if (candidate.sourceChannel === undefined) return undefined;
  return Object.freeze([candidate.sourceChannel]);
}


