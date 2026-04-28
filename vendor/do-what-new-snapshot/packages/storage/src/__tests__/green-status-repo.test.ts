import { afterEach, describe, expect, it } from "vitest";
import type { GreenStatus } from "@do-what/protocol";
import { initDatabase, type StorageDatabase } from "../db.js";
import { SqliteGreenStatusRepo } from "../repos/green-status-repo.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createGreenStatus(overrides: Partial<GreenStatus> = {}): GreenStatus {
  return {
    object_id: "9bc1a292-e9c2-47f9-9c6f-bf6b67c810f3",
    object_kind: "green_status",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-24T00:00:00.000Z",
    updated_at: "2026-03-24T00:00:00.000Z",
    created_by: "system",
    target_object_id: "d52ab1f4-bcb3-414e-a0d0-7099e491a652",
    target_object_kind: "memory_entry",
    green_state: "eligible",
    verification_basis: "active_verification",
    verified_by: "review",
    verified_at: "2026-03-24T00:00:00.000Z",
    valid_until: "2026-04-23T00:00:00.000Z",
    bound_surfaces: ["surface://repo/path.ts"],
    bound_scope_class: "project",
    revoke_reason: "none",
    last_transition_at: "2026-03-24T00:00:00.000Z",
    workspace_id: "workspace-1",
    ...overrides
  };
}

function createRepo() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return new SqliteGreenStatusRepo(database);
}

describe("SqliteGreenStatusRepo", () => {
  it("creates and finds records by target object id", async () => {
    const repo = createRepo();
    const greenStatus = createGreenStatus();

    await repo.upsert(greenStatus);

    await expect(repo.findByTargetObjectId(greenStatus.target_object_id)).resolves.toEqual(greenStatus);
  });

  it("replaces existing record for the same target object id", async () => {
    const repo = createRepo();
    const original = createGreenStatus();
    const replaced = createGreenStatus({
      object_id: "f8d69cae-df52-4df9-9147-d0fd1f998b8b",
      green_state: "grace",
      updated_at: "2026-03-25T00:00:00.000Z",
      last_transition_at: "2026-03-25T00:00:00.000Z"
    });

    await repo.upsert(original);
    await repo.upsert(replaced);

    await expect(repo.findByTargetObjectId(original.target_object_id)).resolves.toEqual(replaced);
    await expect(repo.findByObjectId(original.object_id)).resolves.toBeNull();
  });

  it("filters eligible and grace statuses", async () => {
    const repo = createRepo();
    await repo.upsert(createGreenStatus());
    await repo.upsert(
      createGreenStatus({
        object_id: "f8d69cae-df52-4df9-9147-d0fd1f998b8b",
        target_object_id: "638af57d-5586-4886-b5dd-20d67bf51f7d",
        green_state: "grace"
      })
    );
    await repo.upsert(
      createGreenStatus({
        object_id: "d2696bf9-79d9-4b61-89b4-f4bbd1deeea3",
        target_object_id: "ad2fb7c3-bc70-47c5-804e-cdf436c562d1",
        green_state: "revoked"
      })
    );

    await expect(repo.findEligible("workspace-1")).resolves.toHaveLength(1);
    await expect(repo.findGrace("workspace-1")).resolves.toHaveLength(1);
    await expect(repo.findByWorkspaceId("workspace-1")).resolves.toHaveLength(3);
  });

  it("deletes records", async () => {
    const repo = createRepo();
    const greenStatus = createGreenStatus();

    await repo.upsert(greenStatus);
    await repo.delete(greenStatus.object_id);

    await expect(repo.findByObjectId(greenStatus.object_id)).resolves.toBeNull();
  });

  it("wraps malformed bound_surfaces JSON in StorageError", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const repo = new SqliteGreenStatusRepo(database);

    database.connection
      .prepare(
        `INSERT INTO green_statuses (
          object_id,
          object_kind,
          schema_version,
          lifecycle_state,
          created_at,
          updated_at,
          created_by,
          target_object_id,
          target_object_kind,
          green_state,
          verification_basis,
          verified_by,
          verified_at,
          valid_until,
          bound_surfaces,
          bound_scope_class,
          revoke_reason,
          last_transition_at,
          workspace_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "9bc1a292-e9c2-47f9-9c6f-bf6b67c810f3",
        "green_status",
        1,
        "active",
        "2026-03-24T00:00:00.000Z",
        "2026-03-24T00:00:00.000Z",
        "system",
        "d52ab1f4-bcb3-414e-a0d0-7099e491a652",
        "memory_entry",
        "eligible",
        "active_verification",
        "review",
        "2026-03-24T00:00:00.000Z",
        "2026-04-23T00:00:00.000Z",
        "{not-json",
        "project",
        "none",
        "2026-03-24T00:00:00.000Z",
        "workspace-1"
      );

    await expect(repo.findByObjectId("9bc1a292-e9c2-47f9-9c6f-bf6b67c810f3")).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
  });
});
