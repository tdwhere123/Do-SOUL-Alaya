import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "../repos/memory-entry/memory-entry-repo-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("memory_entry_evidence_refs", () => {
  it("indexes evidence_refs from created memory entries", async () => {
    const { database, repo } = await createRepo();
    await repo.create(createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      evidence_refs: ["ev-1", "ev-2", "ev-1"]
    }));
    await repo.create(createMemoryEntry({
      object_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-2",
      evidence_refs: ["prefix-ev-1-suffix"]
    }));

    const indexedRows = database.connection
      .prepare(
        `SELECT memory_id, evidence_ref
         FROM memory_entry_evidence_refs
         ORDER BY memory_id ASC, evidence_ref ASC`
      )
      .all() as Array<{ readonly memory_id: string; readonly evidence_ref: string }>;
    expect(indexedRows).toEqual([
      { memory_id: "11111111-1111-4111-8111-111111111111", evidence_ref: "ev-1" },
      { memory_id: "11111111-1111-4111-8111-111111111111", evidence_ref: "ev-2" },
      { memory_id: "22222222-2222-4222-8222-222222222222", evidence_ref: "prefix-ev-1-suffix" }
    ]);

    const rows = await repo.findByEvidenceRefs("workspace-1", ["ev-1"]);
    expect(rows.map((row) => row.object_id)).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});
