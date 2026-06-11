import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { TrustStateEventType, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../db.js";
import { SqliteEventLogRepo } from "../../repos/event-log-repo.js";
import { SqlitePathPlasticityWatermarkRepo } from "../../repos/path-plasticity-watermark-repo.js";
import { SqliteWorkspaceRepo } from "../../repos/workspace-repo.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("SqlitePathPlasticityWatermarkRepo", () => {
  it("applies migration 060 and persists per-workspace watermarks", async () => {
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
      .prepare("SELECT version FROM schema_version WHERE version = 60")
      .get() as { readonly version: number } | undefined;
    expect(migration?.version).toBe(60);

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

  it("bootstraps existing workspaces from a safe 24h lookback instead of MAX raw usage reports", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const repo = new SqlitePathPlasticityWatermarkRepo(database);
    await workspaceRepo.create({
      workspace_id: "workspace-usage",
      name: "Usage Workspace",
      root_path: "/tmp/usage",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await eventLogRepo.append({
      event_type: TrustStateEventType.MEMORY_USAGE_REPORTED,
      entity_type: "trust_usage_proof",
      entity_id: "delivery-future",
      workspace_id: "workspace-usage",
      run_id: null,
      caused_by: "test",
      payload_json: {
        delivery_id: "delivery-future",
        usage_state: "used",
        used_object_ids: ["memory-1"],
        reason: null,
        reported_at: "2099-01-01T00:00:00.000Z"
      }
    });
    database.connection
      .prepare("DELETE FROM path_plasticity_watermark WHERE workspace_id = ?")
      .run("workspace-usage");

    const lowerBoundMs = Date.now() - 24 * 60 * 60 * 1000 - 2_000;
    const migrationSql = await readFile(
      new URL("../../migrations/060-path-plasticity-watermark.sql", import.meta.url),
      "utf8"
    );
    database.connection.exec(migrationSql);
    const upperBoundMs = Date.now() - 24 * 60 * 60 * 1000 + 2_000;

    const stored = repo.findByWorkspaceId("workspace-usage");
    expect(stored).not.toBeNull();
    const watermarkMs = Date.parse(stored?.last_processed_reported_at ?? "");
    expect(watermarkMs).toBeGreaterThanOrEqual(lowerBoundMs);
    expect(watermarkMs).toBeLessThanOrEqual(upperBoundMs);
    expect(stored?.last_processed_reported_at).not.toBe("2099-01-01T00:00:00.000Z");
  });
});
