import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StorageTier} from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import {
  FIND_BY_EVIDENCE_REFS_INPUT_CAP,
  SqliteMemoryEntryRepo,
  type MemoryEntryRepoDiagnosticSink
} from "../../../repos/memory-entry/index.js";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "./memory-entry-repo-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteMemoryEntryRepo lifecycle search and reference queries", () => {
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

  it("archive rolls the archive update back when onArchived throws", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      object_id: "55555555-0000-4000-8000-000000000001",
      lifecycle_state: "active"
    });
    await repo.create(entry);
    const onArchived = vi.fn(() => {
      throw new Error("archive audit append failed mid-transaction");
    });

    await expect(
      repo.archive(entry.object_id, "2026-03-21T04:00:00.000Z", onArchived)
    ).rejects.toThrow(StorageError);

    expect(onArchived).toHaveBeenCalledTimes(1);
    expect((await repo.findById(entry.object_id))?.lifecycle_state).toBe("active");
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

  it("matches an English query through the porter word-stemmed FTS index", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "e1111111-1111-4111-8111-111111111111",
        content: "The team agreed to refactor the recall ranking pipeline."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "e2222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Governance reviews need durable evidence."
      })
    );

    // "agree" / "refactoring" only match via porter stemming of the stored
    // "agreed" / "refactor"; the trigram table cannot bridge these.
    // "agree" is a literal substring of stored "agreed", so the trigram lane
    // also hits and surfaces a trigram_rank alongside the porter rank.
    await expect(repo.searchByKeyword("workspace-1", "agree", 5)).resolves.toEqual([
      { object_id: "e1111111-1111-4111-8111-111111111111", normalized_rank: 1, trigram_rank: 1 }
    ]);
    // "refactoring" only bridges via porter stemming of stored "refactor";
    // the trigram lane cannot match it, so no trigram_rank is surfaced.
    await expect(repo.searchByKeyword("workspace-1", "refactoring", 5)).resolves.toEqual([
      { object_id: "e1111111-1111-4111-8111-111111111111", normalized_rank: 1 }
    ]);
  });

  it("matches a Chinese query through the trigram index in the dual-index setup", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "c1111111-1111-4111-8111-111111111111",
        content: "请记住中文路径需要逐字保留，避免命名漂移。"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "c2222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "英文路径在这个用例里不重要。"
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "中文路径", 5)).resolves.toEqual([
      { object_id: "c1111111-1111-4111-8111-111111111111", normalized_rank: 1, trigram_rank: 1 }
    ]);
  });

  it("routes a mixed Chinese-and-English query across both FTS indexes", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "d1111111-1111-4111-8111-111111111111",
        content: "The migration agreed to keep 中文路径 stable."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "d2222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "An unrelated note about deployment scripts."
      })
    );

    const matches = await repo.searchByKeyword("workspace-1", "agreed 中文路径", 5);
    expect(matches.map((match) => match.object_id)).toEqual([
      "d1111111-1111-4111-8111-111111111111"
    ]);
  });

  it("backfills the porter FTS index from rows that pre-date the porter table", async () => {
    const { database, repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "f1111111-1111-4111-8111-111111111111",
        content: "Indexing reconciliation collapses duplicated facts."
      })
    );

    // Simulate an existing database that pre-dates migration 077: drop the
    // porter table and its triggers, then re-run the migration's backfill +
    // trigger SQL. A correct migration must reindex the pre-existing row.
    database.connection.exec(`
      DROP TRIGGER IF EXISTS memory_content_fts_porter_ai;
      DROP TRIGGER IF EXISTS memory_content_fts_porter_ad;
      DROP TRIGGER IF EXISTS memory_content_fts_porter_au;
      DROP TABLE IF EXISTS memory_content_fts_porter;
    `);

    const migrationsDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../migrations"
    );
    const migrationSql = fs.readFileSync(
      path.join(migrationsDir, "077-memory-content-fts-dual.sql"),
      "utf8"
    );
    database.connection.exec(migrationSql);

    const porterRows = database.connection
      .prepare(
        `SELECT object_id FROM memory_content_fts_porter
         WHERE workspace_id = ? AND memory_content_fts_porter MATCH ?`
      )
      .all("workspace-1", '"duplicate"') as Array<{ readonly object_id: string }>;

    expect(porterRows.map((row) => row.object_id)).toEqual([
      "f1111111-1111-4111-8111-111111111111"
    ]);
  });

  it("keeps the porter FTS index live on delete and content update", async () => {
    const { database, repo } = await createRepo();
    const entry = await repo.create(
      createMemoryEntry({
        object_id: "a9999999-1111-4111-8111-111111111111",
        content: "The scheduler retried the stalled task."
      })
    );

    const porterMatch = (token: string): readonly string[] =>
      (
        database.connection
          .prepare(
            `SELECT object_id FROM memory_content_fts_porter
             WHERE workspace_id = ? AND memory_content_fts_porter MATCH ?`
          )
          .all("workspace-1", `"${token}"`) as Array<{ readonly object_id: string }>
      ).map((row) => row.object_id);

    expect(porterMatch("retry")).toEqual(["a9999999-1111-4111-8111-111111111111"]);

    await repo.update(entry.object_id, {
      content: "The scheduler cancelled the queued job.",
      updated_at: "2026-03-21T01:00:00.000Z"
    });
    expect(porterMatch("retry")).toEqual([]);
    expect(porterMatch("cancel")).toEqual(["a9999999-1111-4111-8111-111111111111"]);

    await repo.hardDeleteTombstoned(entry.object_id).catch(() => undefined);
    await repo.create(
      createMemoryEntry({
        object_id: "b9999999-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "A second deletable note about caching."
      })
    );
    database.connection
      .prepare("DELETE FROM memory_entries WHERE object_id = ?")
      .run("b9999999-2222-4222-8222-222222222222");
    expect(porterMatch("cach")).toEqual([]);
  });

  it("findBySharedDomainTags returns memories sharing >=1 tag, excludes zero-shared, is workspace-scoped, and dedupes", async () => {
    const { repo } = await createRepo();

    // shares one tag ("coffee") with the query.
    const sharesOne = createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      domain_tags: ["coffee", "beans"]
    });
    // shares two tags -- must still appear exactly once (dedupe across the
    // json_each expansion).
    const sharesTwo = createMemoryEntry({
      object_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-2",
      domain_tags: ["coffee", "tea"]
    });
    // shares zero tags -- excluded.
    const sharesNone = createMemoryEntry({
      object_id: "33333333-3333-4333-8333-333333333333",
      run_id: "run-2",
      domain_tags: ["kettle", "mug"]
    });
    // empty tag array -- json_each yields no rows, so excluded.
    const noTags = createMemoryEntry({
      object_id: "44444444-4444-4444-8444-444444444444",
      run_id: "run-1",
      domain_tags: []
    });
    // matching tag but a DIFFERENT workspace -- must not leak across scope.
    const otherWorkspace = createMemoryEntry({
      object_id: "55555555-5555-4555-8555-555555555555",
      workspace_id: "workspace-2",
      run_id: "run-3",
      domain_tags: ["coffee"]
    });

    await repo.create(sharesOne);
    await repo.create(sharesTwo);
    await repo.create(sharesNone);
    await repo.create(noTags);
    await repo.create(otherWorkspace);

    const rows = await repo.findBySharedDomainTags("workspace-1", ["coffee", "tea"]);
    const ids = rows.map((row) => row.object_id);

    // sharesOne + sharesTwo only; each once; no zero-shared, no empty-tag,
    // no cross-workspace leak.
    expect(ids).toEqual([sharesOne.object_id, sharesTwo.object_id]);
  });

  it("findBySharedDomainTags returns empty for an empty tag query", async () => {
    const { repo } = await createRepo();
    await repo.create(createMemoryEntry({ domain_tags: ["coffee"] }));

    await expect(repo.findBySharedDomainTags("workspace-1", [])).resolves.toEqual([]);
  });

  it("findBySharedDomainTags excludes cold-tier and tombstoned rows (matches findByWorkspaceId hot scope)", async () => {
    const { repo } = await createRepo();

    const hot = createMemoryEntry({
      object_id: "1a111111-1111-4111-8111-111111111111",
      storage_tier: StorageTier.HOT,
      domain_tags: ["coffee"]
    });
    const cold = createMemoryEntry({
      object_id: "2a222222-2222-4222-8222-222222222222",
      run_id: "run-2",
      storage_tier: StorageTier.COLD,
      domain_tags: ["coffee"]
    });
    const tombstoned = createMemoryEntry({
      object_id: "3a333333-3333-4333-8333-333333333333",
      run_id: "run-2",
      storage_tier: StorageTier.HOT,
      retention_state: "tombstoned",
      domain_tags: ["coffee"]
    });

    await repo.create(hot);
    await repo.create(cold);
    await repo.create(tombstoned);

    const rows = await repo.findBySharedDomainTags("workspace-1", ["coffee"]);
    expect(rows.map((row) => row.object_id)).toEqual([hot.object_id]);
  });

  it("findByEvidenceRefs warns at the input cap and stays fail-safe", async () => {
    const { database } = await createRepo();
    const diagnostics = vi.fn<MemoryEntryRepoDiagnosticSink>();
    const repo = new SqliteMemoryEntryRepo(database, diagnostics);

    // input over the cap -> ids beyond the cap are never queried (fail-safe),
    // and the warn-level diagnostic surfaces the over-cap input to operators.
    const overCap = Array.from(
      { length: FIND_BY_EVIDENCE_REFS_INPUT_CAP + 5 },
      (_unused, index) => `evidence-${index}`
    );
    await repo.findByEvidenceRefs("workspace-1", overCap);

    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledWith("memory evidence-ref lookup input truncated", {
      workspace_id: "workspace-1",
      input_count: FIND_BY_EVIDENCE_REFS_INPUT_CAP + 5,
      capped_count: FIND_BY_EVIDENCE_REFS_INPUT_CAP
    });
  });

  it("findByEvidenceRefs does not warn when the input is within the cap", async () => {
    const { database } = await createRepo();
    const diagnostics = vi.fn<MemoryEntryRepoDiagnosticSink>();
    const repo = new SqliteMemoryEntryRepo(database, diagnostics);

    await repo.findByEvidenceRefs("workspace-1", ["evidence-1", "evidence-2"]);

    expect(diagnostics).not.toHaveBeenCalled();
  });
});
