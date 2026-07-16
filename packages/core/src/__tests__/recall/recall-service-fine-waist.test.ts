import { describe, expect, it, vi } from "vitest";
import {
  EvidenceHealthState,
  type EvidenceCapsule,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import type { RecallServiceEmbeddingRecallPort } from
  "../../recall/runtime/recall-service-types.js";
import type { CoarseRecallCandidate } from
  "../../recall/runtime/recall-service-types.js";
import { prepareRecallFineAssessmentWaist } from
  "../../recall/runtime/orchestration/recall-fine-assessment.js";
import { collectTimedSupplementaryData } from
  "../../recall/runtime/orchestration/recall-fine-assessment.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import {
  createDependencies,
  createMemoryEntry,
  createPreparedQueryHandle,
  createSlot,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

describe("RecallService fine-assessment hard waist", () => {
  it.each(["legacy", "snapshot"] as const)(
    "caps expensive %s supplementary reads before assessment",
    async (mode) => {
      const memories = Array.from({ length: 6 }, (_, index) => createMemoryEntry({
        object_id: `memory-${index}`,
        content: `Implement recall candidate ${index}`,
        activation_score: 0.9 - index * 0.01
      }));
      const targetId = memories.at(-1)!.object_id;
      const spies = createExpensiveReadSpies();
      const snapshot = mode === "snapshot"
        ? createSnapshotPort({ [targetId]: 1 })
        : null;
      const { dependencies } = createDependencies(memories);
      const service = new RecallService({
        ...dependencies,
        graphSupportPort: spies.graphSupportPort,
        pathPlasticityPort: { getStrengthByMemoryId: spies.getStrengthByMemoryId },
        ...(snapshot === null ? {} : { embeddingRecallService: snapshot.port })
      });
      const policy = buildWaistPolicy(service, 2, mode === "snapshot");

      const result = await service.recall({
        taskSurface: createTaskSurface(),
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });

      expect(spies.readGraphMetrics).toHaveBeenCalledOnce();
      const graphIds = spies.readGraphMetrics.mock.calls[0]![0];
      expect(graphIds).toHaveLength(2);
      expect(spies.getStrengthByMemoryId).toHaveBeenCalledWith(
        "workspace-1",
        graphIds
      );
      expect(result.diagnostics?.token_economy).toMatchObject({
        coarse_pool_size: 6,
        fine_evaluated: 2,
        fine_pruned_count: 4
      });
      expect(result.diagnostics?.fine_assessment_pruned_candidates).toHaveLength(4);
      expect(result.diagnostics?.fine_assessment_pruned_candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            candidate_key: expect.stringMatching(/:memory_entry:memory-/u),
            origin_plane: "workspace_local",
            object_kind: "memory_entry",
            object_id: expect.stringMatching(/^memory-/u),
            coarse_index: expect.any(Number),
            drop_reason: "fine_assessment_cap"
          })
        ])
      );
      if (mode === "snapshot") {
        expect(graphIds).toContain(targetId);
        const materialization = snapshot?.materializeEmbeddingSupplementFromSnapshot
          .mock.calls[0]?.[0];
        expect(materialization?.eligibleMemories.map((entry) => entry.object_id).sort())
          .toEqual([...graphIds].sort());
        expect([...(materialization?.baseCandidateIds ?? [])].sort())
          .toEqual([...graphIds].sort());
      }
    }
  );

  it("reuses the priority-capped waist across legacy embedding reassessment", async () => {
    const fixture = createLegacyReassessmentFixture();

    const result = await fixture.service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildWaistPolicy(fixture.service, 1, true)
    });

    expect(fixture.prepareQuerySupplement).toHaveBeenCalledWith(expect.objectContaining({
      eligibleMemories: [fixture.first]
    }));
    expect(fixture.querySupplementIfReady).toHaveBeenCalledOnce();
    expect(fixture.querySupplementIfReady).toHaveBeenCalledWith(expect.objectContaining({
      eligibleMemories: [fixture.first]
    }));
    expect(fixture.scorePoolCandidates).toHaveBeenCalledWith(expect.objectContaining({
      objectIds: [fixture.first.object_id]
    }));
    expect(fixture.spies.readGraphMetrics).toHaveBeenCalledWith(
      [fixture.first.object_id], "workspace-1"
    );
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      fixture.first.object_id
    ]);
    expect(result.diagnostics?.token_economy).toMatchObject({
      coarse_pool_size: 2,
      fine_evaluated: 1,
      fine_pruned_count: 1,
      fine_priority_overflow_count: 1
    });
    expect(fixture.warnSpy).toHaveBeenCalledWith(
      "Fine-assessment priority candidates exceeded the hard evaluation budget.",
      expect.objectContaining({ priority_overflow_count: 1 })
    );
  });

  it("scopes evidence and path supplementary reads to the waist survivors", async () => {
    const first = createMemoryEntry({ object_id: "survivor", evidence_refs: ["evidence-survivor"] });
    const pruned = createMemoryEntry({ object_id: "pruned", evidence_refs: ["evidence-pruned"] });
    const evidenceFindByIds = vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
      ids.map(createEvidenceCapsule)
    );
    const findByAnchors = vi.fn(async () => []);
    const { dependencies } = createDependencies([first, pruned]);
    const service = new RecallService({ ...dependencies });
    const policy = buildWaistPolicy(service, 1, false);
    const context = {
      dependencies: {
        ...dependencies,
        evidenceSearchPort: { searchByKeyword: vi.fn(async () => []), findByIds: evidenceFindByIds },
        pathExpansionPort: { findByAnchors }
      },
      warn: vi.fn(),
      degradationReasons: new Set()
    } as unknown as Parameters<typeof collectTimedSupplementaryData>[0];
    const prepared = {
      policy,
      queryText: "recall survivor",
      queryProbes: compileRecallQueryProbes("recall survivor"),
      winnerMemoryIds: new Set([first.object_id]),
      referenceTime: "2026-03-23T00:00:00.000Z",
      tokenEstimator: () => 1
    } as unknown as Parameters<typeof collectTimedSupplementaryData>[2];
    const coarse = createSupplementaryCoarseFixture(first, pruned);
    const waist = prepareRecallFineAssessmentWaist(context, prepared, coarse);

    await collectTimedSupplementaryData(context, { workspaceId: "workspace-1" } as never,
      prepared, coarse, waist);

    expect(waist.survivors).toEqual([firstCandidate(first)]);
    expect(evidenceFindByIds).toHaveBeenCalledWith("workspace-1", ["evidence-survivor"]);
    expect(findByAnchors).toHaveBeenCalledWith(
      "workspace-1",
      [{ kind: "object", object_id: first.object_id }]
    );
  });
});

function createSupplementaryCoarseFixture(
  survivor: ReturnType<typeof createMemoryEntry>,
  pruned: ReturnType<typeof createMemoryEntry>
): Parameters<typeof collectTimedSupplementaryData>[3] {
  const candidates = [firstCandidate(survivor), firstCandidate(pruned)];
  return {
    coarseFilter: {
      candidates,
      ftsRanks: Object.freeze({ [survivor.object_id]: 1, [pruned.object_id]: 0.1 }),
      trigramFtsRanks: Object.freeze({}),
      synthesisFtsRanks: Object.freeze({}),
      evidenceFtsRanks: Object.freeze({ [survivor.object_id]: 1, [pruned.object_id]: 1 }),
      evidenceFtsRanksPerRef: Object.freeze({
        "evidence-survivor": 1,
        "evidence-pruned": 1
      }),
      sourceProximityScores: Object.freeze({}),
      sourceCohortKeys: Object.freeze({}),
      structuralScores: Object.freeze({}),
      graphExpansionScores: Object.freeze({}),
      entitySeedScores: Object.freeze({}),
      pathExpansionScores: Object.freeze({}),
      pathSuppressionScores: Object.freeze({})
    },
    combinedCoarseCandidates: candidates,
    embeddingCoarseInjection: {
      requestScoreSnapshot: undefined,
      similarityScores: Object.freeze({})
    }
  } as unknown as Parameters<typeof collectTimedSupplementaryData>[3];
}

function firstCandidate(
  entry: ReturnType<typeof createMemoryEntry>
): Readonly<CoarseRecallCandidate> {
  return Object.freeze({
    entry,
    originPlane: "workspace_local" as const,
    objectKind: "memory_entry" as const
  });
}

function createEvidenceCapsule(objectId: string): EvidenceCapsule {
  return {
    object_id: objectId,
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-23T00:00:00.000Z",
    updated_at: "2026-03-23T00:00:00.000Z",
    created_by: "fine-waist-test",
    evidence_kind: "tool_output",
    semantic_anchor: { topic: "recall", keywords: ["recall"], summary: "recall evidence" },
    event_anchor: { event_type: "test", event_id: objectId, occurred_at: "2026-03-23T00:00:00.000Z" },
    physical_anchor: null,
    evidence_health_state: EvidenceHealthState.VERIFIED,
    gist: "recall evidence gist",
    excerpt: "recall evidence excerpt",
    source_hash: `sha256:${objectId}`,
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  };
}

function createLegacyReassessmentFixture() {
  const first = createMemoryEntry({ object_id: "a-survivor", content: "Implement recall" });
  const late = createMemoryEntry({ object_id: "z-late-score", content: "Unrelated text" });
  const querySupplementIfReady = vi.fn(async () => ({
    supplementaryEntries: Object.freeze([late]),
    similarityHintsByObjectId: Object.freeze({
      [late.object_id]: Object.freeze({ object_id: late.object_id, normalized_similarity: 1 })
    })
  }));
  const scorePoolCandidates = vi.fn(async () => new Map([[late.object_id, 1]]));
  const prepareQuerySupplement = vi.fn(async () => ({
    preparedQuery: createPreparedQueryHandle("legacy-waist-query"),
    storedVectors: Object.freeze([]),
    degradedReason: null
  }));
  const embeddingRecallService: RecallServiceEmbeddingRecallPort = {
    prepareQuerySupplement,
    querySupplementIfReady,
    scorePoolCandidates,
    querySupplement: emptyEmbeddingSupplement
  };
  const slots = [
    createSlot({ object_id: "slot-a", winner_claim_id: "claim-a" }),
    createSlot({ object_id: "slot-z", winner_claim_id: "claim-z" })
  ];
  const spies = createExpensiveReadSpies();
  const { dependencies, warnSpy } = createDependencies(
    [first, late], slots, { "claim-a": [first.object_id], "claim-z": [late.object_id] }
  );
  const service = new RecallService({
    ...dependencies,
    graphSupportPort: spies.graphSupportPort,
    pathPlasticityPort: { getStrengthByMemoryId: spies.getStrengthByMemoryId },
    embeddingRecallService
  });
  return {
    first, service, spies, warnSpy,
    prepareQuerySupplement, querySupplementIfReady, scorePoolCandidates
  };
}

function createExpensiveReadSpies() {
  const readGraphMetrics = vi.fn(async (memoryIds: readonly string[]) =>
    new Map(memoryIds.map((id) => [id, { weightedEdgeCount: 0, recallCount: 0 }]))
  );
  const getStrengthByMemoryId = vi.fn(async (_workspaceId: string, memoryIds: readonly string[]) =>
    new Map(memoryIds.map((id) => [id, 0]))
  );
  return {
    readGraphMetrics,
    getStrengthByMemoryId,
    graphSupportPort: {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 0),
      countInboundRecalls: vi.fn(async () => 0),
      countInboundRecallMetricsByMemoryId: readGraphMetrics
    }
  };
}

function buildWaistPolicy(
  service: RecallService,
  maxCandidates: number,
  embeddingEnabled: boolean
): RecallPolicy {
  const taskSurface = createTaskSurface();
  const base = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
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
        max_candidates: 10,
        min_activation_score: null
      },
      semantic_supplement: {
        ...base.coarse_filter.semantic_supplement,
        enabled: true,
        embedding_enabled: embeddingEnabled,
        max_supplement: embeddingEnabled ? 5 : 0,
        injection_cap: 0
      }
    },
    fine_assessment: {
      ...base.fine_assessment,
      max_candidates: maxCandidates,
      budgets: {
        max_entries: maxCandidates,
        max_total_tokens: 10_000,
        per_dimension_limits: null
      }
    }
  });
}

function createSnapshotPort(
  scores: Readonly<Record<string, number>>
) {
  const materializeEmbeddingSupplementFromSnapshot = vi.fn(async (
    _params: Parameters<NonNullable<
      RecallServiceEmbeddingRecallPort["materializeEmbeddingSupplementFromSnapshot"]
    >>[0]
  ) => emptyEmbeddingSupplement());
  const port: RecallServiceEmbeddingRecallPort = {
    prepareRecallEmbeddingSnapshot: vi.fn(async () => Object.freeze({
      workspaceId: "workspace-1",
      runId: null,
      queryId: "fine-waist-snapshot",
      poolScoresByObjectId: Object.freeze({ ...scores }),
      scoringLatencyMs: 0,
      workspaceNeighbors: Object.freeze({
        hits: Object.freeze([]),
        embedding_inference_calls: 1,
        query_embedding_cache_hit: false,
        query_embedding_status: "provider_returned" as const,
        query_embedding_degradation_reason: null
      }),
      degradedReason: null
    })),
    materializeEmbeddingSupplementFromSnapshot,
    querySupplement: emptyEmbeddingSupplement
  };
  return { port, materializeEmbeddingSupplementFromSnapshot };
}

function emptyEmbeddingSupplement() {
  return Promise.resolve({
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: Object.freeze({})
  });
}
