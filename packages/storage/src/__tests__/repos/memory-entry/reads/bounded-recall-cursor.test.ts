import { afterEach, describe, expect, it } from "vitest";
import {
  LEXICAL_RECALL_SQL,
  SqliteMemoryRecallReader
} from "../../../../repos/memory-entry/reads/bounded-recall-reader.js";
import { tokenizeFtsQuery } from "../../../../repos/memory-entry/reads/keyword-search.js";
import { buildWorkspaceScopedFtsMatch } from "../../../../repos/shared/fts-lane-routing.js";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "../memory-entry-repo-fixture.js";

afterEach(() => {
  for (const database of trackedDatabases) database.close();
  trackedDatabases.clear();
});

describe("SqliteMemoryRecallReader lexical cursor", () => {
  it("keeps the one-shot lexical page and concatenates advancing pages", async () => {
    const { database, repo } = await createRepo();
    const ids = await plantNeedles(repo);
    const reader = new SqliteMemoryRecallReader(database);
    const full = reader.lexical("workspace-1", "needle", 16);
    expect(full.ids).toEqual(ids);
    expect(full.truncated).toBe(false);
    const pages: string[] = [];
    let after: string | null = null;
    for (let step = 0; step < 8; step += 1) {
      const page = reader.lexical("workspace-1", "needle", 2, 512, after);
      pages.push(...page.ids);
      if (!page.truncated) break;
      after = page.committedThrough ?? after;
    }
    expect(pages).toEqual(full.ids);
    expect(pages).toEqual(ids);
  });

  it("reports a native zero-row interrupt as truncated, not a completed empty domain", async () => {
    const { database, repo } = await createRepo();
    const ids = await plantNeedles(repo);
    const reader = new SqliteMemoryRecallReader(database);
    const interrupted = reader.lexical("workspace-1", "needle", 16, 0);
    expect(interrupted.ids).toEqual([]);
    expect(interrupted.truncated).toBe(true);
    expect(interrupted.nativeVisits).toBe(0);
    const during = reader.lexical("workspace-1", "needle", 16, 1);
    expect(during.ids).toEqual([ids[0]]);
    expect(during.truncated).toBe(true);
    expect(during.nativeVisits).toBe(1);
    const empty = reader.lexical("workspace-1", "absent-token", 16);
    expect(empty.ids).toEqual([]);
    expect(empty.truncated).toBe(false);
  });

  it("nativeLimit=1 does not sort thousands of FTS matches", async () => {
    const { database } = await createRepo();
    const insert = database.connection.prepare(
      "INSERT INTO memory_content_fts_porter (object_id, workspace_id, content) VALUES (?, ?, ?)"
    );
    database.connection.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        insert.run(`id-${String(index).padStart(6, "0")}`, "workspace-1", "needle");
      }
    })();
    const reader = new SqliteMemoryRecallReader(database);
    const page = reader.lexical("workspace-1", "needle", 1, 1);
    expect(page.ids).toHaveLength(1);
    expect(page.nativeVisits).toBe(1);
    const match = buildWorkspaceScopedFtsMatch("workspace-1", tokenizeFtsQuery("needle"));
    const vm = database.connection.prepare(`EXPLAIN ${LEXICAL_RECALL_SQL}`)
      .all("workspace-1", match, 0, 1) as { opcode: string }[];
    const opcodes = vm.map((row) => row.opcode);
    expect(opcodes).not.toContain("Sort");
    expect(opcodes).not.toContain("IdxInsert");
  });

  it("distinguishes a missing source from an over-budget unavailable read", async () => {
    const { database, repo } = await createRepo();
    const reader = new SqliteMemoryRecallReader(database);
    reader.prepareIndex();
    const missing = reader.source("workspace-1", "aaaaaaaa-aaaa-4aaa-8aaa-000000000099");
    expect(missing.row).toBeNull();
    expect(missing.unavailable).toBe(false);
    await repo.create(createMemoryEntry({
      object_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000098",
      content: "hello world content that exceeds eight bytes"
    }));
    const oversized = reader.source("workspace-1", "aaaaaaaa-aaaa-4aaa-8aaa-000000000098", 8);
    expect(oversized.row).toBeNull();
    expect(oversized.unavailable).toBe(true);
    database.connection.prepare(`
      INSERT INTO memory_entries(
        object_id, object_kind, schema_version, workspace_id, run_id, created_by, dimension,
        source_kind, formation_kind, scope_class, content, domain_tags, evidence_refs,
        lifecycle_state, created_at, updated_at
      ) VALUES (
        'aaaaaaaa-aaaa-4aaa-8aaa-000000000097', 'memory_entry', 1, 'workspace-1', 'run-1',
        'user_action', 'fact', 'user', 'explicit', 'project', 'no revision yet', '[]', '[]',
        'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      )
    `).run();
    const noRevision = reader.source("workspace-1", "aaaaaaaa-aaaa-4aaa-8aaa-000000000097");
    expect(noRevision.row).toBeNull();
    expect(noRevision.unavailable).toBe(true);
  });

  it("emits a 32-row prefix of 40 matches and concatenates resume without skip or dup", async () => {
    const { database, repo } = await createRepo();
    const ids = await plantNeedles(repo, 40);
    const reader = new SqliteMemoryRecallReader(database);
    const first = reader.lexical("workspace-1", "needle", 32, 32);
    expect(first.ids).toEqual(ids.slice(0, 32));
    expect(first.truncated).toBe(true);
    const second = reader.lexical("workspace-1", "needle", 32, 32, first.committedThrough);
    expect(second.ids).toEqual(ids.slice(32));
    expect([...first.ids, ...second.ids]).toEqual(ids);
    expect(new Set([...first.ids, ...second.ids]).size).toBe(ids.length);
  });
});

async function plantNeedles(
  repo: Awaited<ReturnType<typeof createRepo>>["repo"],
  count = 8
): Promise<readonly string[]> {
  const ids = Array.from({ length: count }, (_, index) =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`
  );
  for (const [index, objectId] of ids.entries()) {
    await repo.create(createMemoryEntry({
      object_id: objectId,
      content: `needle item ${index + 1}`
    }));
  }
  return ids;
}
