import { describe, expect, it, vi } from "vitest";
import {
  MAX_TEMPORAL_RECALL_CANDIDATES,
  MemoryDimension,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createPreparedQueryHandle,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

function temporalMemory(objectId: string, eventDate: string) {
  return createMemoryEntry({
    object_id: objectId,
    dimension: MemoryDimension.FACT,
    content: "The parents attended the neighborhood concert together.",
    event_time_start: `${eventDate}T00:00:00.000Z`,
    event_time_end: `${eventDate}T23:59:59.999Z`
  });
}

function policyWithEmbedding(
  service: RecallService,
  embeddingEnabled: boolean,
  maxEntries?: number
): RecallPolicy {
  const base = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
  return overridePolicy(base, {
    coarse_filter: {
      ...base.coarse_filter,
      semantic_supplement: {
        ...base.coarse_filter.semantic_supplement,
        enabled: true,
        embedding_enabled: embeddingEnabled
      }
    },
    fine_assessment: {
      ...base.fine_assessment,
      budgets: {
        ...base.fine_assessment.budgets,
        max_entries: maxEntries ?? base.fine_assessment.budgets.max_entries
      }
    }
  });
}

describe("RecallService reference time", () => {
  it("merges relative-window supply with the ordinary candidate and keeps provenance", async () => {
    const unrelated = temporalMemory(
      "11111111-1111-4111-8111-111111111111",
      "2026-08-08"
    );
    const requested = temporalMemory(
      "99999999-9999-4999-8999-999999999999",
      "2026-08-15"
    );
    const { dependencies } = createDependencies([unrelated, requested]);
    const findByEventTimeWindow = vi.fn(async () => [requested]);
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      memoryRepo: { ...dependencies.memoryRepo, findByEventTimeWindow }
    });

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Who attended the neighborhood concert last Saturday?"
      },
      referenceTime: "2026-08-22T08:01:00.000Z",
      diagnosticCapture: "answer_features"
    });

    expect(findByEventTimeWindow).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      tier: "hot",
      startTime: "2026-08-15T00:00:00.000Z",
      endTime: "2026-08-15T23:59:59.999Z",
      limit: 30
    });
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toContain(requested.object_id);
    expect(result.candidates.filter((candidate) => candidate.object_id === requested.object_id))
      .toHaveLength(1);
    const admissionPlanes = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === requested.object_id
    )?.admission_planes;
    expect(admissionPlanes).toContain("temporal_window");
    expect(admissionPlanes?.some((plane) => plane !== "temporal_window")).toBe(true);
  });

  it("uses an absolute query window without requiring a reference time", async () => {
    const requested = temporalMemory(
      "99999999-9999-4999-8999-999999999999",
      "2026-08-15"
    );
    const { dependencies } = createDependencies([]);
    const findByEventTimeWindow = vi.fn(async () => [requested]);
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      memoryRepo: { ...dependencies.memoryRepo, findByEventTimeWindow }
    });

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Who attended the neighborhood concert on 2026-08-15?"
      },
      diagnosticCapture: "answer_features"
    });

    expect(findByEventTimeWindow).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      tier: "hot",
      startTime: "2026-08-15T00:00:00.000Z",
      endTime: "2026-08-15T23:59:59.999Z",
      limit: 30
    });
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toContain(requested.object_id);
  });

  it("does not read the event-time index without a resolved query window", async () => {
    const memory = temporalMemory(
      "11111111-1111-4111-8111-111111111111",
      "2026-08-15"
    );
    const { dependencies } = createDependencies([memory]);
    const findByEventTimeWindow = vi.fn(async () => [memory]);
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      memoryRepo: { ...dependencies.memoryRepo, findByEventTimeWindow }
    });

    await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Which neighborhood concert memory is relevant?"
      },
      referenceTime: "2026-08-22T08:01:00.000Z",
      diagnosticCapture: "answer_features"
    });

    expect(findByEventTimeWindow).not.toHaveBeenCalled();
  });

  it("keeps non-temporal candidate output unchanged when the temporal reader exists", async () => {
    const memory = temporalMemory(
      "11111111-1111-4111-8111-111111111111",
      "2026-08-15"
    );
    const controlDependencies = createDependencies([memory]).dependencies;
    const treatmentDependencies = createDependencies([memory]).dependencies;
    const findByEventTimeWindow = vi.fn(async () => [memory]);
    const control = await new RecallService(controlDependencies).recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface(),
      diagnosticCapture: "answer_features"
    });
    const treatment = await new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...treatmentDependencies,
      memoryRepo: { ...treatmentDependencies.memoryRepo, findByEventTimeWindow }
    }).recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface(),
      diagnosticCapture: "answer_features"
    });

    expect(findByEventTimeWindow).not.toHaveBeenCalled();
    expect(treatment.candidates).toEqual(control.candidates);
  });

  it("bounds a legal delivery budget before calling the storage reader", async () => {
    const requested = temporalMemory(
      "99999999-9999-4999-8999-999999999999",
      "2026-08-15"
    );
    const { dependencies } = createDependencies([]);
    const findByEventTimeWindow = vi.fn(async () => [requested]);
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      memoryRepo: { ...dependencies.memoryRepo, findByEventTimeWindow }
    });

    await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Who attended the neighborhood concert on 2026-08-15?"
      },
      policyOverride: policyWithEmbedding(
        service,
        false,
        MAX_TEMPORAL_RECALL_CANDIDATES + 25
      ),
      diagnosticCapture: "answer_features"
    });

    expect(findByEventTimeWindow).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_TEMPORAL_RECALL_CANDIDATES })
    );
  });

  it("reads the temporal window through the hot, warm, and cold tier cascade", async () => {
    const byTier = {
      hot: temporalMemory(
        "11111111-1111-4111-8111-111111111111",
        "2026-08-15"
      ),
      warm: {
        ...temporalMemory("22222222-2222-4222-8222-222222222222", "2026-08-15"),
        storage_tier: "warm" as const
      },
      cold: {
        ...temporalMemory("33333333-3333-4333-8333-333333333333", "2026-08-15"),
        storage_tier: "cold" as const
      }
    };
    const { dependencies } = createDependencies([]);
    const findByEventTimeWindow = vi.fn(async (
      query: { readonly tier: keyof typeof byTier }
    ) => [byTier[query.tier]]);
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      memoryRepo: { ...dependencies.memoryRepo, findByEventTimeWindow }
    });

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Who attended the neighborhood concert on 2026-08-15?"
      },
      diagnosticCapture: "answer_features"
    });

    expect(findByEventTimeWindow.mock.calls.map(([query]) => query.tier))
      .toEqual(["hot", "warm", "cold"]);
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(expect.arrayContaining(Object.values(byTier).map((entry) => entry.object_id)));
  });

  it("shares one deterministic temporal candidate budget across the tier cascade", async () => {
    const byTier = {
      hot: [
        temporalMemory("11111111-1111-4111-8111-111111111111", "2026-08-15"),
        temporalMemory("22222222-2222-4222-8222-222222222222", "2026-08-15")
      ],
      warm: [
        {
          ...temporalMemory("33333333-3333-4333-8333-333333333333", "2026-08-15"),
          storage_tier: "warm" as const
        },
        {
          ...temporalMemory("44444444-4444-4444-8444-444444444444", "2026-08-15"),
          storage_tier: "warm" as const
        }
      ],
      cold: [
        {
          ...temporalMemory("55555555-5555-4555-8555-555555555555", "2026-08-15"),
          storage_tier: "cold" as const
        },
        {
          ...temporalMemory("66666666-6666-4666-8666-666666666666", "2026-08-15"),
          storage_tier: "cold" as const
        }
      ]
    };
    const { dependencies } = createDependencies([]);
    const suppliedObjectIds: string[] = [];
    const findByEventTimeWindow = vi.fn(async (
      query: { readonly tier: keyof typeof byTier; readonly limit: number }
    ) => {
      const supplied = byTier[query.tier].slice(0, query.limit);
      suppliedObjectIds.push(...supplied.map((entry) => entry.object_id));
      return supplied;
    });
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      memoryRepo: { ...dependencies.memoryRepo, findByEventTimeWindow }
    });

    await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Who attended the neighborhood concert on 2026-08-15?"
      },
      policyOverride: policyWithEmbedding(service, false, 5),
      diagnosticCapture: "answer_features"
    });

    expect(findByEventTimeWindow.mock.calls.map(([query]) => ({
      tier: query.tier,
      limit: query.limit
    }))).toEqual([
      { tier: "hot", limit: 5 },
      { tier: "warm", limit: 3 },
      { tier: "cold", limit: 1 }
    ]);
    expect(suppliedObjectIds).toEqual([
      ...byTier.hot.map((entry) => entry.object_id),
      ...byTier.warm.map((entry) => entry.object_id),
      byTier.cold[0]!.object_id
    ]);
    expect(suppliedObjectIds).toHaveLength(5);
  });

  it("keeps temporal membership identical with embedding disabled and enabled", async () => {
    const requested = temporalMemory(
      "99999999-9999-4999-8999-999999999999",
      "2026-08-15"
    );
    const collectWorkspaceNeighbors = vi.fn(async () => []);
    const recall = async (embeddingEnabled: boolean) => {
      const { dependencies } = createDependencies([]);
      const findByEventTimeWindow = vi.fn(async () => [requested]);
      const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          findByIds: vi.fn(async () => []),
          findByEventTimeWindow
        },
        embeddingRecallService: {
          hasStoredVectors: vi.fn(async () => true),
          prepareQueryEmbedding: vi.fn(() => createPreparedQueryHandle("temporal-membership")),
          querySupplementIfReady: vi.fn(async () => ({
            supplementaryEntries: [],
            similarityHintsByObjectId: {}
          })),
          querySupplement: vi.fn(async () => ({
            supplementaryEntries: [],
            similarityHintsByObjectId: {}
          })),
          collectWorkspaceNeighbors
        }
      });
      const result = await service.recall({
        workspaceId: "workspace-1",
        strategy: "analyze",
        taskSurface: {
          ...createTaskSurface(),
          display_name: "Who attended the neighborhood concert on 2026-08-15?"
        },
        policyOverride: policyWithEmbedding(service, embeddingEnabled),
      diagnosticCapture: "answer_features"
    });
      return result.diagnostics?.candidates
        .filter((candidate) => candidate.admission_planes.includes("temporal_window"))
        .map((candidate) => candidate.object_id);
    };

    expect(await recall(false)).toEqual(await recall(true));
    expect(collectWorkspaceNeighbors).toHaveBeenCalledTimes(1);
  });

  it("uses the explicit reference time to rank the requested relative day", async () => {
    const distractor = temporalMemory("11111111-1111-4111-8111-111111111111", "2026-08-08");
    const requested = temporalMemory("99999999-9999-4999-8999-999999999999", "2026-08-15");
    const { dependencies } = createDependencies([distractor, requested]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Who attended the neighborhood concert last Saturday?"
      },
      referenceTime: "2026-08-22T08:01:00.000Z",
      diagnosticCapture: "answer_features"
    });

    expect(result.candidates[0]?.object_id).toBe(requested.object_id);
    const requestedDiagnostic = result.diagnostics?.fusion_breakdown.find(
      (candidate) => candidate.object_id === requested.object_id
    );
    expect(requestedDiagnostic?.per_axis_contribution?.temporal).toBe(1);
  });

  it("rejects an invalid explicit reference time", async () => {
    const { dependencies } = createDependencies([]);
    const service = new RecallService(dependencies);
    await expect(service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface(),
      referenceTime: "not-a-date",
      diagnosticCapture: "answer_features"
})).rejects.toThrow(/reference time/iu);
    await expect(service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: createTaskSurface(),
      referenceTime: "2026-08-23T00:30:00",
      diagnosticCapture: "answer_features"
})).rejects.toThrow(/timezone offset/iu);
  });

  it("uses the explicit fixed offset for relative calendar days", async () => {
    const previous = temporalMemory("11111111-1111-4111-8111-111111111111", "2026-08-15");
    const localPrevious = temporalMemory("99999999-9999-4999-8999-999999999999", "2026-08-22");
    const { dependencies } = createDependencies([previous, localPrevious]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Who attended the neighborhood concert last Saturday?"
      },
      referenceTime: "2026-08-23T00:30:00+08:00",
      diagnosticCapture: "answer_features"
    });

    expect(result.candidates[0]?.object_id).toBe(localPrevious.object_id);
  });

  it("threads an explicit reference time to every temporal path-dependent read", async () => {
    const first = temporalMemory("11111111-1111-4111-8111-111111111111", "2026-08-15");
    const second = temporalMemory("99999999-9999-4999-8999-999999999999", "2026-08-16");
    const { dependencies } = createDependencies([first, second]);
    const findByAnchors = vi.fn(async () => []);
    const getStrengthByMemoryId = vi.fn(async () => new Map<string, number>());
    const findActiveConstraints = vi.fn(async () => ({ constraints: [], total_count: 0 }));
    const countInboundEdgesWeighted = vi.fn(async () => 0);
    const countInboundRecalls = vi.fn(async () => 0);
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      pathExpansionPort: { findByAnchors },
      pathPlasticityPort: { getStrengthByMemoryId },
      activeConstraintsPort: { findActiveConstraints },
      graphSupportPort: {
        countInboundSupports: vi.fn(async () => 0),
        countInboundEdgesWeighted,
        countInboundRecalls
      }
    });
    const referenceTime = "2026-08-23T00:30:00+08:00";

    await service.recall({
      workspaceId: "workspace-1",
      strategy: "analyze",
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Which concert memory is relevant?"
      },
      referenceTime,
      diagnosticCapture: "answer_features"
    });

    expect(findByAnchors).toHaveBeenCalledWith(
      "workspace-1",
      expect.any(Array),
      { asOf: referenceTime }
    );
    expect(getStrengthByMemoryId).toHaveBeenCalledWith(
      "workspace-1",
      expect.any(Array),
      { asOf: referenceTime }
    );
    expect(findActiveConstraints).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      cap: null,
      asOf: referenceTime
    });
    expect(countInboundEdgesWeighted).toHaveBeenCalledWith(
      expect.any(String),
      "workspace-1",
      { asOf: referenceTime }
    );
    expect(countInboundRecalls).toHaveBeenCalledWith(
      expect.any(String),
      "workspace-1",
      { asOf: referenceTime }
    );
  });
});
