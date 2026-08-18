import {
  ManifestationState
} from "@do-soul/alaya-protocol";
import { buildRecallLogicalObjectKey } from
  "../../runtime/recall-service-helpers.js";
import { buildCandidateSelectorObservation } from
  "../diagnostics/candidate-selector-observation.js";
import { estimateCandidateTokens } from
  "../fine-assessment-selection/admission.js";
import type {
  FineAssessmentCandidate,
  FineAssessmentSelectionContext,
  FineAssessmentSelectionParams
} from "../fine-assessment-selection/types.js";
import { selectGammaQuality } from "./quality.js";
import type {
  SelectGammaBinding,
  SelectGammaEligibilityInput,
  SelectGammaFeatureWeights,
  SelectGammaFormulaCandidate,
  SelectGammaIdentityChannel,
  SelectGammaRequest,
  SelectGammaQualityChannel
} from "./types.js";

export function deriveSelectGammaEligibility(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): SelectGammaEligibilityInput {
  return Object.freeze({
    candidate_key: candidate.fusion.candidate_key,
    risk: resolveRiskEligibility(candidate, context),
    authority: resolveAuthorityEligibility(candidate, context)
  });
}

export function buildFineAssessmentSelectGammaBinding(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
): SelectGammaBinding {
  const candidates = formulaCandidates(params.orderedCandidates, context);
  const eligibleCandidates = candidates.filter(isEligibleForSelectGamma);
  return Object.freeze({
    workspace_id: params.workspace_id,
    generation_id: requirePinnedIdentity(params.generation_id, "generation_id"),
    condition_digest: requirePinnedIdentity(params.condition_digest, "condition_digest"),
    candidates,
    feature_weights: featureWeights(eligibleCandidates),
    max_selected: context.config.budgets.max_entries,
    per_dimension_limits: context.config.budgets.per_dimension_limits
  });
}

export function buildSelectGammaRequest(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext,
  orderedCandidates: readonly FineAssessmentCandidate[]
): SelectGammaRequest {
  return Object.freeze({
    workspace_id: params.workspace_id,
    generation_id: requirePinnedIdentity(params.generation_id, "generation_id"),
    condition_digest: requirePinnedIdentity(params.condition_digest, "condition_digest"),
    eligible_candidate_keys: Object.freeze(orderedCandidates.map(
      ({ fusion }) => fusion.candidate_key
    )),
    token_budget: context.config.budgets.max_total_tokens
  });
}

function formulaCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext
): readonly SelectGammaFormulaCandidate[] {
  return Object.freeze(candidates.map((candidate) => {
    const observation = buildCandidateSelectorObservation(candidate, context);
    const channels = qualityChannels(candidate, context, observation);
    return Object.freeze({
      workspace_id: candidate.entry.workspace_id,
      candidate_key: candidate.fusion.candidate_key,
      eligibility: deriveSelectGammaEligibility(candidate, context),
      object_key: buildRecallLogicalObjectKey(candidate),
      dimension: candidate.entry.dimension,
      source: sourceIdentity(candidate),
      lineage: lineageIdentity(candidate, context),
      token_cost: Math.max(1, estimateCandidateTokens(candidate, context)),
      quality: selectGammaQuality({
        relevance: relevanceQuality(candidate, context),
        authority: channelValue(channels.authority),
        temporal_fit: channelValue(channels.temporal),
        path_support: channelValue(channels.path)
      }),
      quality_channels: channels,
      cover: candidateCover(candidate, context)
    });
  }));
}

function qualityChannels(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext,
  observation: ReturnType<typeof buildCandidateSelectorObservation>
) {
  return Object.freeze({
    authority: authorityQuality(observation.evidence.authority),
    temporal: temporalQuality(candidate, context),
    path: pathQuality(observation.path)
  });
}

function authorityQuality(
  authority: ReturnType<typeof buildCandidateSelectorObservation>["evidence"]["authority"]
): SelectGammaQualityChannel {
  const value = authority === "verified_user_assertion" ? 1
    : authority === "verified_user_projection" ? 0.75 : null;
  return value === null ? unavailableQuality() : availableQuality(value);
}

function relevanceQuality(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): number {
  const relevance = context.coverageRelevanceByCandidateKey;
  return relevance.size === 0
    ? candidate.fusion.fused_score
    : relevance.get(candidate.fusion.candidate_key) ?? 0;
}

function temporalQuality(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): SelectGammaQualityChannel {
  const window = context.supplementaryData.queryTimeWindow;
  const start = Date.parse(candidate.entry.event_time_start ?? "");
  if (window === undefined || !Number.isFinite(start)) return unavailableQuality();
  const parsedEnd = Date.parse(candidate.entry.event_time_end ?? "");
  const end = Number.isFinite(parsedEnd) ? parsedEnd : start;
  const overlaps = Math.min(start, end) <= window.endMs &&
    Math.max(start, end) >= window.startMs;
  return availableQuality(overlaps ? 1 : 0);
}

function pathQuality(
  path: ReturnType<typeof buildCandidateSelectorObservation>["path"]
): SelectGammaQualityChannel {
  if (path.status !== "complete" && path.status !== "none") {
    return unavailableQuality();
  }
  const conductance = path.receipts.flatMap(({ edge_conductance }) =>
    edge_conductance === null ? [] : [edge_conductance]);
  return availableQuality(conductance.length === 0 ? 0 : Math.max(...conductance));
}

function candidateCover(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(
    attributedCoverFeatures(candidate, context).map((feature) => [feature, 1])
  ));
}

function attributedCoverFeatures(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): readonly string[] {
  // Lineage/gist/dimension remain identity receipts; unique keys must not buy a slot.
  const flood = candidate.fusion.flood_potential;
  return Object.freeze([
    ...(flood?.slice_status === "active" ? ["slice"] : []),
    ...(flood?.path_status === "active" ? ["path"] : []),
    ...(flood?.evidence_status === "active" ? ["evidence"] : []),
    ...(openSemanticCover(candidate, context) ? ["f3"] : [])
  ]);
}

function openSemanticCover(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): boolean {
  return context.supplementaryData
    .openSemanticFactorCandidateActivationsByCandidateKey
    ?.get(candidate.fusion.candidate_key)?.state === "observed";
}

function sourceIdentity(candidate: FineAssessmentCandidate): SelectGammaIdentityChannel {
  const key = candidate.evidenceSourceIdentity?.trim();
  return key === undefined || key.length === 0
    ? unavailableIdentity() : Object.freeze({ status: "available", key });
}

function lineageIdentity(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): SelectGammaIdentityChannel {
  const key = context.supplementaryData.sourceCohortKeys[candidate.entry.object_id]?.trim();
  return key === undefined || key.length === 0
    ? unavailableIdentity() : Object.freeze({ status: "available", key });
}

function featureWeights(
  candidates: readonly SelectGammaFormulaCandidate[]
): SelectGammaFeatureWeights {
  const coverageCounts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const feature of Object.keys(candidate.cover)) {
      coverageCounts.set(feature, (coverageCounts.get(feature) ?? 0) + 1);
    }
  }
  return Object.freeze(Object.fromEntries([...coverageCounts]
    .filter(([, count]) => count < candidates.length)
    .map(([feature]) => [feature, 1])));
}

function isEligibleForSelectGamma(candidate: SelectGammaFormulaCandidate): boolean {
  return candidate.eligibility.risk === "clear" &&
    candidate.eligibility.authority === "clear";
}

function resolveRiskEligibility(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): SelectGammaEligibilityInput["risk"] {
  if (context.answerSupportByCandidateKey === undefined ||
      context.answerSupportObservationsByCandidateKey === undefined) return "clear";
  const observation = buildCandidateSelectorObservation(candidate, context);
  return observation.evidence.event_status === "negated" ||
    observation.evidence.event_status === "reversed" ||
    observation.temporal.compatibility === "conflicted"
    ? "blocked" : "clear";
}

function resolveAuthorityEligibility(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): SelectGammaEligibilityInput["authority"] {
  const ceiling = context.supplementaryData.governanceCeilingByMemoryId[
    candidate.entry.object_id
  ];
  return ceiling === ManifestationState.HIDDEN ? "blocked" : "clear";
}

function channelValue(channel: SelectGammaQualityChannel): number {
  return channel.status === "available" ? channel.value : 0;
}

function availableQuality(value: number): SelectGammaQualityChannel {
  return Object.freeze({ status: "available", value });
}

function unavailableQuality(): SelectGammaQualityChannel {
  return Object.freeze({ status: "unavailable" });
}

function unavailableIdentity(): SelectGammaIdentityChannel {
  return Object.freeze({ status: "unavailable" });
}

function requirePinnedIdentity(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0 || value === "unspecified") {
    throw new Error(`Select_Gamma requires a pinned ${label}`);
  }
  return value;
}
