import {
  buildRecallAnswerSupportObservations,
  buildVerifiedAssertionSupportSource,
  type RecallAnswerSupportObservation,
  type RecallVerifiedUserSupportSource
} from "../../query/recall-answer-support-observation.js";
import { compileRecallAnswerShapePlan } from "../../query/recall-answer-shape-plan.js";
import {
  assessRecallCandidateAnswerCompatibility,
  buildRecallCandidateAnswerSupport,
  isRecallVerifiedUserAssertionContext,
  type RecallCandidateAnswerCompatibility,
  type RecallCandidateAnswerSupport
} from "../../query/recall-candidate-answer-support.js";
import type { RecallAnswerShapePlan } from "../../query/recall-answer-shape-plan.js";
import type {
  RecallVerifiedUserAssertionContext
} from "../../query/recall-user-assertion-context.js";
import {
  isWorkspaceMemoryCandidate
} from "../../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../../runtime/recall-service-types.js";

type AnswerSupportCandidate = Readonly<CoarseRecallCandidate & {
  readonly fusion: Readonly<{ readonly candidate_key: string }>;
}>;

export interface FineAssessmentAnswerSupportContext {
  readonly supportByCandidateKey: ReadonlyMap<
    string,
    Readonly<RecallCandidateAnswerSupport>
  >;
  readonly observationsByCandidateKey: ReadonlyMap<
    string,
    readonly Readonly<RecallAnswerSupportObservation>[]
  >;
}

interface CandidateAnswerSupportProjection {
  readonly support: Readonly<RecallCandidateAnswerSupport> | null;
  readonly observations: readonly Readonly<RecallAnswerSupportObservation>[];
}

export function buildFineAssessmentAnswerSupportContext(params: Readonly<{
  readonly candidates: readonly AnswerSupportCandidate[];
  readonly supplementaryData: RecallSupplementaryData;
  readonly captureObservations: boolean;
}>): Readonly<FineAssessmentAnswerSupportContext> {
  const plan = compileRecallAnswerShapePlan(params.supplementaryData.queryProbes);
  const supportByCandidateKey = new Map<
    string,
    Readonly<RecallCandidateAnswerSupport>
  >();
  const observationsByCandidateKey = new Map<
    string,
    readonly Readonly<RecallAnswerSupportObservation>[]
  >();
  const contexts =
    params.supplementaryData.verifiedUserAssertionContextsByMemoryId ?? {};
  for (const candidate of params.candidates) {
    const projection = projectCandidateAnswerSupport({
      candidate,
      plan,
      supplementaryData: params.supplementaryData,
      verified: isWorkspaceMemoryCandidate(candidate)
        ? contexts[candidate.entry.object_id]
        : undefined,
      captureObservations: params.captureObservations
    });
    if (projection.support !== null) {
      supportByCandidateKey.set(
        candidate.fusion.candidate_key,
        projection.support
      );
    }
    if (projection.observations.length > 0) {
      observationsByCandidateKey.set(
        candidate.fusion.candidate_key,
        projection.observations
      );
    }
  }
  return Object.freeze({
    supportByCandidateKey,
    observationsByCandidateKey
  });
}

function projectCandidateAnswerSupport(params: Readonly<{
  readonly candidate: AnswerSupportCandidate;
  readonly plan: Readonly<RecallAnswerShapePlan>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly verified?: Readonly<RecallVerifiedUserAssertionContext>;
  readonly captureObservations: boolean;
}>): Readonly<CandidateAnswerSupportProjection> {
  const support = buildRecallCandidateAnswerSupport(
    params.plan,
    params.candidate.entry,
    params.candidate.objectKind ?? "memory_entry",
    {
      queryProbes: params.supplementaryData.queryProbes,
      verifiedUserAssertionContext: params.verified
    }
  );
  if (!params.captureObservations) {
    return { support, observations: Object.freeze([]) };
  }
  const source = resolveVerifiedSupportSource(params);
  if (source === undefined) {
    return { support, observations: Object.freeze([]) };
  }
  const compatibility = resolveCompatibility(params, support);
  return {
    support,
    observations: buildRecallAnswerSupportObservations({
      source,
      compatibility,
      support
    })
  };
}

function resolveVerifiedSupportSource(
  params: Readonly<{
    readonly candidate: AnswerSupportCandidate;
    readonly verified?: Readonly<RecallVerifiedUserAssertionContext>;
  }>
): Readonly<RecallVerifiedUserSupportSource> | undefined {
  if (params.verified === undefined) {
    return params.candidate.verifiedUserSupportSource;
  }
  return isRecallVerifiedUserAssertionContext(
    params.candidate.entry,
    params.verified
  )
    ? buildVerifiedAssertionSupportSource(params.verified)
    : undefined;
}

function resolveCompatibility(
  params: Readonly<{
    readonly candidate: AnswerSupportCandidate;
    readonly plan: Readonly<RecallAnswerShapePlan>;
  }>,
  support: Readonly<RecallCandidateAnswerSupport> | null
): Readonly<RecallCandidateAnswerCompatibility> | null {
  if (support === null || support.status === "ineligible") {
    return assessRecallCandidateAnswerCompatibility(
      params.plan,
      params.candidate.entry
    );
  }
  return Object.freeze({
    shape: support.shape,
    status: support.status,
    value_supported: support.value_supported,
    target_supported: support.target_supported,
    relation_supported: support.relation_supported,
    matched_target_terms: support.matched_target_terms,
    matched_relation_terms: support.matched_relation_terms
  });
}
