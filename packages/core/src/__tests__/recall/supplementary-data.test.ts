import { describe, expect, it, vi } from "vitest";
import { RecallService, type RecallServiceDependencies } from "../../recall/recall-service.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  collectSupplementaryData,
  SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY
} from "../../recall/supplements/supplementary-data.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "./recall-service-test-fixtures.js";

describe("collectSupplementaryData", () => {
  // Coverage packing needs gist identity; diagnostics no longer gate the load.
  it("loads evidence gists for coverage selection even without diagnostic capture", async () => {
    const findByIds = vi.fn(async () => []);
    const candidate = createMemoryEntry({
      object_id: "memory-evidence",
      evidence_refs: ["evidence-1"]
    });

    await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      evidenceSearchPort: { searchByKeyword: vi.fn(async () => []), findByIds },
      coarseEvidenceFtsRanks: { [candidate.object_id]: 1 },
      coarseEvidenceFtsRanksPerRef: { "evidence-1": 1 }
    });

    expect(findByIds).toHaveBeenCalledWith("workspace-1", ["evidence-1"]);
    expect(findByIds).toHaveBeenCalledTimes(1);

    await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      evidenceSearchPort: { searchByKeyword: vi.fn(async () => []), findByIds },
      captureAnswerFeatures: true,
      coarseEvidenceFtsRanks: { [candidate.object_id]: 1 },
      coarseEvidenceFtsRanksPerRef: { "evidence-1": 1 }
    });

    // Still bounded to the evidence-FTS hit set (not every memory's full refs).
    expect(findByIds).toHaveBeenLastCalledWith("workspace-1", ["evidence-1"]);
    expect(findByIds).toHaveBeenCalledTimes(2);
  });

  it("bounds per-candidate graph support lookup concurrency", async () => {
    const candidates = Array.from({ length: SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY * 2 + 3 }, (_, index) =>
      createMemoryEntry({ object_id: `memory-${index}` })
    );
    let active = 0;
    let maxActive = 0;
    const graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]> = {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(1);
        active -= 1;
        return 1;
      })
    };

    await collectWith({ candidates, graphSupportPort });

    expect(graphSupportPort.countInboundEdgesWeighted).toHaveBeenCalledTimes(candidates.length);
    expect(maxActive).toBeLessThanOrEqual(SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY);
  });

  it("degrades a rejected graph support lookup to zero without failing recall supplements", async () => {
    const warn = vi.fn();
    const candidates = [
      createMemoryEntry({ object_id: "memory-ok" }),
      createMemoryEntry({ object_id: "memory-reject" })
    ];
    const graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]> = {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async (memoryId) => {
        if (memoryId === "memory-reject") {
          throw new Error("graph unavailable");
        }
        return 3;
      })
    };

    const result = await collectWith({ candidates, graphSupportPort, warn });

    expect(result.graphSupportCounts).toEqual({
      "memory-ok": 3,
      "memory-reject": 0
    });
    expect(warn).toHaveBeenCalledWith(
      "graph support lookup failed",
      expect.objectContaining({
        workspace_id: "workspace-1",
        memory_id: "memory-reject",
        error: "graph unavailable"
      })
    );
  });

  it("degrades a rejected recall edge count lookup to zero without failing recall supplements", async () => {
    const warn = vi.fn();
    const candidates = [
      createMemoryEntry({ object_id: "memory-ok" }),
      createMemoryEntry({ object_id: "memory-reject" })
    ];
    const graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]> = {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 0),
      countInboundRecalls: vi.fn(async (memoryId) => {
        if (memoryId === "memory-reject") {
          throw new Error("recalls unavailable");
        }
        return 7;
      })
    };

    const result = await collectWith({ candidates, graphSupportPort, warn });

    expect(result.recallsEdgeCount).toBe(7);
    expect(warn).toHaveBeenCalledWith(
      "recall edge count lookup failed",
      expect.objectContaining({
        workspace_id: "workspace-1",
        memory_id: "memory-reject",
        error: "recalls unavailable"
      })
    );
  });

  it("uses one bulk graph read for both supplementary metrics", async () => {
    const candidates = [
      createMemoryEntry({ object_id: "memory-a" }),
      createMemoryEntry({ object_id: "memory-b" })
    ];
    const countInboundEdgesWeighted = vi.fn(async () => 99);
    const countInboundRecalls = vi.fn(async () => 99);
    const bulkReceivers: unknown[] = [];
    const countInboundRecallMetricsByMemoryId = vi.fn(async function (this: unknown) {
      bulkReceivers.push(this);
      return new Map([
        ["memory-a", { weightedEdgeCount: 1.5, recallCount: 2 }],
        ["memory-b", { weightedEdgeCount: 0.3, recallCount: 1 }]
      ]);
    });
    const graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]> = {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted,
      countInboundRecalls,
      countInboundRecallMetricsByMemoryId
    };

    const result = await collectWith({ candidates, graphSupportPort });

    expect(countInboundRecallMetricsByMemoryId).toHaveBeenCalledTimes(1);
    expect(countInboundRecallMetricsByMemoryId).toHaveBeenCalledWith(
      ["memory-a", "memory-b"],
      "workspace-1"
    );
    expect(bulkReceivers).toEqual([graphSupportPort]);
    expect(countInboundEdgesWeighted).not.toHaveBeenCalled();
    expect(countInboundRecalls).not.toHaveBeenCalled();
    expect(result.graphSupportCounts).toEqual({
      "memory-a": 1.5,
      "memory-b": 0.3
    });
    expect(result.recallsEdgeCount).toBe(3);
  });

  it("preserves legacy graph results when the bulk read fails", async () => {
    const warn = vi.fn();
    const candidate = createMemoryEntry({ object_id: "memory-a" });
    const graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]> = {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 1.5),
      countInboundRecalls: vi.fn(async () => 2),
      countInboundRecallMetricsByMemoryId: vi.fn(async () => {
        throw new Error("bulk unavailable");
      })
    };

    const result = await collectWith({ candidates: [candidate], graphSupportPort, warn });

    expect(result.graphSupportCounts).toEqual({ "memory-a": 1.5 });
    expect(result.recallsEdgeCount).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "bulk graph metrics lookup failed; using legacy lookups",
      expect.objectContaining({
        workspace_id: "workspace-1",
        candidate_count: 1,
        operation: "bulk_graph_metrics_lookup",
        error: "bulk unavailable"
      })
    );
  });
});

async function collectWith(params: {
  readonly candidates: Parameters<typeof collectSupplementaryData>[0]["candidates"];
  readonly graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]>;
  readonly warn?: RecallServiceDependencies["warn"];
  readonly evidenceSearchPort?: RecallServiceDependencies["evidenceSearchPort"];
  readonly captureAnswerFeatures?: boolean;
  readonly coarseEvidenceFtsRanks?: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanksPerRef?: Readonly<Record<string, number>>;
}) {
  const { dependencies } = createDependencies([]);
  const service = new RecallService(dependencies);
  return await collectSupplementaryData({
    dependencies: {
      ...dependencies,
      graphSupportPort: params.graphSupportPort,
      evidenceSearchPort: params.evidenceSearchPort
    },
    warn: params.warn ?? (() => undefined),
    candidates: params.candidates,
    workspaceId: "workspace-1",
    runId: null,
    queryText: null,
    queryProbes: compileRecallQueryProbes(null),
    policy: service.buildDefaultPolicy("chat", createTaskSurface().runtime_id),
    coarseFtsRanks: {},
    coarseTrigramFtsRanks: {},
    coarseSynthesisFtsRanks: {},
    coarseEvidenceFtsRanks: params.coarseEvidenceFtsRanks ?? {},
    coarseEvidenceFtsRanksPerRef: params.coarseEvidenceFtsRanksPerRef ?? {},
    coarseSourceProximityScores: {},
    coarseSourceCohortKeys: {},
    coarseStructuralScores: {},
    coarseGraphExpansionScores: {},
    coarseEntitySeedScores: {},
    coarsePathExpansionScores: {},
    coarsePathSuppressionScores: {},
    captureAnswerFeatures: params.captureAnswerFeatures ?? false
  });
}

function emptyGraphSupportPort(): NonNullable<RecallServiceDependencies["graphSupportPort"]> {
  return {
    countInboundSupports: vi.fn(async () => 0),
    countInboundEdgesWeighted: vi.fn(async () => 0)
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
