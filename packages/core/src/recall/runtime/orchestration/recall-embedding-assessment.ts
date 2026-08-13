import { collectPoolEmbeddingRescore } from "../../rerank/recall-pool-embedding-rescore.js";
import type {
  EmbeddingRecallRequestScoreSnapshot,
  EmbeddingRecallSupplementResult,
  EvidenceCandidateScoringResult
} from "../../../embedding-recall/embedding-recall-service.js";
import {
  collectEmbeddingSupplement,
  prepareEmbeddingSupplementQuery,
  type CollectedEmbeddingSupplementResult
} from "../../supplements/supplements.js";
import type { CoarseStageResult } from "../recall-service-runner-coarse.js";
import {
  buildRecallCandidateDedupeKey,
  isWorkspaceMemoryCandidate
} from "../recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../recall-service-types.js";
import {
  buildEvidenceSemanticCandidates,
  selectOwnerGistMemoryIds
} from "./evidence-semantic-candidates.js";
import { recallAnswerShapeSupportsSingleSemanticLeader } from
  "../../query/recall-answer-shape-plan.js";
import type {
  FineAssessmentResult,
  PreparedEmbeddingQuery,
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../recall-service-runner-types.js";
import {
  settle,
  throwFirstRejected,
  unwrapSettled,
  type Settled
} from "../settle-parallel.js";
import {
  materializeRecallRetrievalFieldCaptures,
  materializeRecallRetrievalFieldSeal,
  type RecallFiniteFieldChannelCapture
} from "../../field/finite-field-capture.js";
import type { RecallFiniteFieldSeal } from "../../field/finite-field-seal.js";
import type { RecallRetrievalFieldRefinementReceipt } from
  "../../field/refinement/field-refinement-receipt.js";

type PreparedQueryPromise = Promise<Settled<PreparedEmbeddingQuery>> | null;
type EvidenceDocumentsByMemoryId = NonNullable<
  RecallSupplementaryData["evidenceSemanticDocumentsByMemoryId"]
>;

export interface EmbeddingAssessmentData {
  readonly preparedEmbeddingQuery: PreparedEmbeddingQuery;
  readonly supplement: CollectedEmbeddingSupplementResult;
  readonly poolRescoreScores: Readonly<Record<string, number>>;
  readonly evidenceScoring: Readonly<EvidenceCandidateScoringResult>;
  readonly retrievalFieldCaptures: readonly Readonly<RecallFiniteFieldChannelCapture>[];
  readonly retrievalFieldSeal?: Readonly<RecallFiniteFieldSeal>;
  readonly retrievalFieldRefinementReceipts:
    readonly Readonly<RecallRetrievalFieldRefinementReceipt>[];
}

export function startEmbeddingAssessmentPreparation(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  fineCandidates: readonly Readonly<CoarseRecallCandidate>[]
): PreparedQueryPromise {
  if (coarse.embeddingCoarseInjection.requestScoreSnapshot !== undefined) {
    return null;
  }
  const localFineCandidates = selectLocalFineCandidates(coarse, fineCandidates);
  return settle(prepareEmbeddingSupplementQuery({
    dependencies: context.dependencies,
    config: prepared.policy,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    localEligibleCandidates: localFineCandidates,
    lexicalFallbackCount: Math.min(
      fineCandidates.length,
      prepared.policy.fine_assessment.budgets.max_entries
    )
  }));
}

export async function collectLegacyEmbeddingAssessmentData(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  initialAssessment: FineAssessmentResult,
  evidenceDocumentsByMemoryId: EvidenceDocumentsByMemoryId,
  fineCandidates: readonly Readonly<CoarseRecallCandidate>[],
  preparedQueryResult: Awaited<NonNullable<PreparedQueryPromise>>
): Promise<EmbeddingAssessmentData> {
  const preparedEmbeddingQuery = unwrapSettled(preparedQueryResult);
  const localFineCandidates = selectLocalFineCandidates(coarse, fineCandidates);
  const fineCandidateObjectIds = localFineCandidates.map((candidate) => candidate.entry.object_id);
  const [supplementResult, poolResult, evidenceScoring] = await Promise.all([
    settle(collectLegacySupplement(
      context, params, prepared, initialAssessment, preparedEmbeddingQuery, localFineCandidates
    )),
    settle(collectPoolEmbeddingRescore(context, params, prepared, fineCandidateObjectIds)),
    collectEvidenceSemanticScores({
      context,
      enabled: prepared.policy.coarse_filter.semantic_supplement.embedding_enabled === true,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText: prepared.queryText,
      preparedQuery: preparedEmbeddingQuery.handle,
      fineCandidates,
      evidenceDocumentsByMemoryId,
      includeOwnerGist: recallAnswerShapeSupportsSingleSemanticLeader(
        prepared.answerShapePlan
      )
    })
  ]);
  throwFirstRejected([supplementResult, poolResult]);
  const fieldCaptures = materializeRecallRetrievalFieldCaptures([
    ...prepared.retrievalFieldBundle.captures(),
    ...(evidenceScoring.fieldChannelCapture === undefined
      ? []
      : [evidenceScoring.fieldChannelCapture])
  ]);
  return Object.freeze({
    preparedEmbeddingQuery,
    supplement: unwrapSettled(supplementResult),
    poolRescoreScores: unwrapSettled(poolResult),
    evidenceScoring,
    retrievalFieldCaptures: fieldCaptures,
    retrievalFieldSeal: materializeRecallRetrievalFieldSeal(fieldCaptures),
    retrievalFieldRefinementReceipts:
      prepared.retrievalFieldBundle.refinementReceipts()
  });
}

function selectLocalFineCandidates(
  coarse: CoarseStageResult,
  fineCandidates: readonly Readonly<CoarseRecallCandidate>[]
): readonly Readonly<CoarseRecallCandidate>[] {
  const fineCandidateKeys = new Set(
    fineCandidates
      .filter(isWorkspaceMemoryCandidate)
      .map(buildRecallCandidateDedupeKey)
  );
  return coarse.coarseFilter.candidates.filter(
    (candidate) => fineCandidateKeys.has(buildRecallCandidateDedupeKey(candidate))
  );
}

export async function collectSnapshotEmbeddingAssessmentData(
  context: RecallExecutionContext,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  fineCandidates: readonly Readonly<CoarseRecallCandidate>[],
  evidenceDocumentsByMemoryId: EvidenceDocumentsByMemoryId
): Promise<EmbeddingAssessmentData> {
  const snapshot = coarse.embeddingCoarseInjection.requestScoreSnapshot;
  if (snapshot === undefined) {
    throw new Error("embedding request score snapshot is unavailable");
  }
  const service = context.dependencies.embeddingRecallService;
  if (service?.materializeEmbeddingSupplementFromSnapshot === undefined) {
    throw new Error("embedding request score snapshot materializer is unavailable");
  }
  const localFineCandidates = selectLocalFineCandidates(coarse, fineCandidates);
  const [supplement, evidenceScoring] = await Promise.all([
    service.materializeEmbeddingSupplementFromSnapshot({
      snapshot,
      eligibleMemories: localFineCandidates.map((candidate) => candidate.entry),
      // invariant: injected neighbors have their own admission path and do not redefine the pre-embedding supplement base.
      baseCandidateIds: localFineCandidates.map((candidate) => candidate.entry.object_id),
      maxSupplement: prepared.policy.coarse_filter.semantic_supplement.max_supplement
    }),
    collectEvidenceSemanticScores({
      context,
      enabled: prepared.policy.coarse_filter.semantic_supplement.embedding_enabled === true,
      workspaceId: snapshot.workspaceId,
      runId: snapshot.runId,
      queryText: prepared.queryText,
      preparedQuery: null,
      fineCandidates,
      evidenceDocumentsByMemoryId,
      includeOwnerGist: recallAnswerShapeSupportsSingleSemanticLeader(
        prepared.answerShapePlan
      ),
      ownerGistMemoryIds: selectOwnerGistMemoryIds(snapshot.poolScoresByObjectId)
    })
  ]);
  return buildSnapshotEmbeddingAssessment({
    snapshot,
    localFineCandidates,
    supplement,
    evidenceScoring,
    retrievalFieldCaptures: prepared.retrievalFieldBundle.captures(),
    retrievalFieldRefinementReceipts:
      prepared.retrievalFieldBundle.refinementReceipts()
  });
}

function buildSnapshotEmbeddingAssessment(params: Readonly<{
  readonly snapshot: Readonly<EmbeddingRecallRequestScoreSnapshot>;
  readonly localFineCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly supplement: Readonly<EmbeddingRecallSupplementResult>;
  readonly evidenceScoring: Readonly<EvidenceCandidateScoringResult>;
  readonly retrievalFieldCaptures: readonly Readonly<RecallFiniteFieldChannelCapture>[];
  readonly retrievalFieldRefinementReceipts:
    readonly Readonly<RecallRetrievalFieldRefinementReceipt>[];
}>): EmbeddingAssessmentData {
  const fieldCaptures = materializeRecallRetrievalFieldCaptures([
    ...params.retrievalFieldCaptures,
    ...(params.snapshot.fieldChannelCaptures ?? []),
    ...(params.evidenceScoring.fieldChannelCapture === undefined
      ? []
      : [params.evidenceScoring.fieldChannelCapture])
  ]);
  return Object.freeze({
    preparedEmbeddingQuery: Object.freeze({
      handle: null,
      storedVectors: null,
      degradedReason: null,
      preparedSupplementSupported: true
    }),
    supplement: Object.freeze({
      ...params.supplement,
      collectionStatus: params.localFineCandidates.length === 0
        ? "empty_candidate_pool" as const
        : "requested" as const
    }),
    poolRescoreScores: selectLocalPoolScores(
      params.snapshot.poolScoresByObjectId,
      params.localFineCandidates
    ),
    evidenceScoring: params.evidenceScoring,
    retrievalFieldCaptures: fieldCaptures,
    retrievalFieldSeal: materializeRecallRetrievalFieldSeal(fieldCaptures),
    retrievalFieldRefinementReceipts: params.retrievalFieldRefinementReceipts
  });
}

async function collectEvidenceSemanticScores(params: Readonly<{
  readonly context: RecallExecutionContext;
  readonly enabled: boolean;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly preparedQuery: PreparedEmbeddingQuery["handle"];
  readonly fineCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly evidenceDocumentsByMemoryId: EvidenceDocumentsByMemoryId;
  readonly includeOwnerGist: boolean;
  readonly ownerGistMemoryIds?: ReadonlySet<string>;
}>): Promise<Readonly<EvidenceCandidateScoringResult>> {
  if (!params.enabled) return emptyEvidenceScoring("not_requested", 0);
  const service = params.context.dependencies.embeddingRecallService;
  const score = service?.scoreEvidenceCandidates;
  if (score === undefined || params.queryText === null) {
    return emptyEvidenceScoring("not_requested", 0);
  }
  const candidates = buildEvidenceSemanticCandidates({
    candidates: params.fineCandidates,
    evidenceDocumentsByMemoryId: params.evidenceDocumentsByMemoryId,
    includeOwnerGist: params.includeOwnerGist,
    ownerGistMemoryIds: params.ownerGistMemoryIds
  });
  if (candidates.length === 0) return emptyEvidenceScoring("not_applicable", 0);
  const startedAt = performance.now();
  try {
    return await score.call(service, {
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText,
      preparedQuery: params.preparedQuery,
      candidates
    });
  } catch (error) {
    params.context.warn("transient evidence embedding degraded", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      reason: "evidence_candidate_embedding_failed",
      error: error instanceof Error ? error.message : String(error)
    });
    return Object.freeze({
      ...emptyEvidenceScoring("failed", candidates.length),
      latencyMs: Math.max(0, performance.now() - startedAt),
      failureClass: "service_error" as const
    });
  }
}

function emptyEvidenceScoring(
  status: EvidenceCandidateScoringResult["status"],
  expectedCount: number
): Readonly<EvidenceCandidateScoringResult> {
  return Object.freeze({
    activationsByCandidateKey: new Map(),
    status,
    expectedCount,
    scoredCount: 0,
    inferenceCalls: 0,
    latencyMs: 0,
    failureClass: null
  });
}

function selectLocalPoolScores(
  scores: Readonly<Record<string, number>>,
  candidates: readonly Readonly<CoarseRecallCandidate>[]
): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(candidates.flatMap((candidate) => {
    const score = scores[candidate.entry.object_id];
    return score === undefined ? [] : [[candidate.entry.object_id, score]];
  })));
}

async function collectLegacySupplement(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  initialAssessment: FineAssessmentResult,
  preparedEmbeddingQuery: PreparedEmbeddingQuery,
  localEligibleCandidates: readonly Readonly<CoarseRecallCandidate>[]
): Promise<CollectedEmbeddingSupplementResult> {
  const localEligibleIds = new Set(
    localEligibleCandidates.map((candidate) => candidate.entry.object_id)
  );
  return collectEmbeddingSupplement({
    dependencies: context.dependencies,
    baseCandidateIds: initialAssessment.candidates
      .filter((candidate) =>
        candidate.origin_plane === "workspace_local" &&
        candidate.object_kind === "memory_entry" &&
        localEligibleIds.has(candidate.object_id)
      )
      .map((candidate) => candidate.object_id),
    localEligibleCandidates,
    config: prepared.policy,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    preparedEmbeddingQuery: preparedEmbeddingQuery.handle,
    preparedStoredVectors: preparedEmbeddingQuery.storedVectors,
    preparedSupplementSupported: preparedEmbeddingQuery.preparedSupplementSupported
  });
}
