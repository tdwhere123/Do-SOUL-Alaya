import { describe, expect, it, vi } from "vitest";
import { DYNAMICS_CONSTANTS, MemoryDimension, RecallContextEventType, ScopeClass, SynthesisStatus, type SynthesisCapsule } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { createDependencies, createMemoryEntry, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
it("emits soul.recall.completed after recall", async () => {
    const { dependencies, appendSpy } = createDependencies([createMemoryEntry()]);
    const service = new RecallService(dependencies);

    await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "chat",
      runId: "run-1"
    });

    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: RecallContextEventType.SOUL_RECALL_COMPLETED,
        entity_type: "task_object_surface",
        entity_id: createTaskSurface().runtime_id,
        run_id: "run-1"
      })
    );
  });

it("ranks a high-plasticity candidate above an equivalent low-plasticity candidate", async () => {
    // Two memories with identical activation scores but different plasticity
    // strengths. The high-plasticity one must rank first.
    const memories = [
      createMemoryEntry({
        object_id: "memory-low-plasticity",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.5,
        content: "Lower-plasticity procedure baseline."
      }),
      createMemoryEntry({
        object_id: "memory-high-plasticity",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.5,
        content: "Higher-plasticity procedure baseline."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const plasticityPort = {
      getStrengthByMemoryId: vi.fn(
        async (_workspaceId: string, _memoryIds: readonly string[]) =>
          new Map<string, number>([
            ["memory-low-plasticity", 0.0],
            ["memory-high-plasticity", 0.9]
          ])
      )
    };
    const service = new RecallService({
      ...dependencies,
      pathPlasticityPort: plasticityPort
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(plasticityPort.getStrengthByMemoryId).toHaveBeenCalled();
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "memory-high-plasticity",
      "memory-low-plasticity"
    ]);
    const highCandidate = result.candidates.find(
      (candidate) => candidate.object_id === "memory-high-plasticity"
    );
    const lowCandidate = result.candidates.find(
      (candidate) => candidate.object_id === "memory-low-plasticity"
    );
    expect(highCandidate?.relevance_score).toBeGreaterThan(lowCandidate?.relevance_score ?? 0);
  });

it("fades ONLY the freshness band of a long-idle memory at recall read; a recently-used memory keeps full strength (R3e single-count lazy time-decay)", async () => {
    // Identical stored activation_score; only the last-reinforced timestamp
    // differs. invariant: freshness is counted ONCE. The recently-used memory
    // keeps its full stored activation. The long-idle memory loses
    // ONLY the freshness band (weight activation_weights_phase1b.freshness ===
    // 0.19), NOT the whole composite — its scope/domain/retention contributions
    // are preserved. now = 2026-03-23.
    const freshnessWeight = DYNAMICS_CONSTANTS.activation_weights_phase1b.freshness;
    const memories = [
      createMemoryEntry({
        object_id: "memory-recent",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.8,
        created_at: "2026-03-23T00:00:00.000Z",
        last_used_at: "2026-03-23T00:00:00.000Z",
        content: "Recently used procedure baseline."
      }),
      createMemoryEntry({
        object_id: "memory-idle",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.8,
        // 30 days before now and never used since -> freshness factor ~0.
        created_at: "2026-02-21T00:00:00.000Z",
        last_used_at: null,
        content: "Long-idle procedure baseline."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    const recent = result.candidates.find((candidate) => candidate.object_id === "memory-recent");
    const idle = result.candidates.find((candidate) => candidate.object_id === "memory-idle");

    // Recently-used keeps full stored activation (no decay).
    expect(recent?.score_factors?.activation).toBeCloseTo(0.8, 5);
    // Idle collapses ONLY the <=0.19 freshness band: 0.8 -> ~0.61, NOT ~0.
    // (the buggy whole-composite multiply would have produced ~0.)
    expect(idle?.score_factors?.activation ?? 0).toBeCloseTo(0.8 - freshnessWeight, 5);
    // Bounded: idle effective activation is strictly lower than the fresh one,
    // and never exceeds the stored score.
    expect(idle?.score_factors?.activation ?? 1).toBeLessThan(recent?.score_factors?.activation ?? 0);
    expect(idle?.score_factors?.activation ?? 1).toBeLessThanOrEqual(0.8);
    // Effective recall strength of the idle memory is strictly lower (directional).
    expect(recent?.relevance_score ?? 0).toBeGreaterThan(idle?.relevance_score ?? 0);
  });

it("does NOT double-penalize a freshly-used high-scope memory's activation at recall read (R3e single-count bound)", async () => {
    // invariant: the stored activation already bakes a freshness sub-term. A
    // freshly-used memory's read-time freshness factor is ~1, so the
    // re-weighted freshness band equals the baked band — the EFFECTIVE activation
    // must equal the stored score exactly, never a doubly-decayed value.
    const memories = [
      createMemoryEntry({
        object_id: "memory-fresh",
        dimension: MemoryDimension.PROCEDURE,
        scope_class: ScopeClass.PROJECT,
        activation_score: 0.6,
        created_at: "2026-03-22T00:00:00.000Z",
        last_used_at: "2026-03-23T00:00:00.000Z"
      })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    const fresh = result.candidates.find((candidate) => candidate.object_id === "memory-fresh");
    expect(fresh?.score_factors?.activation).toBeCloseTo(0.6, 5);
  });

it("does not let plasticity alone override a base lexical/activation rank inversion (mirror of the embedding-supplement contract)", async () => {
    // Strong-activation lexical baseline vs weak-activation candidate with
    // moderate plasticity. The lexical baseline must still win because the
    // 0.15-cap plasticity boost cannot close a 0.85 → 0.05 activation gap.
    const memories = [
      createMemoryEntry({
        object_id: "memory-strong-lexical",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.85,
        content: "Strong lexical baseline procedure."
      }),
      createMemoryEntry({
        object_id: "memory-weak-but-plastic",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.05,
        content: "Weak baseline, but heavily reinforced by plasticity."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const plasticityPort = {
      getStrengthByMemoryId: vi.fn(
        async (_workspaceId: string, _memoryIds: readonly string[]) =>
          new Map<string, number>([
            ["memory-strong-lexical", 0.0],
            ["memory-weak-but-plastic", 1.0]
          ])
      )
    };
    const service = new RecallService({
      ...dependencies,
      pathPlasticityPort: plasticityPort
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(result.candidates[0]?.object_id).toBe("memory-strong-lexical");
  });

it("preserves base lexical ordering on a moderate gap under PATH_PLASTICITY_WEIGHT=0.15", async () => {
    // Activation contribution gap = (0.7 - 0.4) * 0.7 = 0.21
    // because the activation-weight base sums to 0.70. Max plasticity
    // boost gap = (1.0 - 0.0) * 0.15 = 0.15. Since 0.21 > 0.15, the
    // stronger-activation candidate must rank first even when the weaker
    // candidate is fully plastic and the stronger has zero plasticity.
    const memories = [
      createMemoryEntry({
        object_id: "memory-strong-baseline",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.7,
        content: "Strong activation baseline procedure."
      }),
      createMemoryEntry({
        object_id: "memory-moderate-but-plastic",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.4,
        content: "Moderate baseline, fully plastic."
      })
    ];
    const { dependencies } = createDependencies(memories);
    const plasticityPort = {
      getStrengthByMemoryId: vi.fn(
        async (_workspaceId: string, _memoryIds: readonly string[]) =>
          new Map<string, number>([
            ["memory-strong-baseline", 0.0],
            ["memory-moderate-but-plastic", 1.0]
          ])
      )
    };
    const service = new RecallService({
      ...dependencies,
      pathPlasticityPort: plasticityPort
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(result.candidates[0]?.object_id).toBe("memory-strong-baseline");
  });

it("falls back to no plasticity boost when the path plasticity port throws — recall must not break on a plasticity failure", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-x",
        activation_score: 0.5,
        content: "Resilient memory."
      })
    ];
    const { dependencies, warnSpy } = createDependencies(memories);
    const plasticityPort = {
      getStrengthByMemoryId: vi.fn(async () => {
        throw new Error("plasticity port unavailable");
      })
    };
    const service = new RecallService({
      ...dependencies,
      pathPlasticityPort: plasticityPort
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze"
    });

    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]?.object_id).toBe("memory-x");
    expect(warnSpy).toHaveBeenCalledWith(
      "path plasticity port lookup failed",
      expect.objectContaining({ workspace_id: "workspace-1" })
    );
  });

it("lets an L2 synthesis_capsule compete with memory entries before the delivery budget cut", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-1",
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PROCEDURE,
        content: "ordinary activation-heavy memory",
        activation_score: 1
      })
    ];
    const { dependencies } = createDependencies(memories);
    const synthesis: SynthesisCapsule = {
      object_id: "synthesis-1",
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      created_by: "system",
      topic_key: "recall/synthesis",
      synthesis_type: "cross_evidence",
      summary: "Cross-evidence synthesis covering the recall implementation.",
      evidence_refs: ["evidence-1", "evidence-2"],
      source_memory_refs: ["memory-1"],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: SynthesisStatus.WORKING
    };
    const synthesisSearchByKeyword = vi.fn(async () => [
      { object_id: "synthesis-1", normalized_rank: 1 }
    ]);
    const synthesisFindByIds = vi.fn(async () => [synthesis]);
    const service = new RecallService({
      ...dependencies,
      synthesisSearchPort: {
        searchByKeyword: synthesisSearchByKeyword,
        findByIds: synthesisFindByIds
      }
    });
    const policy = overridePolicy(service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id), {
      fine_assessment: {
        budgets: {
          max_entries: 1,
          max_total_tokens: 1000,
          per_dimension_limits: null
        },
        conflict_awareness: false
      }
    });

    const result = await service.recall({
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Cross-evidence synthesis recall implementation"
      },
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(synthesisSearchByKeyword).toHaveBeenCalled();
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["synthesis-1"]);
    expect(result.candidates[0]?.object_kind).toBe("synthesis_capsule");
    const synthesisDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "synthesis-1"
    );
    const memoryDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "memory-1"
    );
    expect(synthesisDiagnostic?.per_stream_rank.synthesis_fts).toBe(1);
    expect(synthesisDiagnostic?.object_kind).toBe("synthesis_capsule");
    expect(synthesisDiagnostic?.final_rank).toBe(1);
    expect(memoryDiagnostic?.dropped_reason).toBe("max_entries");
  });

it("keeps a strong memory_entry ahead of a weaker synthesis_capsule", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-1",
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PROCEDURE,
        content: "Cross-evidence synthesis recall implementation exact memory.",
        activation_score: 1
      })
    ];
    const { dependencies } = createDependencies(memories);
    const synthesis: SynthesisCapsule = {
      object_id: "synthesis-1",
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      created_by: "system",
      topic_key: "recall/synthesis",
      synthesis_type: "cross_evidence",
      summary: "Generic synthesis about recall.",
      evidence_refs: ["evidence-1", "evidence-2"],
      source_memory_refs: ["memory-1"],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: SynthesisStatus.WORKING
    };
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => [
          { object_id: "memory-1", normalized_rank: 1 }
        ])
      },
      synthesisSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: "synthesis-1", normalized_rank: 0.25 }
        ]),
        findByIds: vi.fn(async () => [synthesis])
      }
    });
    const policy = overridePolicy(service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id), {
      fine_assessment: {
        budgets: {
          max_entries: 1,
          max_total_tokens: 1000,
          per_dimension_limits: null
        },
        conflict_awareness: false
      }
    });

    const result = await service.recall({
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Cross-evidence synthesis recall implementation"
      },
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["memory-1"]);
  });
});
