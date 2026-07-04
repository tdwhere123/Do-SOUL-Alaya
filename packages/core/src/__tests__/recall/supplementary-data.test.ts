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
});

async function collectWith(params: {
  readonly candidates: Parameters<typeof collectSupplementaryData>[0]["candidates"];
  readonly graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]>;
  readonly warn?: RecallServiceDependencies["warn"];
}) {
  const { dependencies } = createDependencies([]);
  const service = new RecallService(dependencies);
  return await collectSupplementaryData({
    dependencies: {
      ...dependencies,
      graphSupportPort: params.graphSupportPort
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
    coarseEvidenceFtsRanks: {},
    coarseEvidenceFtsRanksPerRef: {},
    coarseSourceProximityScores: {},
    coarseSourceCohortKeys: {},
    coarseStructuralScores: {},
    coarseGraphExpansionScores: {},
    coarseEntitySeedScores: {},
    coarsePathExpansionScores: {},
    coarsePathSuppressionScores: {}
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
