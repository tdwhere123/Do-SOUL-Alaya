import { afterEach, describe, expect, it } from "vitest";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });
const fixture = () => createSourceBoundRecallFixture((database) => databases.add(database));
const request = () => ({ taskSurface: createTaskSurface(), workspaceId: "workspace-1",
  strategy: "analyze" as const, queryText: "deployment checklist" });

describe("RecallService real SQLite source delivery", () => {
  it("delivers every matching planted source with sufficient page budget across storage tiers", async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (const [offset, tier] of ["hot", "warm", "cold"].entries()) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(offset).padStart(12, "0")}`;
      ids.push(id);
      await f.writeMemory(id, "deployment checklist", "procedure");
      f.database.connection.prepare("UPDATE memory_entries SET storage_tier = ? WHERE object_id = ?").run(tier, id);
    }
    const result = await f.service.recall({ ...request(), pageBudget: 10 });
    expect(result.candidates.map((row) => row.object_id).sort()).toEqual(ids.sort());
    expect(result.candidates.every((row) => row.content_preview === "deployment checklist")).toBe(true);
  });

  it("bounds the structured page and retains continuation instead of imposing a rank cutoff", async () => {
    const f = await fixture();
    for (let index = 0; index < 6; index += 1) {
      await f.writeMemory(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
        "deployment checklist", "procedure");
    }
    const first = await f.service.recall({ ...request(), pageBudget: 2 });
    expect(first.index.entries).toHaveLength(2);
    expect(first.index.continuation).not.toBeNull();
    const next = await f.service.recall({ ...request(), pageBudget: 2, continuation: first.index.continuation });
    expect(next.index.snapshot_id).toBe(first.index.snapshot_id);
    expect(next.index.query_id).toBe(first.index.query_id);
    expect(next.index.entries).toHaveLength(2);
    expect(next.index.entries.some((entry) => first.index.entries.some((seen) =>
      seen.object_id === entry.object_id && seen.hypothesis_id === entry.hypothesis_id && seen.output_binding === entry.output_binding))).toBe(false);
  });

  it("does not expose a tombstone or turn an unrelated source into a matching result", async () => {
    const f = await fixture();
    await f.writeMemory("aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "deployment checklist", "procedure");
    f.database.connection.prepare("UPDATE memory_entries SET retention_state = 'tombstoned'").run();
    await f.writeMemory("aaaaaaaa-aaaa-4aaa-8aaa-000000000099", "unrelated volcanic ash", "fact");
    const result = await f.service.recall(request());
    expect(result.candidates).toEqual([]);
    expect(result.index.completeness.interpretation_coverage).not.toBe("complete");
  });
});
