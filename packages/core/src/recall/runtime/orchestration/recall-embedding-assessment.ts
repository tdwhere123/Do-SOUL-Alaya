import { collectPoolEmbeddingRescore } from "../../rerank/recall-pool-embedding-rescore.js";
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
import type { CoarseRecallCandidate } from "../recall-service-types.js";
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

type PreparedQueryPromise = Promise<Settled<PreparedEmbeddingQuery>> | null;

export interface EmbeddingAssessmentData {
  readonly preparedEmbeddingQuery: PreparedEmbeddingQuery;
  readonly supplement: CollectedEmbeddingSupplementResult;
  readonly poolRescoreScores: Readonly<Record<string, number>>;
  readonly evidenceSemanticScoresByCandidateKey: ReadonlyMap<string, number>;
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
  fineCandidates: readonly Readonly<CoarseRecallCandidate>[],
  preparedQueryResult: Awaited<NonNullable<PreparedQueryPromise>>
): Promise<EmbeddingAssessmentData> {
  const preparedEmbeddingQuery = unwrapSettled(preparedQueryResult);
  const localFineCandidates = selectLocalFineCandidates(coarse, fineCandidates);
  const fineCandidateObjectIds = localFineCandidates.map((candidate) => candidate.entry.object_id);
  const [supplementResult, poolResult, evidenceScores] = await Promise.all([
    settle(collectLegacySupplement(
      context, params, prepared, initialAssessment, preparedEmbeddingQuery, localFineCandidates
    )),
    settle(collectPoolEmbeddingRescore(context, params, prepared, fineCandidateObjectIds)),
    collectEvidenceSemanticScores({
      context,
      workspaceId: params.workspaceId,
      runId: params.runId ?? null,
      queryText: prepared.queryText,
      preparedQuery: preparedEmbeddingQuery.handle,
      fineCandidates
    })
  ]);
  throwFirstRejected([supplementResult, poolResult]);
  return Object.freeze({
    preparedEmbeddingQuery,
    supplement: unwrapSettled(supplementResult),
    poolRescoreScores: unwrapSettled(poolResult),
    evidenceSemanticScoresByCandidateKey: evidenceScores
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
  fineCandidates: readonly Readonly<CoarseRecallCandidate>[]
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
  const supplement = await service.materializeEmbeddingSupplementFromSnapshot({
    snapshot,
    eligibleMemories: localFineCandidates.map((candidate) => candidate.entry),
    // invariant: injected neighbors have their own admission path and do not redefine the pre-embedding supplement base.
    baseCandidateIds: localFineCandidates.map((candidate) => candidate.entry.object_id),
    maxSupplement: prepared.policy.coarse_filter.semantic_supplement.max_supplement
  });
  return Object.freeze({
    preparedEmbeddingQuery: Object.freeze({
      handle: null,
      storedVectors: null,
      degradedReason: null,
      preparedSupplementSupported: true
    }),
    supplement: Object.freeze({
      ...supplement,
      collectionStatus: localFineCandidates.length === 0
        ? "empty_candidate_pool" as const
        : "requested" as const
    }),
    poolRescoreScores: selectLocalPoolScores(
      snapshot.poolScoresByObjectId,
      localFineCandidates
    ),
    evidenceSemanticScoresByCandidateKey: await collectEvidenceSemanticScores({
      context,
      workspaceId: snapshot.workspaceId,
      runId: snapshot.runId,
      queryText: prepared.queryText,
      preparedQuery: null,
      fineCandidates
    })
  });
}

async function collectEvidenceSemanticScores(params: Readonly<{
  readonly context: RecallExecutionContext;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly preparedQuery: PreparedEmbeddingQuery["handle"];
  readonly fineCandidates: readonly Readonly<CoarseRecallCandidate>[];
}>): Promise<ReadonlyMap<string, number>> {
  const score = params.context.dependencies.embeddingRecallService?.scoreEvidenceCandidates;
  const candidates = params.fineCandidates
    .filter((candidate) => candidate.objectKind === "evidence_capsule")
    .slice(0, 25)
    .map((candidate) => Object.freeze({
      candidateKey: buildRecallCandidateDedupeKey(candidate),
      objectId: candidate.entry.object_id,
      content: candidate.entry.content
    }));
  if (score === undefined || params.queryText === null || candidates.length === 0) {
    return new Map();
  }
  try {
    return await score.call(params.context.dependencies.embeddingRecallService, {
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
    return new Map();
  }
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
