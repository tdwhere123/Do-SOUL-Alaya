import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  SynthesisStatus,
  type MemoryEntry,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { RECALL_FUSION_STREAMS, RecallService } from "../../recall/recall-service.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import type {
  RecallFusionBreakdown,
  RecallFusionStream
} from "../../recall/runtime/recall-service-types.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

// Synthesis-router delivery via the public RecallService.recall() surface
// (result.candidates + result.diagnostics).

const WS = "workspace-1";

describe("durable-edge fan-in stream registration", () => {
  it("does NOT register the retired session_cohort_fanin heuristic stream", () => {
    expect(RECALL_FUSION_STREAMS).not.toContain("session_cohort_fanin");
  });

  it("registers the durable-edge fan-in carriers path_expansion + graph_expansion", () => {
    expect(RECALL_FUSION_STREAMS).toContain("path_expansion");
    expect(RECALL_FUSION_STREAMS).toContain("graph_expansion");
  });
});

function synthesisCapsule(overrides: {
  readonly objectId: string;
  readonly evidenceRefs: readonly string[];
}): SynthesisCapsule {
  return {
    object_id: overrides.objectId,
    object_kind: "synthesis_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-23T00:00:00.000Z",
    updated_at: "2026-03-23T00:00:00.000Z",
    created_by: "system",
    topic_key: `recall/${overrides.objectId}`,
    synthesis_type: "cross_evidence",
    summary: `Cross-evidence synthesis ${overrides.objectId}.`,
    evidence_refs: [...overrides.evidenceRefs],
    source_memory_refs: [],
    workspace_id: WS,
    run_id: "run-1",
    synthesis_status: SynthesisStatus.WORKING
  };
}

function buildSynthesisService(params: {
  readonly memories: readonly MemoryEntry[];
  readonly synthesisRows: readonly SynthesisCapsule[];
  readonly synthesisRanks: Readonly<Record<string, number>>;
}): RecallService {
  const { dependencies } = createDependencies(params.memories);
  return new RecallService({
    ...dependencies,
    memoryRepo: {
      ...dependencies.memoryRepo,
      searchByKeyword: vi.fn(async () =>
        params.memories.map((memory, index) => ({
          object_id: memory.object_id,
          normalized_rank: 1 - index * 0.02
        }))
      )
    },
    synthesisSearchPort: {
      searchByKeyword: vi.fn(async () =>
        params.synthesisRows.map((row) => ({
          object_id: row.object_id,
          normalized_rank: params.synthesisRanks[row.object_id] ?? 0.5
        }))
      ),
      findByIds: vi.fn(async () => [...params.synthesisRows])
    }
  });
}

function runSynthesisRecall(service: RecallService, maxEntries: number) {
  const policy = overridePolicy(
    service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id),
    {
      fine_assessment: {
        budgets: { max_entries: maxEntries, max_total_tokens: 40000, per_dimension_limits: null },
        conflict_awareness: false
      }
    }
  );
  return service.recall({
    taskSurface: { ...createTaskSurface(), display_name: "recall synthesis router" },
    workspaceId: WS,
    strategy: "analyze",
    policyOverride: policy
  });
}

describe("synthesis router disables direct capsule delivery", () => {
  it("does not deliver a source-less capsule when a delivered memory already covers the capsule's evidence set", async () => {
    // mem-0 shares the capsule's only evidence ref and fills the window. The
    // synthesis row remains router-only and is not delivered directly.
    const memories = Array.from({ length: 6 }, (_unused, index) =>
      createMemoryEntry({
        object_id: `mem-${index}`,
        content: "recall implementation memory",
        evidence_refs: index === 0 ? ["ev-1"] : [`other-${index}`],
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.9 - index * 0.01
      })
    );
    const capsule = synthesisCapsule({ objectId: "syn-cov", evidenceRefs: ["ev-1"] });
    const service = buildSynthesisService({
      memories,
      synthesisRows: [capsule],
      synthesisRanks: { "syn-cov": 0.1 }
    });

    const result = await runSynthesisRecall(service, 5);
    const deliveredIds = result.candidates.slice(0, 5).map((candidate) => candidate.object_id);
    expect(deliveredIds).not.toContain("syn-cov");
    const reservedSynthesis = (result.diagnostics?.candidates ?? []).filter(
      (candidate) => candidate.reserved_by === "synthesis"
    );
    expect(reservedSynthesis).toHaveLength(0);
  });

  it("does not deliver a source-less capsule whose evidence set reached no in-window member", async () => {
    // Six memories saturate the window and none carries the capsule's evidence
    // ref, but source-less capsules are not delivered directly; synthesis routes
    // through child source memories instead.
    const memories = Array.from({ length: 6 }, (_unused, index) =>
      createMemoryEntry({
        object_id: `mem-${index}`,
        content: "recall implementation memory",
        evidence_refs: [`other-${index}`],
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.9 - index * 0.01
      })
    );
    const capsule = synthesisCapsule({ objectId: "syn-uncov", evidenceRefs: ["ev-uncovered"] });
    const service = buildSynthesisService({
      memories,
      synthesisRows: [capsule],
      synthesisRanks: { "syn-uncov": 0.1 }
    });

    const result = await runSynthesisRecall(service, 5);
    const deliveredIds = result.candidates.slice(0, 5).map((candidate) => candidate.object_id);
    expect(deliveredIds).not.toContain("syn-uncov");
    const capsuleDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "syn-uncov"
    );
    expect(capsuleDiagnostic).toBeUndefined();
    expect(result.candidates.length).toBeLessThanOrEqual(5);
  });

  it("does not tail-pin uncovered source-less capsules by synthesis FTS rank", async () => {
    // Two uncovered source-less capsules match synthesis FTS, but direct
    // capsule delivery is intentionally disabled by the synthesis-as-router
    // contract.
    const memories = Array.from({ length: 5 }, (_unused, index) =>
      createMemoryEntry({
        object_id: `mem-${index}`,
        content: "recall implementation memory",
        evidence_refs: [`other-${index}`],
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.9 - index * 0.01
      })
    );
    const strong = synthesisCapsule({ objectId: "syn-strong", evidenceRefs: ["ev-a"] });
    const weak = synthesisCapsule({ objectId: "syn-weak", evidenceRefs: ["ev-b"] });
    const service = buildSynthesisService({
      memories,
      synthesisRows: [weak, strong],
      synthesisRanks: { "syn-strong": 0.9, "syn-weak": 0.1 }
    });

    const result = await runSynthesisRecall(service, 6);
    const deliveredIds = result.candidates.map((candidate) => candidate.object_id);
    expect(deliveredIds).not.toContain("syn-strong");
    expect(deliveredIds).not.toContain("syn-weak");
    expect(result.candidates[0]?.object_kind).toBe("memory_entry");
  });
});

// Band mechanics can't be isolated through recall() (the evidence-set selector
// front-runs the same multi-fact gate), so drive the real exported helper.
function streamRanks(): Record<RecallFusionStream, number | null> {
  return Object.fromEntries(RECALL_FUSION_STREAMS.map((stream) => [stream, null])) as Record<
    RecallFusionStream,
    number | null
  >;
}

function streamContributions(): Record<RecallFusionStream, number> {
  return Object.fromEntries(RECALL_FUSION_STREAMS.map((stream) => [stream, 0])) as Record<
    RecallFusionStream,
    number
  >;
}

type CoverageCandidate = Readonly<{
  readonly entry: Readonly<MemoryEntry>;
  readonly originPlane: "workspace_local";
  readonly objectKind: "memory_entry";
  readonly effectiveScore: number;
  readonly effectiveFactors: { readonly relevance: number; readonly activation: number };
  readonly fusion: Readonly<RecallFusionBreakdown>;
}>;

function coverageMemory(objectId: string, surfaceId: string | null): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "memory content",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: WS,
    run_id: "run-1",
    surface_id: surfaceId,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}

function coverageCandidate(input: {
  readonly objectId: string;
  readonly surfaceId: string | null;
  readonly fusedScore: number;
}): CoverageCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(input.objectId);
  return Object.freeze({
    entry: coverageMemory(input.objectId, input.surfaceId),
    originPlane: "workspace_local" as const,
    objectKind: "memory_entry" as const,
    effectiveScore: 0,
    effectiveFactors: { relevance: 0, activation: 0 },
    fusion: Object.freeze({
      ...breakdown,
      object_kind: "memory_entry",
      per_stream_rank: Object.freeze(streamRanks()) as RecallFusionBreakdown["per_stream_rank"],
      fused_rank: 1,
      fused_score: input.fusedScore,
      fused_rank_contribution_per_stream: Object.freeze(
        streamContributions()
      ) as RecallFusionBreakdown["fused_rank_contribution_per_stream"]
    })
  });
}
