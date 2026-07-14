import type { EmbeddingRecallSupplementResult } from "../../../embedding-recall/embedding-recall-service.js";
import { collectPoolEmbeddingRescore } from "../../rerank/recall-pool-embedding-rescore.js";
import {
  collectEmbeddingSupplement,
  prepareEmbeddingSupplementQuery
} from "../../supplements/supplements.js";
import type { CoarseStageResult } from "../recall-service-runner-coarse.js";
import type {
  FineAssessmentResult,
  PreparedEmbeddingQuery,
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../recall-service-runner-types.js";

type Settled<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

type PreparedQueryPromise = Promise<Settled<PreparedEmbeddingQuery>> | null;

export interface EmbeddingAssessmentData {
  readonly preparedEmbeddingQuery: PreparedEmbeddingQuery;
  readonly supplement: EmbeddingRecallSupplementResult;
  readonly poolRescoreScores: Readonly<Record<string, number>>;
}

export function startEmbeddingAssessmentPreparation(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): PreparedQueryPromise {
  if (coarse.embeddingCoarseInjection.requestScoreSnapshot !== undefined) {
    return null;
  }
  return settle(prepareEmbeddingSupplementQuery({
    dependencies: context.dependencies,
    config: prepared.policy,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    localEligibleCandidates: coarse.coarseFilter.candidates,
    lexicalFallbackCount: Math.min(
      coarse.combinedCoarseCandidates.length,
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
  preparedQueryResult: Awaited<NonNullable<PreparedQueryPromise>>
): Promise<EmbeddingAssessmentData> {
  const preparedEmbeddingQuery = unwrapSettled(preparedQueryResult);
  const [supplementResult, poolResult] = await Promise.all([
    settle(collectLegacySupplement(context, params, prepared, coarse, initialAssessment, preparedEmbeddingQuery)),
    settle(collectPoolEmbeddingRescore(context, params, prepared, coarse))
  ]);
  throwFirstRejected([supplementResult, poolResult]);
  return Object.freeze({
    preparedEmbeddingQuery,
    supplement: unwrapSettled(supplementResult),
    poolRescoreScores: unwrapSettled(poolResult)
  });
}

export async function collectSnapshotEmbeddingAssessmentData(
  context: RecallExecutionContext,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<EmbeddingAssessmentData> {
  const snapshot = coarse.embeddingCoarseInjection.requestScoreSnapshot;
  if (snapshot === undefined) {
    throw new Error("embedding request score snapshot is unavailable");
  }
  const service = context.dependencies.embeddingRecallService;
  if (service?.materializeEmbeddingSupplementFromSnapshot === undefined) {
    throw new Error("embedding request score snapshot materializer is unavailable");
  }
  const supplement = await service.materializeEmbeddingSupplementFromSnapshot({
    snapshot,
    eligibleMemories: coarse.coarseFilter.candidates.map((candidate) => candidate.entry),
    // invariant: injected neighbors have their own admission path and do not redefine the pre-embedding supplement base.
    baseCandidateIds: coarse.coarseFilter.candidates.map((candidate) => candidate.entry.object_id),
    maxSupplement: prepared.policy.coarse_filter.semantic_supplement.max_supplement
  });
  return Object.freeze({
    preparedEmbeddingQuery: Object.freeze({
      handle: null,
      storedVectors: null,
      degradedReason: null
    }),
    supplement,
    poolRescoreScores: snapshot.poolScoresByObjectId
  });
}

async function collectLegacySupplement(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult,
  initialAssessment: FineAssessmentResult,
  preparedEmbeddingQuery: PreparedEmbeddingQuery
): Promise<EmbeddingRecallSupplementResult> {
  return collectEmbeddingSupplement({
    dependencies: context.dependencies,
    baseCandidateIds: initialAssessment.candidates.map((candidate) => candidate.object_id),
    localEligibleCandidates: coarse.coarseFilter.candidates,
    config: prepared.policy,
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    preparedEmbeddingQuery: preparedEmbeddingQuery.handle,
    preparedStoredVectors: preparedEmbeddingQuery.storedVectors
  });
}

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason })
  );
}

function throwFirstRejected(results: readonly Settled<unknown>[]): void {
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}

function unwrapSettled<T>(result: Settled<T>): T {
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}
