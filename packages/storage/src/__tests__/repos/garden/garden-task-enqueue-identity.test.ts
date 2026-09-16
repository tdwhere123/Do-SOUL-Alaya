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

  it("findByIdInWorkspace returns null for a task id owned by another workspace", () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const repo = new SqliteGardenTaskRepo(database.connection, {
      appendManyWithMutation: async (_events, mutate) => mutate([])
    });
    const payload = {
      task_id: "task-ws-1",
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
    repo.enqueue({
      id: "task-ws-1",
      workspace_id: "workspace-1",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.BULK_ENRICH,
      payload,
      created_at: "2026-09-06T00:00:00.000Z"
    });

    expect(repo.findById("task-ws-1")?.workspace_id).toBe("workspace-1");
    expect(repo.findByIdInWorkspace("task-ws-1", "workspace-1")?.id).toBe("task-ws-1");
    expect(repo.findByIdInWorkspace("task-ws-1", "workspace-2")).toBeNull();
  });

  it("completeWithEvents conflicts when the workspace does not own the claimed task", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const repo = new SqliteGardenTaskRepo(database.connection, {
      appendManyWithMutation: async (_events, mutate) => mutate([])
    });
    const payload = {
      task_id: "task-ws-complete",
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
    repo.enqueue({
      id: "task-ws-complete",
      workspace_id: "workspace-1",
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.BULK_ENRICH,
      payload,
      created_at: "2026-09-06T00:00:00.000Z"
    });
    await expect(
      repo.claimAtomic("task-ws-complete", "worker-a", "2026-09-06T00:00:01.000Z")
    ).resolves.toBe("claimed");

    await expect(
      repo.completeWithEvents(
        "task-ws-complete",
        { status: "completed", completed_at: "2026-09-06T00:00:02.000Z" },
        [],
        "worker-a",
        "workspace-2"
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(repo.findById("task-ws-complete")).toMatchObject({
      status: "claimed",
      claimed_by: "worker-a",
      workspace_id: "workspace-1"
    });

    await repo.completeWithEvents(
      "task-ws-complete",
      { status: "completed", completed_at: "2026-09-06T00:00:03.000Z" },
      [],
      "worker-a",
      "workspace-1"
    );
    expect(repo.findById("task-ws-complete")).toMatchObject({
      status: "completed",
      claimed_by: "worker-a",
      workspace_id: "workspace-1"
    });
  });
});
