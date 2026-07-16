import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { collectEmbeddingCoarseInjection } from
  "../../../recall/coarse-filter/embedding-coarse-injection.js";
import type {
  CoarseRecallCandidate,
  RecallServiceEmbeddingRecallPort
} from "../../../recall/runtime/recall-service-types.js";
import { buildRecallPolicy } from "../../../shared/recall-policy.js";
import {
  createDependencies,
  createMemoryEntry,
  overridePolicy
} from "../recall-service-test-fixtures.js";

describe("embedding coarse-injection logical identity", () => {
  it("sends only workspace-local memory entries to the request snapshot", async () => {
    const candidates = createSameIdCandidates();
    const prepareRecallEmbeddingSnapshot = vi.fn(async () => emptySnapshot());
    const embeddingRecallService = {
      prepareRecallEmbeddingSnapshot,
      materializeEmbeddingSupplementFromSnapshot: vi.fn(emptySupplement),
      querySupplement: vi.fn(emptySupplement)
    } satisfies RecallServiceEmbeddingRecallPort;

    await collectEmbeddingCoarseInjection(buildParams(
      [candidates.local, candidates.synthesis, candidates.global],
      embeddingRecallService,
      candidates.local.entry
    ));

    expect(prepareRecallEmbeddingSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      poolMemories: [candidates.local.entry]
    }));
  });

  it("does not let synthesis or global candidates suppress local workspace neighbors", async () => {
    const candidates = createSameIdCandidates();
    const collectWorkspaceNeighborsWithMetadata = vi.fn(async () => ({
      hits: Object.freeze([]),
      embedding_inference_calls: 1,
      query_embedding_cache_hit: false
    }));
    const embeddingRecallService = {
      collectWorkspaceNeighborsWithMetadata,
      querySupplement: vi.fn(emptySupplement)
    } satisfies RecallServiceEmbeddingRecallPort;

    await collectEmbeddingCoarseInjection(buildParams(
      [candidates.synthesis, candidates.global],
      embeddingRecallService,
      candidates.local.entry
    ));

    expect(collectWorkspaceNeighborsWithMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ excludeObjectIds: [] })
    );
  });
});

function buildParams(
  poolCandidates: readonly Readonly<CoarseRecallCandidate>[],
  embeddingRecallService: RecallServiceEmbeddingRecallPort,
  memory: Readonly<MemoryEntry>
) {
  const { dependencies } = createDependencies([memory]);
  return {
    dependencies: {
      embeddingRecallService,
      memoryRepo: { ...dependencies.memoryRepo, findByIds: vi.fn(async () => []) }
    },
    warn: vi.fn(),
    policy: embeddingPolicy(),
    workspaceId: "workspace-1",
    runId: null,
    queryText: "logical identity",
    poolCandidates
  } as const;
}

function createSameIdCandidates() {
  const localEntry = createMemoryEntry({
    object_id: "same-logical-id",
    content: "Canonical local memory content"
  });
  const synthesisEntry = Object.freeze({
    ...localEntry,
    content: "Synthesis projection with another content hash"
  });
  const globalEntry = Object.freeze({
    ...localEntry,
    content: "Global projection with another content hash"
  });
  return Object.freeze({
    local: candidate(localEntry, "workspace_local", "memory_entry"),
    synthesis: candidate(synthesisEntry, "workspace_local", "synthesis_capsule"),
    global: candidate(globalEntry, "global", "memory_entry")
  });
}

function candidate(
  entry: Readonly<MemoryEntry>,
  originPlane: "workspace_local" | "global",
  objectKind: "memory_entry" | "synthesis_capsule"
): Readonly<CoarseRecallCandidate> {
  return Object.freeze({ entry, originPlane, objectKind });
}

function embeddingPolicy() {
  const base = buildRecallPolicy({
    runtimeId: "recall-runtime",
    taskSurfaceId: "task-surface",
    maxResults: 10,
    filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
    conflictAwareness: false,
    maxTotalTokens: 1_000
  });
  return overridePolicy(base, {
    coarse_filter: {
      ...base.coarse_filter,
      semantic_supplement: {
        ...base.coarse_filter.semantic_supplement,
        enabled: true,
        embedding_enabled: true,
        max_supplement: 5,
        injection_cap: 2
      }
    }
  });
}

function emptySnapshot() {
  return Object.freeze({
    workspaceId: "workspace-1",
    runId: null,
    queryId: "logical-identity",
    poolScoresByObjectId: Object.freeze({}),
    scoringLatencyMs: 0,
    workspaceNeighbors: Object.freeze({
      hits: Object.freeze([]),
      embedding_inference_calls: 0,
      query_embedding_cache_hit: true,
      workspace_scan_truncated: false,
      query_embedding_status: "provider_not_requested" as const,
      query_embedding_degradation_reason: null
    }),
    degradedReason: null
  });
}

function emptySupplement() {
  return Promise.resolve({
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: Object.freeze({})
  });
}
