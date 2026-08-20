import {
  MemoryDimension,
  ProjectMappingState,
  ScopeClass,
  formatGardenSourceTurnFallbackArtifactRef,
  formatGardenSourceTurnFallbackSourceHash,
  type EvidenceCapsule,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  EmbeddingRecallService,
  type EvidenceCandidateScoringResult,
  type PreparedEmbeddingQueryHandle,
  type ScoreEvidenceCandidatesParams
} from "../../embedding-recall/embedding-recall-service.js";
import { RecallService } from "../../recall/recall-service.js";
import { createFieldBackedRecallService } from
  "./fixtures/keyword-field-fixture.js";
import {
  buildDirectEvidencePseudoMemoryEntry
} from "../../recall/coarse-filter/evidence/direct-evidence-candidate.js";
import type { RecallServiceEmbeddingRecallPort } from
  "../../recall/runtime/recall-service-types.js";
import {
  createEmbeddingRecord,
  createProvider,
  hashMemoryContent
} from "../embedding-recall/embedding-recall-test-helpers.js";
import {
  createAnchor,
  createDependencies,
  createMemoryEntry,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

const WORKSPACE_ID = "workspace-1";
const QUERY_TEXT = "Which color did the assistant recommend?";
const MEMORY_ID = "memory-lane";

type EvidenceScoreCandidate = ScoreEvidenceCandidatesParams["candidates"][number];
type EvidenceScoreRequest = ScoreEvidenceCandidatesParams;
type EvidenceScoringPort = RecallServiceEmbeddingRecallPort;

type EvidenceScoringEmbeddingService = EmbeddingRecallService & Required<Pick<
  EvidenceScoringPort,
  "scoreEvidenceCandidates"
>>;
describe("direct evidence transient embedding assessment", () => {
  it("scores every admitted public preview before final selection", async () => {
    const evidence = Array.from({ length: 26 }, (_, index) => createEvidenceCapsule(index));
    const scoreEvidenceCandidates = vi.fn(async (params: EvidenceScoreRequest) =>
      evidenceScores(params, new Map(
        params.candidates.map((candidate, index) => [
          candidate.candidateKey,
          index === 0 ? 0.99 : 0.2
        ])
      ))
    );
    const fixture = createRecallFixture({ evidence, scoreEvidenceCandidates });

    const result = await runRecall(fixture);

    expect(scoreEvidenceCandidates).toHaveBeenCalledOnce();
    const request = scoreEvidenceCandidates.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      workspaceId: WORKSPACE_ID,
      runId: null,
      queryText: QUERY_TEXT,
      preparedQuery: fixture.preparedQuery
    });
    expect(request?.candidates).toEqual(
      evidence.map((capsule) => expectedEvidenceScoreCandidate(capsule))
    );
    expect(fixture.querySupplementIfReady).toHaveBeenCalledWith(expect.objectContaining({
      preparedQuery: fixture.preparedQuery
    }));

    expect(findDiagnostic(result, evidenceCandidateKey(evidence[0]!.object_id)))
      .toMatchObject({
        deep_head_trace: expect.objectContaining({ embedding_signal: 0.99 })
      });
    expect(result.diagnostics).toMatchObject({
      evidence_embedding_status: "returned",
      evidence_embedding_expected_count: 26,
      evidence_embedding_scored_count: 26,
      evidence_embedding_inference_calls: 1,
      evidence_embedding_failure_class: null
    });
    expect(result.diagnostics?.token_economy?.embedding_inference_calls).toBe(2);
    expect(findMemoryCandidate(result)).toMatchObject({
      score_factors: expect.objectContaining({ embedding_similarity: 0.4 })
    });
  });

  it("fails open when direct candidate scoring fails and skips it when no direct evidence is present", async () => {
    const evidence = [createEvidenceCapsule(0)];
    const failingScore = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const failed = createRecallFixture({ evidence, scoreEvidenceCandidates: failingScore });

    const failedResult = await runRecall(failed);

    expect(failingScore).toHaveBeenCalledOnce();
    expect(findCandidate(failedResult, evidence[0]!)).toBeDefined();
    expect(findMemoryCandidate(failedResult)).toBeDefined();
    expect(failedResult.diagnostics).toMatchObject({
      evidence_embedding_status: "failed",
      evidence_embedding_expected_count: 1,
      evidence_embedding_scored_count: 0,
      evidence_embedding_inference_calls: 0,
      evidence_embedding_failure_class: "service_error",
      degradation_reasons: expect.arrayContaining([
        "evidence_candidate_embedding_failed"
      ])
    });

    const scoreWhenEmpty = vi.fn(async (params: EvidenceScoreRequest) =>
      evidenceScores(params, new Map()));
    const empty = createRecallFixture({ evidence: [], scoreEvidenceCandidates: scoreWhenEmpty });

    const emptyResult = await runRecall(empty);

    expect(scoreWhenEmpty).not.toHaveBeenCalled();
    expect(findMemoryCandidate(emptyResult)).toBeDefined();
    expect(emptyResult.diagnostics).toMatchObject({
      evidence_embedding_status: "not_applicable",
      evidence_embedding_expected_count: 0,
      evidence_embedding_scored_count: 0,
      evidence_embedding_inference_calls: 0,
      evidence_embedding_failure_class: null
    });
  });

  it("uses a transient evidence score to change the bounded delivered survivor", async () => {
    const evidence = [createEvidenceCapsule(
      0,
      "opaque zxq-8842 neutral archival payload with extra tokens"
    )];
    const [scoredResult, controlResult] = await Promise.all([
      runRecall(createRecallFixture({
        evidence, maxEntries: 1, scoreEvidenceCandidates: evidenceScorePort(0.99)
      })),
      runRecall(createRecallFixture({
        evidence, maxEntries: 1, scoreEvidenceCandidates: evidenceScorePort(null)
      }))
    ]);

    expect(findCandidate(scoredResult, evidence[0]!)).toBeDefined();
    expect(findCandidate(controlResult, evidence[0]!)).toBeUndefined();
  });

  it("keeps evidence embedding off while retaining lexical evidence when embedding is disabled", async () => {
    const evidence = [createEvidenceCapsule(0)];
    const scoreEvidenceCandidates = vi.fn(async (params: EvidenceScoreRequest) =>
      evidenceScores(params, new Map([[params.candidates[0]!.candidateKey, 0.99]])));
    const fixture = createRecallFixture({
      evidence,
      scoreEvidenceCandidates,
      embeddingEnabled: false
    });

    const result = await runRecall(fixture);

    expect(scoreEvidenceCandidates).not.toHaveBeenCalled();
    expect(findCandidate(result, evidence[0]!)).toBeDefined();
    expect(result.diagnostics).toMatchObject({
      evidence_embedding_status: "not_requested",
      evidence_embedding_expected_count: 0,
      evidence_embedding_scored_count: 0,
      evidence_embedding_inference_calls: 0,
      evidence_embedding_failure_class: null
    });
  });

  it("does not schedule evidence embedding without a scoring capability", async () => {
    const evidence = [createEvidenceCapsule(0)];
    const fixture = createRecallFixture({ evidence });

    const result = await runRecall(fixture);

    expect(findCandidate(result, evidence[0]!)).toBeDefined();
    expect(result.diagnostics).toMatchObject({
      evidence_embedding_status: "not_requested",
      evidence_embedding_expected_count: 0,
      evidence_embedding_scored_count: 0,
      evidence_embedding_inference_calls: 0,
      evidence_embedding_failure_class: null
    });
  });

  it("keeps a transient evidence score off a same-id global memory candidate", async () => {
    const evidence = [createEvidenceCapsule(0)];
    const scoreEvidenceCandidates = vi.fn(async (params: EvidenceScoreRequest) =>
      evidenceScores(params, new Map([[params.candidates[0]!.candidateKey, 0.91]])));
    const fixture = createRecallFixture({
      evidence,
      scoreEvidenceCandidates,
      globalCollisionObjectId: evidence[0]!.object_id
    });

    const result = await runRecall(fixture);

    expect(scoreEvidenceCandidates).toHaveBeenCalledOnce();
    const diagnostics = result.diagnostics?.candidates ?? [];
    const evidenceDiagnostic = diagnostics.find((candidate) =>
      candidate.candidate_key === evidenceCandidateKey(evidence[0]!.object_id)
    );
    const globalDiagnostic = diagnostics.find((candidate) =>
      candidate.candidate_key === `global:memory_entry:${evidence[0]!.object_id}`
    );
    expect(evidenceDiagnostic?.deep_head_trace?.embedding_signal).toBeCloseTo(0.91);
    expect(globalDiagnostic?.score_factors.embedding_similarity).toBeUndefined();
  });

  it("reuses a snapshot-warmed query cache instead of embedding the query a second time", async () => {
    const memory = createMemoryEntry({
      object_id: "snapshot-memory",
      content: "The assistant recommended blue."
    });
    const preview = "The public evidence preview says blue.";
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([1, 0]))
    );
    const embeddingService = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [createEmbeddingRecord({
          object_id: memory.object_id,
          content_hash: hashMemoryContent(memory.content),
          embedding: new Float32Array([1, 0])
        })])
      },
      provider: createProvider({ embedTexts }),
      eventLogRepo: {
        append: vi.fn(async (entry) => ({
          event_id: "event-1",
          created_at: "2026-07-26T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "snapshot-query"
    }) as unknown as EvidenceScoringEmbeddingService;

    await embeddingService.prepareRecallEmbeddingSnapshot({
      workspaceId: WORKSPACE_ID,
      runId: null,
      queryText: QUERY_TEXT,
      poolMemories: [memory],
      maxNeighbors: 0
    });
    const scores = await embeddingService.scoreEvidenceCandidates({
      workspaceId: WORKSPACE_ID,
      runId: null,
      queryText: QUERY_TEXT,
      preparedQuery: null,
      candidates: [{
        candidateKey: evidenceCandidateKey("snapshot-evidence"),
        evidenceObjectId: "snapshot-evidence",
        documentIdentity: "owner",
        content: preview
      }]
    });

    expect(scores.activationsByCandidateKey
      .get(evidenceCandidateKey("snapshot-evidence"))?.score).toBeCloseTo(1);
    expect(scores).toMatchObject({
      status: "returned",
      expectedCount: 1,
      scoredCount: 1,
      inferenceCalls: 1,
      failureClass: null
    });
    expect(embedTexts).toHaveBeenCalledTimes(2);
    expect(embedTexts.mock.calls.map(([texts]) => texts)).toEqual([
      [QUERY_TEXT],
      [preview]
    ]);
  });
});

function createRecallFixture(params: Readonly<{
  readonly evidence: readonly Readonly<EvidenceCapsule>[];
  readonly scoreEvidenceCandidates?: NonNullable<EvidenceScoringPort["scoreEvidenceCandidates"]>;
  readonly globalCollisionObjectId?: string;
  readonly maxEntries?: number;
  readonly embeddingEnabled?: boolean;
}>) {
  const memory = createMemoryEntry({
    object_id: MEMORY_ID,
    content: "The memory lane remains available.",
    activation_score: 0.7
  });
  const taskSurface = { ...createTaskSurface(), display_name: QUERY_TEXT };
  const preparedQuery: PreparedEmbeddingQueryHandle = {
    queryId: "prepared-direct-evidence-query",
    cacheHit: false,
    getSnapshot: () => Object.freeze({
      status: "ready" as const,
      embedding: new Float32Array([1, 0])
    })
  };
  const prepareQuerySupplement = vi.fn(async () => ({
    preparedQuery,
    storedVectors: Object.freeze([]),
    degradedReason: null
  }));
  const querySupplementIfReady = vi.fn(async () => ({
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: Object.freeze({
      [memory.object_id]: Object.freeze({
        object_id: memory.object_id,
        normalized_similarity: 0.4
      })
    })
  }));
  const { dependencies } = createDependencies([memory]);
  const embeddingRecallService: EvidenceScoringPort = {
    prepareQuerySupplement,
    querySupplementIfReady,
    querySupplement: async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({})
    }),
    ...(params.scoreEvidenceCandidates === undefined
      ? {}
      : { scoreEvidenceCandidates: params.scoreEvidenceCandidates })
  };
  const service = createFieldBackedRecallService({
    ...dependencies,
    memoryRepo: {
      ...dependencies.memoryRepo,
      searchByKeyword: vi.fn(async () => [{ object_id: memory.object_id, normalized_rank: 0.8 }]),
      findByEvidenceRefs: vi.fn(async () => []),
      findBoundEvidenceRefs: vi.fn(async () => []),
      findByIds: vi.fn(async () => [])
    },
    evidenceSearchPort: {
      searchByKeyword: vi.fn(async () => params.evidence.map((capsule, index) => ({
        object_id: capsule.object_id,
        normalized_rank: evidenceRank(index)
      }))),
      findRecallQualifiedByIds: vi.fn(async () =>
        params.evidence.map((capsule) => ({ capsule, verified_user_projection: false })))
    },
    embeddingRecallService,
    ...globalCollisionDependencies(params.globalCollisionObjectId)
  });
  return {
    memory,
    service,
    taskSurface,
    policy: createEmbeddingPolicy(
      service,
      taskSurface,
      params.maxEntries,
      params.embeddingEnabled
    ),
    preparedQuery,
    querySupplementIfReady
  };
}

function globalCollisionDependencies(objectId: string | undefined) {
  if (objectId === undefined) return {};
  return {
    globalRecallPort: {
      recall: vi.fn(async () => [{
        global_object_id: objectId,
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.GLOBAL_DOMAIN,
        content: "Global memory with a colliding object id.",
        domain_tags: ["global"],
        evidence_refs: [],
        activation_score: 0.6,
        created_at: "2026-07-26T00:00:00.000Z",
        updated_at: "2026-07-26T00:00:00.000Z"
      }])
    },
    projectMappingPort: {
      findByWorkspace: vi.fn(async () => []),
      ensureSuggestedAnchors: vi.fn(async () => [createAnchor({
        object_id: "accepted-global-collision",
        global_object_id: objectId,
        mapping_state: ProjectMappingState.ACCEPTED
      })])
    }
  };
}

function createEmbeddingPolicy(
  service: RecallService,
  taskSurface: ReturnType<typeof createTaskSurface>,
  maxEntries = 40,
  embeddingEnabled = true
): RecallPolicy {
  const base = service.buildDefaultPolicy("build", taskSurface.runtime_id);
  return overridePolicy(base, {
    coarse_filter: {
      ...base.coarse_filter,
      deterministic_match: {
        ...base.coarse_filter.deterministic_match,
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      },
      precomputed_rank: {
        ...base.coarse_filter.precomputed_rank,
        max_candidates: 40,
        min_activation_score: null
      },
      semantic_supplement: {
        ...base.coarse_filter.semantic_supplement,
        enabled: true,
        embedding_enabled: embeddingEnabled,
        max_supplement: 40,
        injection_cap: 0
      }
    },
    fine_assessment: {
      ...base.fine_assessment,
      budgets: {
        max_entries: maxEntries,
        max_total_tokens: 10_000,
        per_dimension_limits: null
      }
    }
  });
}

function createEvidenceCapsule(
  index: number,
  recallText = `Public evidence ${index} says the assistant recommended blue.`
): Readonly<EvidenceCapsule> {
  const objectId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  return Object.freeze({
    object_id: objectId,
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:00.000Z",
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: {
      topic: "color recommendation",
      keywords: ["color", "blue"],
      summary: `Public evidence ${index}`
    },
    event_anchor: null,
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: formatGardenSourceTurnFallbackArtifactRef(`turn-${index}:assistant`)
    },
    evidence_health_state: "verified",
    gist: recallText,
    excerpt: recallText,
    source_hash: formatGardenSourceTurnFallbackSourceHash(
      (index + 1).toString(16).padStart(64, "0")
    ),
    run_id: "run-1",
    workspace_id: WORKSPACE_ID,
    surface_id: "surface-1"
  });
}

function evidenceRank(index: number): number {
  return 1 - index / 100;
}

function evidenceCandidateKey(objectId: string): string {
  return `workspace_local:evidence_capsule:${objectId}`;
}

function expectedEvidenceScoreCandidate(capsule: Readonly<EvidenceCapsule>): EvidenceScoreCandidate {
  return {
    candidateKey: evidenceCandidateKey(capsule.object_id),
    evidenceObjectId: capsule.object_id,
    documentIdentity: "owner",
    content: buildDirectEvidencePseudoMemoryEntry(capsule, 1).content
  };
}

function evidenceScores(
  params: EvidenceScoreRequest,
  scores: ReadonlyMap<string, number>,
  status: EvidenceCandidateScoringResult["status"] = "returned"
): Readonly<EvidenceCandidateScoringResult> {
  const returned = status === "returned";
  const activationsByCandidateKey = new Map(params.candidates.flatMap((candidate) => {
    const score = scores.get(candidate.candidateKey);
    if (score === undefined) return [];
    const observation = Object.freeze({
      score,
      evidenceObjectId: candidate.evidenceObjectId,
      documentIdentity: candidate.documentIdentity
    });
    return [[candidate.candidateKey, Object.freeze({
      schema_version: 1 as const,
      operator_id: "evidence_document_max_v1" as const,
      state: "observed" as const,
      score,
      winner: observation,
      observations: Object.freeze([observation]),
      observation_completeness: "complete" as const,
      missing_channel_policy: "no_op" as const
    })] as const];
  }));
  return Object.freeze({
    activationsByCandidateKey,
    status,
    expectedCount: params.candidates.length,
    scoredCount: scores.size,
    inferenceCalls: returned ? 1 : 0,
    latencyMs: 0,
    failureClass: null
  });
}
function evidenceScorePort(score: number | null) {
  return vi.fn(async (params: EvidenceScoreRequest) => evidenceScores(
    params,
    score === null ? new Map() : new Map([[params.candidates[0]!.candidateKey, score]]),
    score === null ? "not_requested" : "returned"
  ));
}

async function runRecall(fixture: ReturnType<typeof createRecallFixture>) {
  return await fixture.service.recall({
    taskSurface: fixture.taskSurface,
    workspaceId: WORKSPACE_ID,
    strategy: "build",
    policyOverride: fixture.policy,
    diagnosticCapture: "answer_features"
  });
}

function findDiagnostic(
  result: Awaited<ReturnType<RecallService["recall"]>>,
  candidateKey: string
) {
  return result.diagnostics?.candidates.find((candidate) =>
    candidate.candidate_key === candidateKey
  );
}

function findCandidate(
  result: Awaited<ReturnType<RecallService["recall"]>>,
  evidence: Readonly<EvidenceCapsule>
) {
  return result.candidates.find((candidate) => candidate.object_id === evidence.object_id &&
    candidate.object_kind === "evidence_capsule");
}

function findMemoryCandidate(result: Awaited<ReturnType<RecallService["recall"]>>) {
  return result.candidates.find((candidate) => candidate.object_id === MEMORY_ID);
}
