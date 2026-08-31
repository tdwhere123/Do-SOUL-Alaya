import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageTier, type MemoryEntry, type RecallPolicy } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { runCoarseFilter } from "../../../recall/coarse-filter/coarse-filter.js";
import {
  queryHasObjectProbeSignal,
  scoreObjectProbeMatch
} from "../../../recall/coarse-filter/coarse-candidates.js";
import { scoreQueryEvidenceMatch } from "../../../recall/scoring/query-evidence-scoring.js";
import { compileRecallQueryProbes } from "../../../recall/query/recall-query-probes.js";
import { withKeywordFieldFixturePorts } from "../fixtures/keyword-field-fixture.js";
import {
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallRealStorage
} from "../../shared/real-sqlite.test-support.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../recall-service-test-fixtures.js";
import { RecallService } from "../../../recall/recall-service.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function activationOnlyConfig(base: Readonly<RecallPolicy>["coarse_filter"]): Readonly<RecallPolicy>["coarse_filter"] {
  return {
    ...base,
    deterministic_match: {
      scope_filter: null,
      dimension_filter: null,
      domain_tag_filter: null
    },
    precomputed_rank: {
      max_candidates: 2,
      min_activation_score: null
    },
    semantic_supplement: {
      ...base.semantic_supplement,
      enabled: false,
      max_supplement: 0
    }
  };
}

function semanticConfig(base: Readonly<RecallPolicy>["coarse_filter"]): Readonly<RecallPolicy>["coarse_filter"] {
  return {
    ...base,
    deterministic_match: {
      scope_filter: null,
      dimension_filter: null,
      domain_tag_filter: null
    },
    precomputed_rank: {
      max_candidates: 2,
      min_activation_score: null
    },
    semantic_supplement: {
      ...base.semantic_supplement,
      enabled: true,
      max_supplement: 8,
      embedding_enabled: false
    }
  };
}

function defaultCoarseFilter(): Readonly<RecallPolicy>["coarse_filter"] {
  const { dependencies } = createDependencies([]);
  return new RecallService(dependencies).buildDefaultPolicy(
    "chat",
    createTaskSurface().runtime_id
  ).coarse_filter;
}

function catalogFindByIds(entries: readonly Readonly<MemoryEntry>[]) {
  const catalog = new Map(entries.map((entry) => [entry.object_id, entry]));
  return vi.fn(async (_workspaceId: string, objectIds: readonly string[]) =>
    objectIds.flatMap((objectId) => {
      const entry = catalog.get(objectId);
      return entry === undefined ? [] : [entry];
    })
  );
}

describe("field-scoped coarse hydrate", () => {
  it("loads activation via SQL top-K and does not page HOT through findByWorkspaceId or findRecallTierWindow", async () => {
    const activation = createMemoryEntry({
      object_id: "00000001-1111-4111-8111-111111111111",
      activation_score: 0.95,
      content: "activation candidate"
    });
    const hotNoise = createMemoryEntry({
      object_id: "00000002-1111-4111-8111-111111111111",
      activation_score: 0.01,
      content: "unrelated hot row"
    });
    const { dependencies, warnSpy } = createDependencies([activation, hotNoise]);
    const findByWorkspaceId = vi.fn(async () => [activation, hotNoise]);
    const findRecallTierWindow = vi.fn(async () => ({
      memories: [activation, hotNoise],
      next_cursor: undefined,
      truncated: false
    }));
    const findRecallActivationTopK = vi.fn(async () => [activation]);
    const findByIds = catalogFindByIds([activation, hotNoise]);
    const result = await runCoarseFilter({
      dependencies: {
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          findByWorkspaceId,
          findRecallTierWindow,
          findByIds,
          findRecallActivationTopK
        }
      },
      warn: warnSpy
    }, "workspace-1", activationOnlyConfig(defaultCoarseFilter()), null);

    expect(findByWorkspaceId).not.toHaveBeenCalled();
    expect(findRecallTierWindow).not.toHaveBeenCalled();
    expect(findRecallActivationTopK).toHaveBeenCalled();
    expect(result.candidates.map((candidate) => candidate.entry.object_id)).toEqual([
      activation.object_id
    ]);
    expect(result.total_scanned).toBe(1);
  });

  it("does not admit a HOT-only object-probe/query-evidence/session-cohort JS-scan match that FTS, activation, and graph never returned", async () => {
    const activation = createMemoryEntry({
      object_id: "0000000a-1111-4111-8111-111111111111",
      activation_score: 0.95,
      surface_id: "surface-other",
      run_id: "run-other",
      content: "unrelated activation body"
    });
    const hotOnly = createMemoryEntry({
      object_id: "0000000b-1111-4111-8111-111111111111",
      activation_score: 0.01,
      surface_id: "surface-target",
      run_id: "run-target",
      content: "uniquejsscantoken lives only in HOT"
    });
    const queryProbes = {
      ...compileRecallQueryProbes("uniquejsscantoken inside surface-target during run-target"),
      surface_ids: ["surface-target"],
      run_ids: ["run-target"]
    };
    expect(queryHasObjectProbeSignal(queryProbes)).toBe(true);
    expect(scoreObjectProbeMatch(hotOnly, queryProbes)).toBeGreaterThan(0);
    expect(scoreQueryEvidenceMatch(hotOnly, queryProbes)).toBeGreaterThan(0);

    const { dependencies, warnSpy } = createDependencies([activation, hotOnly]);
    const findByWorkspaceId = vi.fn(async () => [activation, hotOnly]);
    const findRecallTierWindow = vi.fn(async () => ({
      memories: [activation, hotOnly],
      next_cursor: undefined,
      truncated: false
    }));
    const result = await runCoarseFilter({
      dependencies: withKeywordFieldFixturePorts({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          findByWorkspaceId,
          findRecallTierWindow,
          findByIds: catalogFindByIds([activation, hotOnly]),
          findRecallActivationTopK: vi.fn(async () => [activation]),
          searchByKeyword: vi.fn(async () => []),
          searchByKeywordWithinTier: vi.fn(async () => []),
          searchByKeywordWithinObjectIds: vi.fn(async () => [])
        }
      }),
      warn: warnSpy
    }, "workspace-1", semanticConfig(defaultCoarseFilter()), "uniquejsscantoken inside surface-target during run-target", {
      queryProbes
    });

    expect(findByWorkspaceId).not.toHaveBeenCalled();
    expect(findRecallTierWindow).not.toHaveBeenCalled();
    const admittedIds = result.candidates.map((candidate) => candidate.entry.object_id);
    expect(admittedIds).toContain(activation.object_id);
    expect(admittedIds).not.toContain(hotOnly.object_id);
  });

  it("paged HOT path still admits the same JS-scan match when findByIds and findRecallActivationTopK are absent", async () => {
    const activation = createMemoryEntry({
      object_id: "0000000a-1111-4111-8111-111111111111",
      activation_score: 0.95,
      surface_id: "surface-other",
      run_id: "run-other",
      content: "unrelated activation body"
    });
    const hotOnly = createMemoryEntry({
      object_id: "0000000b-1111-4111-8111-111111111111",
      activation_score: 0.01,
      surface_id: "surface-target",
      run_id: "run-target",
      content: "uniquejsscantoken lives only in HOT"
    });
    const queryProbes = {
      ...compileRecallQueryProbes("uniquejsscantoken inside surface-target during run-target"),
      surface_ids: ["surface-target"],
      run_ids: ["run-target"]
    };
    const { dependencies, warnSpy } = createDependencies([activation, hotOnly]);
    const result = await runCoarseFilter({
      dependencies,
      warn: warnSpy
    }, "workspace-1", semanticConfig(defaultCoarseFilter()), "uniquejsscantoken inside surface-target during run-target", {
      queryProbes
    });

    expect(result.candidates.map((candidate) => candidate.entry.object_id)).toContain(
      hotOnly.object_id
    );
  });

  it("admits a query object_id pointer via findByIds without paging HOT", async () => {
    const activation = createMemoryEntry({
      object_id: "0000000a-1111-4111-8111-111111111111",
      activation_score: 0.95,
      content: "unrelated activation body"
    });
    const pointer = createMemoryEntry({
      object_id: "0000000c-1111-4111-8111-111111111111",
      activation_score: 0.01,
      content: "named by query object id only"
    });
    const queryProbes = {
      ...compileRecallQueryProbes("point at a known memory"),
      object_ids: [pointer.object_id]
    };
    const { dependencies, warnSpy } = createDependencies([activation, pointer]);
    const findByWorkspaceId = vi.fn(async () => [activation, pointer]);
    const findRecallTierWindow = vi.fn(async () => ({
      memories: [activation, pointer],
      next_cursor: undefined,
      truncated: false
    }));
    const findByIds = catalogFindByIds([activation, pointer]);
    const result = await runCoarseFilter({
      dependencies: withKeywordFieldFixturePorts({
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          findByWorkspaceId,
          findRecallTierWindow,
          findByIds,
          findRecallActivationTopK: vi.fn(async () => [activation]),
          searchByKeyword: vi.fn(async () => []),
          searchByKeywordWithinTier: vi.fn(async () => []),
          searchByKeywordWithinObjectIds: vi.fn(async () => [])
        }
      }),
      warn: warnSpy
    }, "workspace-1", semanticConfig(defaultCoarseFilter()), "point at a known memory", {
      queryProbes
    });

    expect(findByWorkspaceId).not.toHaveBeenCalled();
    expect(findRecallTierWindow).not.toHaveBeenCalled();
    expect(findByIds).toHaveBeenCalled();
    expect(result.candidates.map((candidate) => candidate.entry.object_id)).toEqual(
      expect.arrayContaining([activation.object_id, pointer.object_id])
    );
  });

  it("pages HOT when SQL activation top-K throws so the activation plane is not silently empty", async () => {
    const activation = createMemoryEntry({
      object_id: "00000001-1111-4111-8111-111111111111",
      activation_score: 0.95,
      content: "activation candidate"
    });
    const hotNoise = createMemoryEntry({
      object_id: "00000002-1111-4111-8111-111111111111",
      activation_score: 0.01,
      content: "unrelated hot row"
    });
    const { dependencies, warnSpy } = createDependencies([activation, hotNoise]);
    const findByWorkspaceId = vi.fn(async () => [activation, hotNoise]);
    const findRecallTierWindow = vi.fn(async () => ({
      memories: [activation, hotNoise],
      next_cursor: undefined,
      truncated: false
    }));
    const findRecallActivationTopK = vi.fn(async () => {
      throw new Error("sql top-K failed");
    });
    const result = await runCoarseFilter({
      dependencies: {
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          findByWorkspaceId,
          findRecallTierWindow,
          findByIds: catalogFindByIds([activation, hotNoise]),
          findRecallActivationTopK
        }
      },
      warn: warnSpy
    }, "workspace-1", activationOnlyConfig(defaultCoarseFilter()), null);

    expect(findRecallActivationTopK).toHaveBeenCalled();
    expect(findRecallTierWindow).toHaveBeenCalled();
    expect(result.candidates.map((candidate) => candidate.entry.object_id)).toContain(
      activation.object_id
    );
    expect(result.total_scanned).toBe(2);
  });

  it("does not admit a SQL activation row that is tombstoned or dormant", async () => {
    const tombstoned = createMemoryEntry({
      object_id: "0000000d-1111-4111-8111-111111111111",
      activation_score: 0.99,
      retention_state: "tombstoned",
      content: "tombstoned activation"
    });
    const dormant = createMemoryEntry({
      object_id: "0000000e-1111-4111-8111-111111111111",
      activation_score: 0.98,
      lifecycle_state: "dormant",
      content: "dormant activation"
    });
    const { dependencies, warnSpy } = createDependencies([tombstoned, dormant]);
    const findByWorkspaceId = vi.fn(async () => [tombstoned, dormant]);
    const findRecallTierWindow = vi.fn(async () => ({
      memories: [tombstoned, dormant],
      next_cursor: undefined,
      truncated: false
    }));
    const result = await runCoarseFilter({
      dependencies: {
        ...dependencies,
        memoryRepo: {
          ...dependencies.memoryRepo,
          findByWorkspaceId,
          findRecallTierWindow,
          findByIds: catalogFindByIds([tombstoned, dormant]),
          findRecallActivationTopK: vi.fn(async () => [tombstoned, dormant])
        }
      },
      warn: warnSpy
    }, "workspace-1", activationOnlyConfig(defaultCoarseFilter()), null);

    expect(findByWorkspaceId).not.toHaveBeenCalled();
    expect(findRecallTierWindow).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.total_scanned).toBe(0);
  });
});

describe("field-scoped coarse hydrate real sqlite", () => {
  it("hydrates an FTS-only HOT row without paging the HOT window", async () => {
    const { memoryEntryRepo } = await createRecallRealStorage((database) => {
      databases.add(database);
    });
    const highA = createMemoryEntry({
      object_id: "10000001-1111-4111-8111-111111111111",
      content: "noise alpha procedure",
      activation_score: 0.99,
      created_at: "2026-03-20T00:00:01.000Z"
    });
    const highB = createMemoryEntry({
      object_id: "10000002-1111-4111-8111-111111111111",
      content: "noise beta procedure",
      activation_score: 0.98,
      created_at: "2026-03-20T00:00:02.000Z"
    });
    const ftsOnly = createMemoryEntry({
      object_id: "10000003-1111-4111-8111-111111111111",
      content: "uniqueftshydratetoken zebra",
      activation_score: 0.01,
      created_at: "2026-03-20T00:00:03.000Z"
    });
    await memoryEntryRepo.create(highA);
    await memoryEntryRepo.create(highB);
    await memoryEntryRepo.create(ftsOnly);

    const findByWorkspaceId = vi.spyOn(memoryEntryRepo, "findByWorkspaceId");
    const findRecallTierWindow = vi.spyOn(memoryEntryRepo, "findRecallTierWindow");
    const { dependencies, warnSpy } = createDependencies([]);
    const result = await runCoarseFilter({
      dependencies: {
        ...dependencies,
        memoryRepo: {
          findByWorkspaceId: memoryEntryRepo.findByWorkspaceId.bind(memoryEntryRepo),
          findByDimension: memoryEntryRepo.findByDimension.bind(memoryEntryRepo),
          findByScopeClass: memoryEntryRepo.findByScopeClass.bind(memoryEntryRepo),
          findByIds: memoryEntryRepo.findByIds.bind(memoryEntryRepo),
          findRecallActivationTopK: memoryEntryRepo.findRecallActivationTopK.bind(memoryEntryRepo),
          findRecallTierWindow: memoryEntryRepo.findRecallTierWindow.bind(memoryEntryRepo),
          searchByKeyword: memoryEntryRepo.searchByKeyword.bind(memoryEntryRepo),
          searchByKeywordWithinTier: memoryEntryRepo.searchByKeywordWithinTier.bind(memoryEntryRepo),
          searchByKeywordField: memoryEntryRepo.searchByKeywordField.bind(memoryEntryRepo)
        }
      },
      warn: warnSpy
    }, REAL_SQLITE_TEST_WORKSPACE_ID, semanticConfig(defaultCoarseFilter()), "uniqueftshydratetoken");

    expect(findByWorkspaceId).not.toHaveBeenCalled();
    expect(findRecallTierWindow).not.toHaveBeenCalled();
    expect(result.candidates.map((candidate) => candidate.entry.object_id)).toContain(
      ftsOnly.object_id
    );
  });
});
