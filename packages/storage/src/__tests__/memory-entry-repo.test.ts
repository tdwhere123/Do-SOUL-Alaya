import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteMemoryEntryRepo } from "../repos/memory-entry-repo.js";
import { SqliteRunRepo } from "../repos/run-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for all workspace commands.",
    domain_tags: ["tooling", "workflow"],
    evidence_refs: ["evidence-1", "evidence-2"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: null,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

describe("SqliteMemoryEntryRepo", () => {
  it("creates and loads a memory entry by id", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();

    await expect(repo.create(entry)).resolves.toEqual(entry);
    await expect(repo.findById(entry.object_id)).resolves.toEqual(entry);
  });

  it("finds memory entries by ids without duplicates and skips missing ids", async () => {
    const { repo } = await createRepo();
    const first = createMemoryEntry({
      object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
      run_id: "run-1"
    });
    const second = createMemoryEntry({
      object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
      run_id: "run-2",
      created_at: "2026-03-21T00:00:01.000Z",
      updated_at: "2026-03-21T00:00:01.000Z"
    });

    await repo.create(first);
    await repo.create(second);

    const rows = await repo.findByIds([second.object_id, "missing-memory", first.object_id, second.object_id]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.object_id).sort()).toEqual([first.object_id, second.object_id].sort());
  });

  it("returns hot-tier records by default in findByWorkspaceId", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.COLD,
        workspace_id: "workspace-1",
        run_id: "run-2"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1");
    expect(rows.map((row) => row.object_id)).toEqual(["7ab81ca8-9425-4e18-ad4a-81ab6406db55"]);
  });

  it("returns explicit cold-tier records when tier is provided", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "2501b5fa-3bc0-4759-a0da-219f805ef03f",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "6406be93-cfed-43d3-90ac-e287facc9ed4",
        storage_tier: StorageTier.COLD,
        workspace_id: "workspace-1",
        run_id: "run-2"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1", StorageTier.COLD);
    expect(rows.map((row) => row.object_id)).toEqual(["6406be93-cfed-43d3-90ac-e287facc9ed4"]);
  });

  it("returns explicit warm-tier records when tier is provided", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "2501b5fa-3bc0-4759-a0da-219f805ef03f",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9",
        storage_tier: StorageTier.WARM,
        workspace_id: "workspace-1",
        run_id: "run-2"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1", StorageTier.WARM);
    expect(rows.map((row) => row.object_id)).toEqual(["4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9"]);
  });

  it("excludes tombstoned rows when explicit HOT tier is requested", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1",
        retention_state: null
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-2",
        retention_state: "tombstoned"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1", StorageTier.HOT);
    expect(rows.map((row) => row.object_id)).toEqual(["7ab81ca8-9425-4e18-ad4a-81ab6406db55"]);
  });

  it("excludes tombstoned rows when non-hot tiers are requested", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9",
        storage_tier: StorageTier.WARM,
        workspace_id: "workspace-1",
        run_id: "run-1",
        retention_state: null
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.COLD,
        workspace_id: "workspace-1",
        run_id: "run-2",
        retention_state: "tombstoned"
      })
    );

    const warmRows = await repo.findByWorkspaceId("workspace-1", StorageTier.WARM);
    const coldRows = await repo.findByWorkspaceId("workspace-1", StorageTier.COLD);
    expect(warmRows.map((row) => row.object_id)).toEqual(["4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9"]);
    expect(coldRows).toEqual([]);
  });

  it("lists entries by run id across both tiers", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "5b32be7d-dfc7-4746-9c7d-d70c6d8f8193",
        run_id: "run-1",
        storage_tier: StorageTier.HOT
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "89debe8f-cf95-4304-8a04-77f44e40be8e",
        run_id: "run-1",
        storage_tier: StorageTier.COLD,
        created_at: "2026-03-21T00:00:01.000Z",
        updated_at: "2026-03-21T00:00:01.000Z"
      })
    );

    const rows = await repo.findByRunId("run-1");
    expect(rows.map((row) => row.object_id)).toEqual([
      "5b32be7d-dfc7-4746-9c7d-d70c6d8f8193",
      "89debe8f-cf95-4304-8a04-77f44e40be8e"
    ]);
  });

  it("filters by dimension for hot-tier workspace records", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "f8f8ad43-f5a5-4d9e-ad2f-0133dba13c53",
        workspace_id: "workspace-1",
        run_id: "run-1",
        dimension: MemoryDimension.PREFERENCE,
        storage_tier: StorageTier.HOT
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "0bf75435-4c30-4fd1-aaf0-f005f00c88e0",
        workspace_id: "workspace-1",
        run_id: "run-2",
        dimension: MemoryDimension.CONSTRAINT,
        storage_tier: StorageTier.HOT
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "a3ab8a66-fb28-4f54-bc77-5b6a18144d82",
        workspace_id: "workspace-1",
        run_id: "run-2",
        dimension: MemoryDimension.PREFERENCE,
        storage_tier: StorageTier.COLD
      })
    );

    const rows = await repo.findByDimension("workspace-1", MemoryDimension.PREFERENCE);
    expect(rows.map((row) => row.object_id)).toEqual(["f8f8ad43-f5a5-4d9e-ad2f-0133dba13c53"]);
  });

  it("filters by scope class for hot-tier workspace records", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "88a0ec01-9d8a-4c89-a63b-32a07b4d8442",
        workspace_id: "workspace-1",
        run_id: "run-1",
        scope_class: ScopeClass.PROJECT,
        storage_tier: StorageTier.HOT
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "b5c41156-37f4-4ca5-87ec-00e6bd970744",
        workspace_id: "workspace-1",
        run_id: "run-1",
        scope_class: ScopeClass.GLOBAL_CORE,
        storage_tier: StorageTier.HOT
      })
    );

    const rows = await repo.findByScopeClass("workspace-1", ScopeClass.PROJECT);
    expect(rows.map((row) => row.object_id)).toEqual(["88a0ec01-9d8a-4c89-a63b-32a07b4d8442"]);
  });

  it("updates mutable fields", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    const updated = await repo.update(entry.object_id, {
      content: "Always run pnpm build before commit.",
      domain_tags: ["build", "workflow"],
      evidence_refs: ["evidence-3"],
      storage_tier: StorageTier.COLD,
      updated_at: "2026-03-21T03:00:00.000Z"
    });

    expect(updated.content).toBe("Always run pnpm build before commit.");
    expect(updated.domain_tags).toEqual(["build", "workflow"]);
    expect(updated.evidence_refs).toEqual(["evidence-3"]);
    expect(updated.storage_tier).toBe(StorageTier.COLD);
    expect(updated.updated_at).toBe("2026-03-21T03:00:00.000Z");
  });

  it("updates dynamics fields", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    const updated = await repo.updateDynamics(
      entry.object_id,
      {
        activation_score: 0.7,
        retention_score: 0.8,
        manifestation_state: "full_eligible",
        last_used_at: "2026-03-21T05:00:00.000Z",
        last_hit_at: "2026-03-21T05:00:00.000Z",
        reinforcement_count: 3,
        contradiction_count: 1,
        superseded_by: "memory-2"
      },
      "2026-03-21T05:00:00.000Z"
    );

    expect(updated.activation_score).toBe(0.7);
    expect(updated.retention_score).toBe(0.8);
    expect(updated.manifestation_state).toBe("full_eligible");
    expect(updated.last_used_at).toBe("2026-03-21T05:00:00.000Z");
    expect(updated.last_hit_at).toBe("2026-03-21T05:00:00.000Z");
    expect(updated.reinforcement_count).toBe(3);
    expect(updated.contradiction_count).toBe(1);
    expect(updated.superseded_by).toBe("memory-2");
    expect(updated.updated_at).toBe("2026-03-21T05:00:00.000Z");
  });
  it("updates retention_state alongside dynamics fields", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    const updated = await repo.updateDynamics(
      entry.object_id,
      {
        activation_score: 0.7,
        retention_score: 0.8,
        manifestation_state: "full_eligible",
        retention_state: "canon"
      } as any,
      "2026-03-21T05:00:00.000Z"
    );

    expect(updated.retention_state).toBe("canon");
  });

  it("searches memory content through the FTS supplement index", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Implement recall via FTS keyword supplement."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "22222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Archive unused memories after decay."
      })
    );

    const matches = await (repo as any).searchByKeyword("workspace-1", "recall", 5);

    expect(matches).toEqual([
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111",
        normalized_rank: 1
      })
    ]);
  });

  it("normalizes bm25-ordered rows into a meaningful ordinal ladder", async () => {
    const { database, repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "99999999-1111-4111-8111-111111111111",
        content: "Stable review evidence needs exact witness lines."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "aaaaaaaa-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Stable review evidence matters, but exact witnesses matter more."
      })
    );

    const rawMatches = database.connection
      .prepare(
        `
          SELECT object_id, bm25(memory_content_fts) AS raw_rank
          FROM memory_content_fts
          WHERE workspace_id = ? AND memory_content_fts MATCH ?
          ORDER BY raw_rank ASC, object_id ASC
        `
      )
      .all("workspace-1", '"stable"') as Array<{ readonly object_id: string; readonly raw_rank: number }>;
    const normalizedMatches = await repo.searchByKeyword("workspace-1", "stable", 5);

    expect(normalizedMatches.map((match) => match.object_id)).toEqual(
      rawMatches.map((match) => match.object_id)
    );
    expect(normalizedMatches).toHaveLength(2);
    expect(normalizedMatches[0]!.normalized_rank).toBe(1);
    expect(normalizedMatches[1]!.normalized_rank).toBe(0.5);
  });

  it("restores short exact-token matches that trigram MATCH cannot satisfy", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "33333333-1111-4111-8111-111111111111",
        content: "Go build before review."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "44444444-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Rust build before review."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "55555555-3333-4333-8333-333333333333",
        run_id: "run-2",
        content: "Governance reviews need evidence."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "go", 5)).resolves.toEqual([
      {
        object_id: "33333333-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
  });

  it("can filter short-token keyword fallback results to a hot candidate set before the limit bites", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Go archive the oldest report."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "22222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Go prune the stale cache row."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "99999999-9999-4999-8999-999999999999",
        content: "Go keep the hot supplement candidate alive."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "go", 2)).resolves.toEqual([
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111"
      }),
      expect.objectContaining({
        object_id: "22222222-2222-4222-8222-222222222222"
      })
    ]);
    await expect(
      repo.searchByKeywordWithinObjectIds!(
        "workspace-1",
        "go",
        2,
        ["99999999-9999-4999-8999-999999999999"]
      )
    ).resolves.toEqual([
      {
        object_id: "99999999-9999-4999-8999-999999999999",
        normalized_rank: 1
      }
    ]);
  });

  it("excludes tombstoned hot rows from hot-tier recall and short-token keyword fallback", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Go keep the live recall candidate.",
        retention_state: null
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "22222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Go drop the tombstoned recall candidate.",
        retention_state: "tombstoned"
      })
    );

    await expect(repo.findByWorkspaceId("workspace-1")).resolves.toEqual([
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111"
      })
    ]);
    await expect(repo.searchByKeyword("workspace-1", "go", 5)).resolves.toEqual([
      {
        object_id: "11111111-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
    await expect(
      repo.searchByKeywordWithinObjectIds!(
        "workspace-1",
        "go",
        5,
        [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222"
        ]
      )
    ).resolves.toEqual([
      {
        object_id: "11111111-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
  });

  it("matches mid-token substrings after the trigram upgrade", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "55555555-1111-4111-8111-111111111111",
        content: "Canonicalization keeps memory lookup stable across review waves."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "66666666-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Stable reviews still need exact evidence."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "nicaliza", 5)).resolves.toEqual([
      {
        object_id: "55555555-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
  });

  it("matches CJK substrings through the trigram-backed FTS path", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "77777777-3333-4333-8333-333333333333",
        content: "请记住中文路径需要逐字保留，避免命名漂移。"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "88888888-4444-4444-8444-444444444444",
        run_id: "run-2",
        content: "英文路径在这个用例里不重要。"
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "路径需要", 5)).resolves.toEqual([
      {
        object_id: "77777777-3333-4333-8333-333333333333",
        normalized_rank: 1
      }
    ]);
  });

  it("restores short CJK span matches below the trigram boundary", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "99999999-3333-4333-8333-333333333333",
        content: "请记住路径规则必须逐字校验。"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "aaaaaaaa-4444-4444-8444-444444444444",
        run_id: "run-2",
        content: "这条规则与界面布局无关。"
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "路径", 5)).resolves.toEqual([
      {
        object_id: "99999999-3333-4333-8333-333333333333",
        normalized_rank: 1
      }
    ]);
  });

  it("sanitizes FTS special operators before searching", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "33333333-3333-4333-8333-333333333333",
        content: "Use the contentsecret fallback token for recall ranking."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "44444444-4444-4444-8444-444444444444",
        run_id: "run-2",
        content: "A plain secret token should not match the sanitized literal."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", 'content:secret*', 5)).resolves.toEqual([
      {
        object_id: "33333333-3333-4333-8333-333333333333",
        normalized_rank: 1
      }
    ]);
  });

  it("strips NUL bytes from keyword query tokens before FTS matching", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "bbbbbbbb-1111-4111-8111-111111111111",
        content: "The alphabeta token should survive NUL sanitization."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "cccccccc-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "The alpha token alone must not match the sanitized query."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "alpha\0beta", 5)).resolves.toEqual([
      {
        object_id: "bbbbbbbb-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
  });

  it("caps keyword query tokens before building an FTS MATCH expression", async () => {
    const { repo } = await createRepo();
    const boundedTokens = Array.from({ length: 32 }, (_, index) => `absent${index + 1}`);
    await repo.create(
      createMemoryEntry({
        object_id: "dddddddd-3333-4333-8333-333333333333",
        content: "The overlimitmatch token appears only past the bounded query token set."
      })
    );

    await expect(
      repo.searchByKeyword("workspace-1", `${boundedTokens.join(" ")} overlimitmatch`, 5)
    ).resolves.toEqual([]);
  });

  it("only treats retention_state tombstoned entries as GC-eligible", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "55555555-5555-4555-8555-555555555555",
        retention_state: "tombstoned",
        lifecycle_state: "active"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "66666666-6666-4666-8666-666666666666",
        run_id: "run-2",
        retention_state: "canon",
        lifecycle_state: "tombstone"
      })
    );

    await expect(repo.findTombstonedMemories("workspace-1")).resolves.toEqual([
      expect.objectContaining({
        object_id: "55555555-5555-4555-8555-555555555555"
      })
    ]);
    await expect(repo.hardDeleteTombstoned("66666666-6666-4666-8666-666666666666")).rejects.toMatchObject({
      name: "StorageError",
      code: "NOT_FOUND"
    });

    await expect(repo.hardDeleteTombstoned("55555555-5555-4555-8555-555555555555")).resolves.toBeUndefined();
    await expect(repo.findById("55555555-5555-4555-8555-555555555555")).resolves.toBeNull();
  });


  it("throws NOT_FOUND when updating dynamics for a missing entry", async () => {
    const { repo } = await createRepo();

    await expect(
      repo.updateDynamics(
        "missing-memory-id",
        {
          activation_score: 0.4,
          retention_score: 0.6,
          manifestation_state: "hint"
        },
        "2026-03-21T06:00:00.000Z"
      )
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "NOT_FOUND"
    });
  });

  it("archives an entry by setting lifecycle_state to archived", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    const archived = await repo.archive(entry.object_id, "2026-03-21T04:00:00.000Z");
    expect(archived.lifecycle_state).toBe("archived");
    expect(archived.updated_at).toBe("2026-03-21T04:00:00.000Z");
  });

  it("keeps all dynamics fields null in phase 1B", async () => {
    const { repo } = await createRepo();
    const created = await repo.create(createMemoryEntry());

    expect(created.activation_score).toBeNull();
    expect(created.retention_score).toBeNull();
    expect(created.manifestation_state).toBeNull();
    expect(created.retention_state).toBeNull();
    expect(created.decay_profile).toBeNull();
    expect(created.confidence).toBeNull();
    expect(created.last_used_at).toBeNull();
    expect(created.last_hit_at).toBeNull();
    expect(created.reinforcement_count).toBeNull();
    expect(created.contradiction_count).toBeNull();
    expect(created.superseded_by).toBeNull();
  });

  it("round-trips domain_tags and evidence_refs JSON fields", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      object_id: "4f5af11e-03be-4248-8a89-2180b99c7158",
      domain_tags: ["a", "b"],
      evidence_refs: ["e1", "e2", "e3"]
    });

    await repo.create(entry);
    const loaded = await repo.findById(entry.object_id);

    expect(loaded?.domain_tags).toEqual(["a", "b"]);
    expect(loaded?.evidence_refs).toEqual(["e1", "e2", "e3"]);
  });

  it("returns immutable entries", async () => {
    const { repo } = await createRepo();
    const created = await repo.create(createMemoryEntry());

    expect(() => {
      (created as any).content = "mutated";
    }).toThrow(TypeError);
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteMemoryEntryRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await workspaceRepo.create({
    workspace_id: "workspace-2",
    name: "workspace two",
    root_path: "/tmp/ws2",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });

  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await runRepo.create({
    run_id: "run-2",
    workspace_id: "workspace-1",
    title: "run two",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await runRepo.create({
    run_id: "run-3",
    workspace_id: "workspace-2",
    title: "run three",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return {
    database,
    repo: new SqliteMemoryEntryRepo(database)
  };
}
