import { afterEach, describe, expect, it } from "vitest";
import { SqliteMemoryRecallReader } from "../../../../repos/memory-entry/reads/bounded-recall-reader.js";
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
      after = page.ids.at(-1) ?? after;
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

  it("emits a 32-row prefix of 40 matches and concatenates resume without skip or dup", async () => {
    const { database, repo } = await createRepo();
    const ids = await plantNeedles(repo, 40);
    const reader = new SqliteMemoryRecallReader(database);
    const first = reader.lexical("workspace-1", "needle", 32, 32);
    expect(first.ids).toEqual(ids.slice(0, 32));
    expect(first.truncated).toBe(true);
    const second = reader.lexical("workspace-1", "needle", 32, 32, first.ids.at(-1) ?? null);
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
