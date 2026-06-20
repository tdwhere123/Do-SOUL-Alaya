import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  StorageTier
} from "@do-soul/alaya-protocol";
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

describe("SqliteMemoryEntryRepo filtering and updates", () => {
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

  it("caps default workspace/run/dimension lists and exposes explicit full-list methods", async () => {
    const { repo } = await createRepo();

    for (let index = 0; index < 501; index += 1) {
      await repo.create(
        createMemoryEntry({
          object_id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
          workspace_id: "workspace-1",
          run_id: "run-1",
          dimension: MemoryDimension.PREFERENCE,
          storage_tier: StorageTier.HOT
        })
      );
    }

    await expect(repo.findByWorkspaceId("workspace-1")).resolves.toHaveLength(500);
    await expect(repo.findByWorkspaceIdAll("workspace-1")).resolves.toHaveLength(501);
    await expect(repo.findByRunId("run-1")).resolves.toHaveLength(500);
    await expect(repo.findByRunIdAll("run-1")).resolves.toHaveLength(501);
    await expect(repo.findByDimension("workspace-1", MemoryDimension.PREFERENCE)).resolves.toHaveLength(500);
    await expect(repo.findByDimensionAll("workspace-1", MemoryDimension.PREFERENCE)).resolves.toHaveLength(501);
    await expect(repo.findByScopeClass("workspace-1", ScopeClass.PROJECT)).resolves.toHaveLength(500);
    await expect(repo.findByScopeClassAll("workspace-1", ScopeClass.PROJECT)).resolves.toHaveLength(501);
    await expect(repo.findByWorkspaceId("workspace-1", undefined, { limit: 501, offset: 0 })).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
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

  it("updates tier and access timestamps in the same mutable update", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      storage_tier: StorageTier.COLD,
      last_used_at: "2026-03-01T00:00:00.000Z",
      last_hit_at: "2026-03-01T00:00:00.000Z"
    });
    await repo.create(entry);

    const updated = await repo.update(entry.object_id, {
      storage_tier: StorageTier.HOT,
      last_used_at: "2026-03-21T03:30:00.000Z",
      last_hit_at: "2026-03-21T03:30:00.000Z",
      updated_at: "2026-03-21T03:30:00.000Z"
    });

    expect(updated.storage_tier).toBe(StorageTier.HOT);
    expect(updated.last_used_at).toBe("2026-03-21T03:30:00.000Z");
    expect(updated.last_hit_at).toBe("2026-03-21T03:30:00.000Z");
    expect(updated.updated_at).toBe("2026-03-21T03:30:00.000Z");
  });

  it("updates tier and access timestamps only in the requested workspace", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      storage_tier: StorageTier.COLD,
      last_used_at: "2026-03-01T00:00:00.000Z",
      last_hit_at: "2026-03-01T00:00:00.000Z"
    });
    await repo.create(entry);

    await expect(
      repo.updateScoped(entry.object_id, "workspace-2", {
        storage_tier: StorageTier.HOT,
        last_used_at: "2026-03-21T03:30:00.000Z",
        last_hit_at: "2026-03-21T03:30:00.000Z",
        updated_at: "2026-03-21T03:30:00.000Z"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.findById(entry.object_id)).resolves.toMatchObject({
      storage_tier: StorageTier.COLD,
      last_used_at: "2026-03-01T00:00:00.000Z",
      last_hit_at: "2026-03-01T00:00:00.000Z"
    });

    const updated = await repo.updateScoped(entry.object_id, "workspace-1", {
      storage_tier: StorageTier.HOT,
      last_used_at: "2026-03-21T03:30:00.000Z",
      last_hit_at: "2026-03-21T03:30:00.000Z",
      updated_at: "2026-03-21T03:30:00.000Z"
    });

    expect(updated.storage_tier).toBe(StorageTier.HOT);
    expect(updated.last_used_at).toBe("2026-03-21T03:30:00.000Z");
    expect(updated.last_hit_at).toBe("2026-03-21T03:30:00.000Z");
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


});
