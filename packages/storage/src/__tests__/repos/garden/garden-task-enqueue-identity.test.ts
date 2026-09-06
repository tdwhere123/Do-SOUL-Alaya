import { afterEach, describe, expect, it } from "vitest";
import { GardenRole, GardenTaskKind, GardenTier } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqliteGardenTaskRepo } from "../../../repos/garden/garden-task-repo.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("garden task enqueue identity", () => {
  it("coalesces equal identity and conflicts on mismatched payload", () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const repo = new SqliteGardenTaskRepo(database.connection, {
      appendManyWithMutation: async (_events, mutate) => mutate([])
    });
    const payload = {
      task_id: "source_enrich_1",
      task_kind: GardenTaskKind.BULK_ENRICH,
      required_tier: GardenTier.TIER_2,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_refs: ["mem-1"],
      priority: 20,
      created_at: "2026-09-06T00:00:00.000Z",
      source_object_id: "mem-1",
      source_revision: 1,
      enrichment_contract: "source_enrichment.v1"
    };
    expect(
      repo.enqueue({
        id: "source_enrich_1",
        workspace_id: "workspace-1",
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.BULK_ENRICH,
        payload,
        created_at: "2026-09-06T00:00:00.000Z"
      }).task_id
    ).toBe("source_enrich_1");
    expect(
      repo.enqueue({
        id: "source_enrich_1",
        workspace_id: "workspace-1",
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.BULK_ENRICH,
        payload: { ...payload, created_at: "2026-09-06T00:00:01.000Z", run_id: "run-2" },
        created_at: "2026-09-06T00:00:01.000Z"
      }).task_id
    ).toBe("source_enrich_1");
    expect(repo.peekPending(GardenRole.LIBRARIAN, "workspace-1", 8)).toHaveLength(1);
    expect(() =>
      repo.enqueue({
        id: "source_enrich_1",
        workspace_id: "workspace-1",
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.BULK_ENRICH,
        payload: { ...payload, source_object_id: "mem-other" },
        created_at: "2026-09-06T00:00:00.000Z"
      })
    ).toThrow(/different payload/);
  });
});
