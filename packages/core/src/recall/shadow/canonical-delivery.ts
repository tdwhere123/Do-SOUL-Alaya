import { createHash } from "node:crypto";
import {
  createCanonicalSelectionReceipt,
  CANONICAL_CAPTURE_IDENTITY,
  RecallCandidateSchema,
  type CanonicalSelectionReceipt,
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
  DuplicateRecallCandidateFieldError,
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
  CAPTURE_IDENTITY_DIGEST,
  SHADOW_CAPTURE_OPERATOR_ID
} from "./identity.js";
import {
  buildCanonicalDeliveryDiagnostics,
  canonicalDiagnosticScoreFactors
} from "./observe/canonical-diagnostics.js";
import {
  captureShadowIntegration,
  failClosedShadowTrace,
  isFailClosedShadowTrace,
  type FineAssessmentShadowTrace,
  type ShadowCapturedTrace,
  type ShadowFailClosedTrace,
  type ShadowIntegrateInput
} from "./integrate.js";
import { buildProductionSetUtilities } from "./utility/production.js";
import { ShadowContractError } from "./envelope.js";

export { CANONICAL_CAPTURE_IDENTITY } from "@do-soul/alaya-protocol";
export type { CanonicalSelectionReceipt } from "@do-soul/alaya-protocol";

export function resolveFineAssessmentDeliveryPath(
  config: FineAssessmentConfig
): "legacy" | "canonical" {
  const path = config.delivery_path ?? "canonical";
  if (path === "legacy" && process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY !== "1") {
    throw new Error(
      "legacy recall delivery is disabled; set ALAYA_RECALL_ALLOW_LEGACY_DELIVERY=1 to opt in"
    );
  }
  return path;
}

export function deliverCanonicalFineAssessment(
  params: FineAssessParams
): FineAssessResult {
  try {
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
  } catch (error) {
    if (isCanonicalContractError(error)) {
      return failClosedCanonicalResult(params, mappingFailClosed());
    }
    throw error;
  }
}

function isCanonicalContractError(error: unknown): boolean {
  return error instanceof DuplicateRecallCandidateFieldError ||
    error instanceof ShadowContractError ||
    (error instanceof Error && error.name === "ZodError");
}

function toShadowInput(params: FineAssessParams): ShadowIntegrateInput {
  return {
    candidates: params.candidates,
    policy: params.policy,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    observationField: params.shadowObservationField,
    psi: params.shadowPsi,
    cutoverActivation: "active",
    memoryKeywordLanes: params.memoryKeywordLanes,
    memoryLexicalCaptures: params.memoryLexicalCaptures,
    e0Keys: params.e0Keys,
    e1Keys: params.e1Keys,
    utilitiesByKey: buildProductionSetUtilities({
      candidates: params.candidates,
      supplementaryData: params.supplementaryData
    }),
    nowIso: params.now()
  };
}

function capturedCanonicalResult(
  params: FineAssessParams,
  shadowTrace: ShadowCapturedTrace,
  candidates: readonly Readonly<RecallCandidate>[]
): FineAssessResult {
  const receipt = capturedSelectionReceipt(shadowTrace);
  return Object.freeze({
    ...emptyCanonicalShell(params, shadowTrace),
    candidates,
    diagnostics: buildCanonicalDeliveryDiagnostics(params, candidates, receipt),
    capture_receipt: receipt
  });
}

function failClosedCanonicalResult(
  params: FineAssessParams,
  shadowTrace: ShadowFailClosedTrace
): FineAssessResult {
  const receipt = failClosedSelectionReceipt(params, shadowTrace);
  const e1 = new Set(receipt.field_membership.e1_keys);
  const diagnosticParams = Object.freeze({
    ...params,
    candidates: uniqueCandidatesForKeys(params.candidates, e1)
  });
  return Object.freeze({
    ...emptyCanonicalShell(params, shadowTrace),
    candidates: Object.freeze([]),
    diagnostics: buildCanonicalDeliveryDiagnostics(
      diagnosticParams, Object.freeze([]), receipt
    ),
    capture_receipt: receipt
  });
}

function uniqueCandidatesForKeys(
  candidates: FineAssessParams["candidates"],
  acceptedKeys: ReadonlySet<string>
): FineAssessParams["candidates"] {
  const seen = new Set<string>();
  return Object.freeze(candidates.filter((candidate) => {
    const key = buildRecallCandidateDedupeKey(candidate);
    if (!acceptedKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function capturedSelectionReceipt(
  trace: ShadowCapturedTrace
): CanonicalSelectionReceipt {
  return createCanonicalSelectionReceipt({
    schema_version: 1,
    ranking_authority: "prefix_sk" as const,
    identity: CANONICAL_CAPTURE_IDENTITY,
    execution: Object.freeze({ status: "captured" as const, reason: null }),
    field_membership: Object.freeze({
      ...trace.field_membership,
      eligible_keys: trace.eligible_keys
    }),
    observations_by_candidate_key: trace.observations_by_candidate_key,
    frontiers: trace.frontiers,
    gamma: Object.freeze({
      set_utilities: trace.set_utilities,
      decisions: trace.decisions,
      rejects: trace.walk_rejects
    }),
    dispositions: capturedDispositions(trace),
    delivery: Object.freeze(trace.prefix_proposal.map((candidate_key, index) =>
      Object.freeze({ candidate_key, delivery_rank: index + 1 })
    ))
  }, sha256);
}

function failClosedSelectionReceipt(
  params: FineAssessParams,
  trace: ShadowFailClosedTrace
): CanonicalSelectionReceipt {
  const membership = failClosedMembership(params);
  const reason = membership.e0_keys.some((key) => !membership.e1_keys.includes(key))
    ? "membership_shrink" as const
    : trace.reason;
  return createCanonicalSelectionReceipt({
    schema_version: 1,
    ranking_authority: "prefix_sk" as const,
    identity: CANONICAL_CAPTURE_IDENTITY,
    execution: Object.freeze({ status: "fail_closed" as const, reason }),
    field_membership: Object.freeze({
      ...membership,
      eligible_keys: Object.freeze([])
    }),
    observations_by_candidate_key: null,
    frontiers: null,
    gamma: Object.freeze({
      set_utilities: Object.freeze([]),
      decisions: Object.freeze([]),
      rejects: Object.freeze([])
    }),
    dispositions: Object.freeze(membership.e1_keys.map((candidate_key) =>
      Object.freeze({ candidate_key, status: "unavailable" as const,
        reason: "fail_closed_unavailable" as const })
    )),
    delivery: Object.freeze([])
  }, sha256);
}

function failClosedMembership(params: FineAssessParams): Readonly<{
  readonly e0_keys: readonly string[];
  readonly e1_keys: readonly string[];
}> {
  const candidateKeys = params.candidates.map(buildRecallCandidateDedupeKey);
  const e1Keys = [...new Set(params.e1Keys ?? candidateKeys)];
  return Object.freeze({
    e0_keys: Object.freeze([...new Set(params.e0Keys ?? e1Keys)]),
    e1_keys: Object.freeze(e1Keys)
  });
}

function capturedDispositions(trace: ShadowCapturedTrace): CanonicalSelectionReceipt["dispositions"] {
  const decisions = new Set(trace.decisions.map(({ candidate_key }) => candidate_key));
  const rejects = new Map(trace.walk_rejects.map((row) => [row.candidate_key, row.walk_reject]));
  const eligible = new Set(trace.eligible_keys);
  return Object.freeze(trace.field_membership.e1_keys.map((candidate_key) => {
    if (decisions.has(candidate_key)) return Object.freeze({ candidate_key,
      status: "selected" as const, reason: "selected_by_gamma" as const });
    const reject = rejects.get(candidate_key);
    if (reject !== undefined) return Object.freeze({ candidate_key,
      status: "rejected" as const, reason: reject });
    if (eligible.has(candidate_key)) {
      throw new ShadowContractError("captured eligible candidate lacks decision or reject");
    }
    return Object.freeze({ candidate_key, status: "ineligible" as const,
      reason: "h_ineligible" as const });
  }));
}

function sha256(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
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
    capture_identity: CANONICAL_CAPTURE_IDENTITY,
    ranking_authority: "prefix_sk" as const,
    capture_execution: Object.freeze({
      status: shadowTrace.kind === "captured" ? "captured" as const : "fail_closed" as const,
      reason: shadowTrace.kind === "captured" ? null : shadowTrace.reason
    })
  };
}

function canonicalObjective(): CoverageSelectionObjectiveReceipt {
  return Object.freeze({
    schema_version: 1,
    operator_id: SHADOW_CAPTURE_OPERATOR_ID,
    mathematical_class: null,
    configuration_digest: CAPTURE_IDENTITY_DIGEST
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
    selection_reason: "safe-dominance-capture.v1 prefixSK",
    score_factors: canonicalDiagnosticScoreFactors(entry.object_id, activation, params),
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
