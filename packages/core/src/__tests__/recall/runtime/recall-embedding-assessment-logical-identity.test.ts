import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../../recall/recall-service.js";
import type {
  RecallServiceEmbeddingRecallPort
} from "../../../recall/runtime/recall-service-types.js";
import {
  collectLegacyEmbeddingAssessmentData,
  collectSnapshotEmbeddingAssessmentData,
  startEmbeddingAssessmentPreparation
} from "../../../recall/runtime/orchestration/recall-embedding-assessment.js";
import { prepareRecallFineAssessmentWaist } from
  "../../../recall/runtime/orchestration/recall-fine-assessment.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface,
  overridePolicy
} from "../recall-service-test-fixtures.js";

describe("embedding assessment logical survivor identity", () => {
  it.each(["legacy", "snapshot"] as const)(
    "keeps %s consumers off an eliminated same-id memory entry",
    async (mode) => {
      const fixture = createFixture(mode);
      const waist = prepareRecallFineAssessmentWaist(
        fixture.context,
        fixture.prepared,
        fixture.coarse
      );
      expect(waist.survivors).toEqual([fixture.synthesis]);

      if (mode === "snapshot") {
        const data = await collectSnapshotEmbeddingAssessmentData(
          fixture.context, fixture.prepared, fixture.coarse, waist.survivors
        );
        expect(fixture.materialize).toHaveBeenCalledWith(expect.objectContaining({
          eligibleMemories: [], baseCandidateIds: []
        }));
        expect(data.poolRescoreScores).toEqual({});
        return;
      }

      const preparation = startEmbeddingAssessmentPreparation(
        fixture.context, fixture.params, fixture.prepared, fixture.coarse, waist.survivors
      );
      expect(preparation).not.toBeNull();
      const data = await collectLegacyEmbeddingAssessmentData(
        fixture.context, fixture.params, fixture.prepared, fixture.coarse,
        fixture.initialAssessment, waist.survivors, await preparation!
      );
      expect(fixture.prepareQuery).not.toHaveBeenCalled();
      expect(fixture.querySupplement).not.toHaveBeenCalled();
      expect(fixture.scorePool).not.toHaveBeenCalled();
      expect(data.poolRescoreScores).toEqual({});
    }
  );
});

function createFixture(mode: "legacy" | "snapshot") {
  const candidates = createSameIdCandidates();
  const embedding = createEmbeddingPort(mode);
  const { dependencies } = createDependencies([candidates.entry]);
  const service = new RecallService({ ...dependencies, embeddingRecallService: embedding.port });
  const policy = buildPolicy(service);
  const context = {
    dependencies: { ...dependencies, embeddingRecallService: embedding.port },
    warn: vi.fn(), degradationReasons: new Set()
  } as unknown as Parameters<typeof prepareRecallFineAssessmentWaist>[0];
  return {
    ...embedding,
    context,
    prepared: {
      policy, queryText: "Strong synthesis candidate", winnerMemoryIds: new Set<string>()
    } as unknown as Parameters<typeof prepareRecallFineAssessmentWaist>[1],
    coarse: createCoarseFixture(mode, candidates),
    synthesis: candidates.synthesis,
    params: { workspaceId: "workspace-1", runId: null } as never,
    initialAssessment: {
      candidates: [{
        object_id: candidates.entry.object_id,
        object_kind: "synthesis_capsule",
        origin_plane: "workspace_local"
      }]
    } as never
  };
}

function createSameIdCandidates() {
  const entry = createMemoryEntry({
    object_id: "same-logical-id",
    content: "Weak memory candidate."
  });
  const shared = { entry, originPlane: "workspace_local" as const };
  return {
    entry,
    memory: Object.freeze({ ...shared, objectKind: "memory_entry" as const }),
    synthesis: Object.freeze({ ...shared, objectKind: "synthesis_capsule" as const })
  };
}

function createEmbeddingPort(mode: "legacy" | "snapshot") {
  const prepareQuery = vi.fn();
  const querySupplement = vi.fn();
  const scorePool = vi.fn();
  const materialize = vi.fn(async () => emptyEmbeddingSupplement());
  const port: RecallServiceEmbeddingRecallPort = mode === "snapshot"
    ? { materializeEmbeddingSupplementFromSnapshot: materialize,
      querySupplement: emptyEmbeddingSupplement }
    : { prepareQuerySupplement: prepareQuery, querySupplementIfReady: querySupplement,
      scorePoolCandidates: scorePool, querySupplement: emptyEmbeddingSupplement };
  return { port, prepareQuery, querySupplement, scorePool, materialize };
}

function createCoarseFixture(
  mode: "legacy" | "snapshot",
  candidates: ReturnType<typeof createSameIdCandidates>
): Parameters<typeof prepareRecallFineAssessmentWaist>[2] {
  const id = candidates.entry.object_id;
  return {
    coarseFilter: {
      candidates: [candidates.memory],
      ftsRanks: Object.freeze({ [id]: 0.1 }),
      trigramFtsRanks: Object.freeze({}),
      synthesisFtsRanks: Object.freeze({ [id]: 1 }),
      evidenceFtsRanks: Object.freeze({}),
      structuralScores: Object.freeze({})
    },
    combinedCoarseCandidates: [candidates.memory, candidates.synthesis],
    embeddingCoarseInjection: {
      requestScoreSnapshot: mode === "snapshot" ? createSnapshot(id) : undefined,
      similarityScores: Object.freeze({})
    }
  } as unknown as Parameters<typeof prepareRecallFineAssessmentWaist>[2];
}

function createSnapshot(objectId: string) {
  return Object.freeze({
    workspaceId: "workspace-1", runId: null, queryId: "logical-identity",
    poolScoresByObjectId: Object.freeze({ [objectId]: 0 }), scoringLatencyMs: 0,
    workspaceNeighbors: Object.freeze({
      hits: Object.freeze([]), embedding_inference_calls: 1,
      query_embedding_cache_hit: false, query_embedding_status: "provider_returned" as const,
      query_embedding_degradation_reason: null
    }),
    degradedReason: null
  });
}

function buildPolicy(service: RecallService) {
  const base = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
  return overridePolicy(base, {
    coarse_filter: {
      ...base.coarse_filter,
      semantic_supplement: {
        ...base.coarse_filter.semantic_supplement,
        enabled: true, embedding_enabled: true, max_supplement: 5, injection_cap: 0
      }
    },
    fine_assessment: {
      ...base.fine_assessment,
      max_candidates: 1,
      budgets: { max_entries: 1, max_total_tokens: 10_000, per_dimension_limits: null }
    }
  });
}

function emptyEmbeddingSupplement() {
  return Promise.resolve({
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: Object.freeze({})
  });
}
