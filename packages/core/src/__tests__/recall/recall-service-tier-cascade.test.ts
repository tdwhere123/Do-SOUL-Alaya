import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ProjectMappingState,
  ScopeClass,
  StorageTier
} from "@do-soul/alaya-protocol";
import {
  COLD_CASCADE_DECAY,
  MIN_RECALL_RESULTS,
  WARM_CASCADE_DECAY
} from "../../recall/runtime/recall-service-helpers.js";
import {
  createAnchor,
  createMemoryEntry,
  recallWith
} from "./coarse-filter/recall-tier-cascade-fixtures.js";

describe("RecallService tier cascade", () => {
  it("keeps the HOT-only fast path output identical when HOT reaches threshold", async () => {
    const hot = Array.from({ length: MIN_RECALL_RESULTS }, (_, index) =>
      createMemoryEntry({
        object_id: `hot-${index}`,
        activation_score: 0.9 - index * 0.01,
        storage_tier: StorageTier.HOT
      })
    );

    const graphSupportSpy = vi.fn(async () => 0);
    const control = await recallWith({ hot });
    const cascade = await recallWith({
      hot,
      warm: [createMemoryEntry({ object_id: "warm-unused", storage_tier: StorageTier.WARM })],
      cold: [createMemoryEntry({ object_id: "cold-unused", storage_tier: StorageTier.COLD })],
      graphSupportPort: {
        countInboundSupports: graphSupportSpy,
        countInboundEdgesWeighted: graphSupportSpy
      }
    });

    expect(cascade.findByWorkspaceIdSpy).toHaveBeenCalledTimes(1);
    expect(cascade.findByWorkspaceIdSpy).toHaveBeenCalledWith(
      "workspace-1",
      StorageTier.HOT,
      expect.objectContaining({ offset: 0 })
    );
    expect(graphSupportSpy).toHaveBeenCalledTimes(MIN_RECALL_RESULTS);
    // phase_latency_ms is non-deterministic wall-clock telemetry, orthogonal to
    // what is recalled; drop it before the byte-identical comparison.
    const withoutLatency = (result: typeof control.result) => ({
      ...result,
      diagnostics:
        result.diagnostics === undefined
          ? undefined
          : { ...result.diagnostics, phase_latency_ms: undefined }
    });
    expect(withoutLatency(cascade.result)).toEqual(withoutLatency(control.result));
    expect(cascade.result.degradation_reason).toBeNull();
    expect(cascade.result.candidates.flatMap((candidate) => candidate.source_channels ?? [])).not.toContain("warm_cascade");
    expect(cascade.result.candidates.flatMap((candidate) => candidate.source_channels ?? [])).not.toContain("cold_cascade");
  });

  it("loads a large HOT tier through bounded pages", async () => {
    const hot = Array.from({ length: 600 }, (_, index) =>
      createMemoryEntry({
        object_id: `hot-${String(index).padStart(3, "0")}`,
        activation_score: 0.9 - index * 0.001,
        storage_tier: StorageTier.HOT
      })
    );

    const { result, findByWorkspaceIdSpy } = await recallWith({ hot });
    const hotCalls = findByWorkspaceIdSpy.mock.calls.filter(
      (call) => call[1] === StorageTier.HOT
    );

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(hotCalls).toHaveLength(2);
    expect(hotCalls[0]?.[2]).toEqual({ limit: 512, offset: 0 });
    expect(hotCalls[1]?.[2]).toEqual({ limit: 512, offset: 512 });
  }, 30_000);

  it("loads the recall tier window through cursor pages when supported", async () => {
    const hot = Array.from({ length: 600 }, (_, index) =>
      createMemoryEntry({
        object_id: `hot-${String(index).padStart(3, "0")}`,
        created_at: `2026-05-07T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        activation_score: 0.9 - index * 0.001
      })
    );
    const findRecallTierWindow = vi.fn(async (query: {
      readonly workspaceId: string;
      readonly tier: StorageTier;
      readonly limit: number;
      readonly cursor?: { readonly created_at: string; readonly object_id: string };
    }) => {
      const start = query.cursor === undefined
        ? 0
        : hot.findIndex((entry) =>
          entry.created_at === query.cursor?.created_at
          && entry.object_id === query.cursor.object_id
        ) + 1;
      const page = hot.slice(start, start + query.limit);
      const truncated = start + page.length < hot.length;
      const last = page.at(-1);
      return {
        memories: page,
        next_cursor: truncated && last !== undefined
          ? { created_at: last.created_at, object_id: last.object_id }
          : null,
        truncated
      };
    });

    const { result, findByWorkspaceIdSpy } = await recallWith({
      hot,
      findRecallTierWindow
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(findRecallTierWindow).toHaveBeenCalledTimes(2);
    expect(findRecallTierWindow).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      limit: 500
    });
    expect(findRecallTierWindow).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      limit: 500,
      cursor: {
        created_at: hot[499]!.created_at,
        object_id: hot[499]!.object_id
      }
    });
    expect(findByWorkspaceIdSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("stops a HOT tier scan when the page source keeps returning full unique pages", async () => {
    const findByWorkspaceId = vi.fn(async (
      _workspaceId: string,
      tier?: StorageTier,
      page?: { readonly limit: number; readonly offset: number }
    ) => {
      if ((tier ?? StorageTier.HOT) !== StorageTier.HOT || page === undefined) {
        return [];
      }
      return Array.from({ length: page.limit }, (_, index) =>
        createMemoryEntry({
          object_id: `hot-${page.offset + index}`,
          activation_score: 0.9,
          storage_tier: StorageTier.HOT
        })
      );
    });

    const { findByWorkspaceIdSpy, warnSpy } = await recallWith({ findByWorkspaceId }, 1);
    const hotCalls = findByWorkspaceIdSpy.mock.calls.filter(
      (call) => call[1] === StorageTier.HOT
    );

    expect(hotCalls).toHaveLength(200);
    expect(warnSpy).toHaveBeenCalledWith(
      "recall memory repo page scan reached the maximum page count",
      expect.objectContaining({
        workspace_id: "workspace-1",
        tier: StorageTier.HOT,
        pages_loaded: 200
      })
    );
  }, 30_000);

  it("uses WARM once and keeps cascade decay in the fusion input diagnostic", async () => {
    const baseline = await recallWith({
      hot: [createMemoryEntry({ object_id: "candidate-0", activation_score: 0.8 })]
    });
    // Assert collectSupplementaryData runs exactly once on the cascade path.
    // The obsolete HOT-only assess used to call the spy MIN_RECALL_RESULTS
    // times, then the cascade-merged assess called it again. The HOT-only
    // assess is gone, so the spy is called exactly once per candidate on the
    // final merged filter.
    const cascadeGraphSpy = vi.fn(async () => 0);
    const warm = await recallWith({
      warm: Array.from({ length: 3 }, (_, index) =>
        createMemoryEntry({
          object_id: `candidate-${index}`,
          storage_tier: StorageTier.WARM,
          activation_score: 0.8
        })
      ),
      graphSupportPort: {
        countInboundSupports: cascadeGraphSpy,
        countInboundEdgesWeighted: cascadeGraphSpy
      }
    }, 3);

    expect(warm.findByWorkspaceIdSpy).toHaveBeenCalledTimes(2);
    expect(warm.findByWorkspaceIdSpy).toHaveBeenNthCalledWith(
      1,
      "workspace-1",
      StorageTier.HOT,
      expect.objectContaining({ offset: 0 })
    );
    expect(warm.findByWorkspaceIdSpy).toHaveBeenNthCalledWith(
      2,
      "workspace-1",
      StorageTier.WARM,
      expect.objectContaining({ offset: 0 })
    );
    // 3 WARM candidates merged through the final assess, no HOT-only assess.
    expect(cascadeGraphSpy).toHaveBeenCalledTimes(3);
    expect(warm.result.degradation_reason).toBe("warm_cascade_engaged");
    expect(warm.result.candidates).toHaveLength(3);
    const candidate = warm.result.candidates.find((entry) => entry.object_id === "candidate-0");
    expect(candidate?.source_channels).toContain("warm_cascade");
    const warmDiagnostic = warm.result.diagnostics?.candidates.find(
      (entry) => entry.object_id === "candidate-0"
    );
    expect(warmDiagnostic?.additive_score).toBeCloseTo(
      (baseline.result.diagnostics?.candidates[0]?.additive_score ?? 0) * WARM_CASCADE_DECAY
    );
    expect(candidate?.relevance_score).toBe(baseline.result.candidates[0]?.relevance_score);
  });

  it("uses COLD and keeps cascade decay in the fusion input diagnostic", async () => {
    const baseline = await recallWith({
      hot: [createMemoryEntry({ object_id: "candidate", activation_score: 0.8 })]
    });
    const cold = await recallWith({
      cold: [
        createMemoryEntry({
          object_id: "candidate",
          storage_tier: StorageTier.COLD,
          activation_score: 0.8
        })
      ]
    });

    expect(cold.findByWorkspaceIdSpy).toHaveBeenCalledTimes(3);
    expect(cold.findByWorkspaceIdSpy).toHaveBeenNthCalledWith(
      3,
      "workspace-1",
      StorageTier.COLD,
      expect.objectContaining({ offset: 0 })
    );
    expect(cold.result.degradation_reason).toBe("cold_cascade_engaged");
    expect(cold.result.candidates).toHaveLength(1);
    expect(cold.result.candidates[0]?.source_channels).toContain("cold_cascade");
    expect(cold.result.diagnostics?.candidates[0]?.additive_score).toBeCloseTo(
      (baseline.result.diagnostics?.candidates[0]?.additive_score ?? 0) * COLD_CASCADE_DECAY
    );
    expect(cold.result.candidates[0]?.relevance_score)
      .toBe(baseline.result.candidates[0]?.relevance_score);
  });

  it("does not touch COLD when HOT plus WARM reaches the threshold", async () => {
    const hot = Array.from({ length: 2 }, (_, index) =>
      createMemoryEntry({ object_id: `hot-${index}`, activation_score: 0.9 - index * 0.01 })
    );
    const warm = Array.from({ length: 4 }, (_, index) =>
      createMemoryEntry({
        object_id: `warm-${index}`,
        storage_tier: StorageTier.WARM,
        activation_score: 0.8 - index * 0.01
      })
    );

    const { result, findByWorkspaceIdSpy } = await recallWith({
      hot,
      warm,
      cold: Array.from({ length: 10 }, (_, index) =>
        createMemoryEntry({ object_id: `cold-${index}`, storage_tier: StorageTier.COLD })
      )
    });

    expect(findByWorkspaceIdSpy).toHaveBeenCalledTimes(2);
    expect(findByWorkspaceIdSpy.mock.calls.some((call) => call[1] === StorageTier.COLD)).toBe(false);
    expect(result.degradation_reason).toBe("warm_cascade_engaged");
    expect(result.candidates).toHaveLength(6);
  });

  it("includes WARM constraints through normal cascade when HOT is empty", async () => {
    const { result } = await recallWith({
      warm: [
        createMemoryEntry({
          object_id: "warm-constraint",
          storage_tier: StorageTier.WARM,
          dimension: MemoryDimension.CONSTRAINT,
          activation_score: 0.01
        })
      ]
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toContain("warm-constraint");
    expect(result.candidates.find((candidate) => candidate.object_id === "warm-constraint")?.source_channels).toContain("warm_cascade");
  });

  it("keeps cascade results inside max_entries budget", async () => {
    const { result } = await recallWith({
      warm: Array.from({ length: 10 }, (_, index) =>
        createMemoryEntry({
          object_id: `warm-${index}`,
          storage_tier: StorageTier.WARM,
          activation_score: 0.9 - index * 0.01
        })
      )
    }, 3);

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((candidate) => candidate.source_channels?.includes("warm_cascade"))).toBe(true);
  });

  it("applies project-mapping exclusions to cascaded non-project entries", async () => {
    const { result } = await recallWith({
      warm: [
        createMemoryEntry({
          object_id: "global-rejected",
          storage_tier: StorageTier.WARM,
          scope_class: ScopeClass.GLOBAL_DOMAIN,
          activation_score: 0.9
        }),
        createMemoryEntry({
          object_id: "project-warm",
          storage_tier: StorageTier.WARM,
          activation_score: 0.8
        })
      ],
      projectMappings: [
        createAnchor({
          object_id: "mapping-rejected",
          global_object_id: "global-rejected",
          mapping_state: ProjectMappingState.REJECTED
        })
      ]
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["project-warm"]);
  });
});
