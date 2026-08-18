import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqlitePathPlasticityWatermarkRepo } from "../../../repos/path/path-plasticity-watermark-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("SqlitePathPlasticityWatermarkRepo", () => {
  it("persists per-workspace watermarks", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const repo = new SqlitePathPlasticityWatermarkRepo(database);
    await workspaceRepo.create({
      workspace_id: "workspace-1",
      name: "Watermark Workspace",
      root_path: "/tmp/watermark",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    const migration = database.connection
      .prepare("SELECT MAX(version) AS version FROM schema_version")
      .get() as { readonly version: number } | undefined;
    expect(migration?.version).toBe(8);

    expect(repo.findByWorkspaceId("workspace-1")).toBeNull();
    const created = repo.upsert({
      workspace_id: "workspace-1",
      last_processed_reported_at: "2026-05-05T12:00:00.000Z",
      last_processed_audit_event_id: "event-1",
      updated_at: "2026-05-05T12:00:01.000Z"
    });
    expect(created).toEqual({
      workspace_id: "workspace-1",
      last_processed_reported_at: "2026-05-05T12:00:00.000Z",
      last_processed_audit_event_id: "event-1",
      updated_at: "2026-05-05T12:00:01.000Z"
    });

    expect(
      repo.upsert({
        workspace_id: "workspace-1",
        last_processed_reported_at: "2026-05-05T13:00:00.000Z",
        last_processed_audit_event_id: null,
        updated_at: "2026-05-05T13:00:01.000Z"
      })
    ).toEqual({
      workspace_id: "workspace-1",
      last_processed_reported_at: "2026-05-05T13:00:00.000Z",
      last_processed_audit_event_id: null,
      updated_at: "2026-05-05T13:00:01.000Z"
    });
  });
});
