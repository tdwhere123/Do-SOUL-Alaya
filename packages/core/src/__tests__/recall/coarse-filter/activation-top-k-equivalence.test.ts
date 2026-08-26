import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass, StorageTier } from "@do-soul/alaya-protocol";
import { SqliteMemoryEntryRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { compareMemoryEntriesForActivationAdmission } from "../../../recall/runtime/recall-service-helpers.js";
import {
  loadActivationAdmissionTopK,
  selectActivationAdmissionTopKFromWindow
} from
  "../../../recall/coarse-filter/selection/activation-admission-top-k.js";
import {
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallRealStorage
} from "../../shared/real-sqlite.test-support.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("SQL activation top-K vs HOT window lexical sort", () => {
  it("matches the top-K object id sequence of list-HOT-then-JS-sort on a sqlite fixture", async () => {
    const { memoryEntryRepo } = await createRecallRealStorage((database) => {
      databases.add(database);
    });
    await seedActivationFixture(memoryEntryRepo);

    const window = await memoryEntryRepo.findRecallTierWindow({
      workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID,
      tier: StorageTier.HOT,
      limit: 102_400
    });
    const jsTopK = selectActivationAdmissionTopKFromWindow(window.memories, 5)
      .map((entry) => entry.object_id);
    const sqlTopK = (await memoryEntryRepo.findRecallActivationTopK({
      workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID,
      tier: StorageTier.HOT,
      limit: 5
    })).map((entry) => entry.object_id);

    expect(sqlTopK).toEqual(jsTopK);
    expect(jsTopK.slice(0, 2)).toEqual([
      "00000004-1111-4111-8111-111111111111",
      "00000005-1111-4111-8111-111111111111"
    ]);
    expect(
      [...window.memories].sort(compareMemoryEntriesForActivationAdmission)
        .slice(0, 5)
        .map((entry) => entry.object_id)
    ).toEqual(sqlTopK);
  });

  it("applies min activation and excluded ids without changing the remaining rank order", async () => {
    const { memoryEntryRepo } = await createRecallRealStorage((database) => {
      databases.add(database);
    });
    await seedActivationFixture(memoryEntryRepo);

    const window = await memoryEntryRepo.findRecallTierWindow({
      workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID,
      tier: StorageTier.HOT,
      limit: 102_400
    });
    const excluded = new Set(["00000005-1111-4111-8111-111111111111"]);
    const jsTopK = selectActivationAdmissionTopKFromWindow(
      window.memories.filter((entry) =>
        !excluded.has(entry.object_id) && (entry.activation_score ?? 0) >= 0.4
      ),
      3
    ).map((entry) => entry.object_id);
    const sqlTopK = (await memoryEntryRepo.findRecallActivationTopK({
      workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID,
      tier: StorageTier.HOT,
      limit: 3,
      min_activation_score: 0.4,
      exclude_object_ids: [...excluded]
    })).map((entry) => entry.object_id);

    expect(sqlTopK).toEqual(jsTopK);
  });
});

describe("JS fallback activation-admission floor", () => {
  it("applies min_activation_score when SQL top-K is disabled", async () => {
    const low = createMemoryEntry({ object_id: "memory-low", activation_score: 0.1 });
    const high = createMemoryEntry({ object_id: "memory-high", activation_score: 0.9 });

    const selected = await loadActivationAdmissionTopK({
      memoryRepo: {
        findByWorkspaceId: async () => [],
        findByDimension: async () => [],
        findByScopeClass: async () => []
      },
      workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID,
      tier: StorageTier.HOT,
      config: {
        deterministic_match: {
          scope_filter: null,
          dimension_filter: null,
          domain_tag_filter: null
        },
        precomputed_rank: {
          max_candidates: 5,
          min_activation_score: 0.5
        },
        semantic_supplement: {
          enabled: false,
          max_supplement: 0
        }
      },
      eligible: [low, high],
      excludeObjectIds: new Set(),
      allowSql: false
    });

    expect(selected.map((entry) => entry.object_id)).toEqual(["memory-high"]);
  });

  it("warns with activation_topk_sql_fallback then uses the in-memory window", async () => {
    const high = createMemoryEntry({ object_id: "memory-high", activation_score: 0.9 });
    const warn = vi.fn();

    const selected = await loadActivationAdmissionTopK({
      memoryRepo: {
        findByWorkspaceId: async () => [],
        findByDimension: async () => [],
        findByScopeClass: async () => [],
        findRecallActivationTopK: async () => {
          throw new Error("sql unavailable");
        }
      },
      workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID,
      tier: StorageTier.HOT,
      config: {
        deterministic_match: {
          scope_filter: null,
          dimension_filter: null,
          domain_tag_filter: null
        },
        precomputed_rank: {
          max_candidates: 5,
          min_activation_score: 0.5
        },
        semantic_supplement: {
          enabled: false,
          max_supplement: 0
        }
      },
      eligible: [high],
      excludeObjectIds: new Set(),
      allowSql: true,
      warn
    });

    expect(selected.map((entry) => entry.object_id)).toEqual(["memory-high"]);
    expect(warn).toHaveBeenCalledWith("activation top-k sql fallback", expect.objectContaining({
      code: "activation_topk_sql_fallback",
      workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
      error: "sql unavailable"
    }));
  });
});

async function seedActivationFixture(repo: SqliteMemoryEntryRepo): Promise<void> {
  await Promise.all([
    repo.create(createMemoryEntry({
      object_id: "00000001-1111-4111-8111-111111111111",
      content: "alpha activation fixture",
      activation_score: 0.5,
      created_at: "2026-03-20T00:00:01.000Z"
    })),
    repo.create(createMemoryEntry({
      object_id: "00000002-1111-4111-8111-111111111111",
      content: "beta activation fixture",
      activation_score: 0.5,
      created_at: "2026-03-20T00:00:02.000Z"
    })),
    repo.create(createMemoryEntry({
      object_id: "00000003-1111-4111-8111-111111111111",
      content: "zeta activation fixture",
      activation_score: 0.5,
      created_at: "2026-03-20T00:00:03.000Z"
    })),
    repo.create(createMemoryEntry({
      object_id: "00000004-1111-4111-8111-111111111111",
      content: "alpha drift-stable activation fixture",
      activation_score: 0.9324999963147926,
      created_at: "2026-03-20T00:00:04.000Z"
    })),
    repo.create(createMemoryEntry({
      object_id: "00000005-1111-4111-8111-111111111111",
      content: "zebra drift-stable activation fixture",
      activation_score: 0.9324999985083684,
      created_at: "2026-03-20T00:00:05.000Z"
    })),
    repo.create(createMemoryEntry({
      object_id: "00000006-1111-4111-8111-111111111111",
      content: "low activation fixture",
      activation_score: 0.1,
      created_at: "2026-03-20T00:00:06.000Z"
    })),
    repo.create(createMemoryEntry({
      object_id: "00000007-1111-4111-8111-111111111111",
      content: "warm activation fixture",
      activation_score: 0.99,
      storage_tier: StorageTier.WARM
    })),
    repo.create(createMemoryEntry({
      object_id: "00000008-1111-4111-8111-111111111111",
      content: "dormant activation fixture",
      activation_score: 0.99,
      lifecycle_state: "dormant"
    })),
    repo.create(createMemoryEntry({
      object_id: "00000009-1111-4111-8111-111111111111",
      content: "scope dimension tie fixture",
      dimension: MemoryDimension.PREFERENCE,
      scope_class: ScopeClass.GLOBAL_DOMAIN,
      activation_score: 0.2
    }))
  ]);
}
