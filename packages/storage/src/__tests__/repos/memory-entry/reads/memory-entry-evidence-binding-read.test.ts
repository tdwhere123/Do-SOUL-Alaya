import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "../memory-entry-repo-fixture.js";

afterEach(() => {
  for (const database of trackedDatabases) {
    database.close();
  }
  trackedDatabases.clear();
});

describe("SqliteMemoryEntryRepo evidence binding reads", () => {
  it("finds bindings across active, dormant, and tombstoned memory states", async () => {
    const { repo } = await createRepo();
    await repo.create(createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      evidence_refs: ["evidence-active"]
    }));
    await repo.create(createMemoryEntry({
      object_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-2",
      lifecycle_state: "dormant",
      evidence_refs: ["evidence-dormant"]
    }));
    await repo.create(createMemoryEntry({
      object_id: "33333333-3333-4333-8333-333333333333",
      run_id: "run-2",
      retention_state: "tombstoned",
      evidence_refs: ["evidence-tombstoned"]
    }));

    await expect(repo.findBoundEvidenceRefs("workspace-1", [
      "evidence-active",
      "evidence-dormant",
      "evidence-tombstoned",
      "evidence-unbound"
    ])).resolves.toEqual([
      "evidence-active",
      "evidence-dormant",
      "evidence-tombstoned"
    ]);
  });

  it("does not truncate binding inputs", async () => {
    const { repo } = await createRepo();
    const boundRef = "evidence-bound-beyond-old-cap";
    await repo.create(createMemoryEntry({ evidence_refs: [boundRef] }));
    const input = [
      ...Array.from({ length: 1_100 }, (_unused, index) => `unbound-${index}`),
      boundRef
    ];

    await expect(repo.findBoundEvidenceRefs("workspace-1", input))
      .resolves.toEqual([boundRef]);
  });
});
