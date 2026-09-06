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
    await plantNeedles(repo);
    const reader = new SqliteMemoryRecallReader(database);
    const interrupted = reader.lexical("workspace-1", "needle", 16, 0);
    expect(interrupted.ids).toEqual([]);
    expect(interrupted.truncated).toBe(true);
    expect(interrupted.nativeVisits).toBe(0);
    const during = reader.lexical("workspace-1", "needle", 16, 1);
    expect(during.ids).toEqual([]);
    expect(during.truncated).toBe(true);
    expect(during.nativeVisits).toBe(1);
    const empty = reader.lexical("workspace-1", "absent-token", 16);
    expect(empty.ids).toEqual([]);
    expect(empty.truncated).toBe(false);
  });
});

async function plantNeedles(
  repo: Awaited<ReturnType<typeof createRepo>>["repo"]
): Promise<readonly string[]> {
  const ids = Array.from({ length: 8 }, (_, index) =>
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
