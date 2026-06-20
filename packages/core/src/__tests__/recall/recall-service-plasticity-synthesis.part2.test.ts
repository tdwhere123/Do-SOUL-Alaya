import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass, SynthesisStatus, type SynthesisCapsule } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { createDependencies, createMemoryEntry, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
it("keeps memory_entry and synthesis_capsule streams namespaced when object ids collide", async () => {
    const sharedObjectId = "shared-object-1";
    const memories = [
      createMemoryEntry({
        object_id: sharedObjectId,
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PROCEDURE,
        content: "Cross-evidence synthesis recall implementation exact memory.",
        activation_score: 1
      })
    ];
    const { dependencies } = createDependencies(memories);
    const synthesis: SynthesisCapsule = {
      object_id: sharedObjectId,
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
      source_memory_refs: [sharedObjectId],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: SynthesisStatus.WORKING
    };
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => [
          { object_id: sharedObjectId, normalized_rank: 1 }
        ])
      },
      synthesisSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: sharedObjectId, normalized_rank: 1 }
        ]),
        findByIds: vi.fn(async () => [synthesis])
      }
    });
    const policy = overridePolicy(service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id), {
      fine_assessment: {
        budgets: {
          max_entries: 2,
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

    expect(result.candidates.map((candidate) => `${candidate.object_kind}:${candidate.object_id}`))
      .toEqual(expect.arrayContaining([
        `memory_entry:${sharedObjectId}`,
        `synthesis_capsule:${sharedObjectId}`
      ]));
    const memoryDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.candidate_key === `workspace_local:memory_entry:${sharedObjectId}`
    );
    const synthesisDiagnostic = result.diagnostics?.candidates.find(
      (candidate) => candidate.candidate_key === `workspace_local:synthesis_capsule:${sharedObjectId}`
    );

    expect(memoryDiagnostic?.per_stream_rank.lexical_fts).toBe(1);
    expect(memoryDiagnostic?.object_kind).toBe("memory_entry");
    expect(memoryDiagnostic?.per_stream_rank.synthesis_fts).toBeNull();
    expect(synthesisDiagnostic?.per_stream_rank.synthesis_fts).toBe(1);
    expect(synthesisDiagnostic?.object_kind).toBe("synthesis_capsule");
    expect(synthesisDiagnostic?.per_stream_rank.lexical_fts).toBeNull();
    expect(synthesisDiagnostic?.per_stream_rank.existing_score).toBeNull();
  });

it("degrades cleanly to memory_entry-only when no synthesis port is wired", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-1",
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.9
      })
    ];
    const { dependencies } = createDependencies(memories);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(
      result.candidates.every((candidate) => candidate.object_kind === "memory_entry")
    ).toBe(true);
  });

it("reserves tail delivery slots for top synthesis below the fused-rank cut", async () => {
    // Eight memory_entry rows with strong lexical hits win fused rank
    // outright (multi-stream RRF). A synthesis fires on synthesis_fts only,
    // so without the reserve no synthesis reaches the delivery budget.
    const memories = Array.from({ length: 8 }, (_unused, index) =>
      createMemoryEntry({
        object_id: `memory-${index + 1}`,
        scope_class: ScopeClass.PROJECT,
        dimension: MemoryDimension.PROCEDURE,
        content: "Cross-evidence synthesis recall implementation exact memory.",
        activation_score: 1
      })
    );
    const { dependencies } = createDependencies(memories);
    const buildSynthesis = (id: string): SynthesisCapsule => ({
      object_id: id,
      object_kind: "synthesis_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-03-23T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
      created_by: "system",
      topic_key: `recall/${id}`,
      synthesis_type: "cross_evidence",
      summary: `Cross-evidence synthesis recall implementation ${id}.`,
      evidence_refs: ["evidence-1", "evidence-2"],
      source_memory_refs: [],
      workspace_id: "workspace-1",
      run_id: "run-1",
      synthesis_status: SynthesisStatus.WORKING
    });
    const synthesisRows = ["synthesis-1", "synthesis-2", "synthesis-3"].map(buildSynthesis);
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () =>
          memories.map((memory, index) => ({
            object_id: memory.object_id,
            normalized_rank: 1 - index * 0.05
          }))
        )
      },
      synthesisSearchPort: {
        searchByKeyword: vi.fn(async () => [
          { object_id: "synthesis-1", normalized_rank: 1 },
          { object_id: "synthesis-2", normalized_rank: 0.8 },
          { object_id: "synthesis-3", normalized_rank: 0.2 }
        ]),
        findByIds: vi.fn(async () => synthesisRows)
      }
    });
    const policy = overridePolicy(service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id), {
      fine_assessment: {
        budgets: { max_entries: 5, max_total_tokens: 4000, per_dimension_limits: null },
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

    const delivered = result.candidates;
    expect(delivered.length).toBe(5);
    // Exactly the reserve count, the top synthesis by FTS rank, tail-placed.
    expect(
      delivered
        .filter((candidate) => candidate.object_kind === "synthesis_capsule")
        .map((candidate) => candidate.object_id)
    ).toEqual(["synthesis-1", "synthesis-2"]);
    expect(delivered.slice(-2).map((candidate) => candidate.object_kind)).toEqual([
      "synthesis_capsule",
      "synthesis_capsule"
    ]);
    expect(delivered.slice(0, 3).every((candidate) => candidate.object_kind === "memory_entry")).toBe(
      true
    );
  });
});
