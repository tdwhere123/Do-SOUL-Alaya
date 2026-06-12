import { afterEach, describe, expect, it } from "vitest";
import type { PathGraphSnapshot } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqlitePathGraphSnapshotRepo } from "../../../repos/path/path-graph-snapshot-repo.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqlitePathGraphSnapshotRepo", () => {
  it("creates snapshots and returns the latest history first", async () => {
    const { repo } = createRepo();
    const older = createSnapshotFixture({
      snapshot_id: "snapshot-older",
      snapshot_at: "2026-04-17T00:00:00.000Z"
    });
    const newer = createSnapshotFixture({
      snapshot_id: "snapshot-newer",
      snapshot_at: "2026-04-17T00:15:00.000Z",
      total_active_paths: 4,
      paths_created_since_last: 1
    });

    expect(repo.create(older)).toEqual(older);
    expect(repo.create(newer)).toEqual(newer);
    await expect(repo.findLatest("workspace-1")).resolves.toEqual(newer);
    await expect(repo.findHistory("workspace-1", 5)).resolves.toEqual([newer, older]);
    await expect(repo.findHistory("workspace-1", 1)).resolves.toEqual([newer]);
  });

  it("deletes snapshots older than the provided cutoff", async () => {
    const { repo } = createRepo();
    const oldest = createSnapshotFixture({
      snapshot_id: "snapshot-oldest",
      snapshot_at: "2026-04-17T00:00:00.000Z"
    });
    const middle = createSnapshotFixture({
      snapshot_id: "snapshot-middle",
      snapshot_at: "2026-04-17T00:10:00.000Z"
    });
    const newest = createSnapshotFixture({
      snapshot_id: "snapshot-newest",
      snapshot_at: "2026-04-17T00:20:00.000Z"
    });

    await repo.create(oldest);
    await repo.create(middle);
    await repo.create(newest);

    await expect(repo.deleteOlderThan("workspace-1", "2026-04-17T00:15:00.000Z")).resolves.toBe(2);
    await expect(repo.findHistory("workspace-1", 5)).resolves.toEqual([newest]);
  });

  it("returns the persisted snapshot after create", async () => {
    const { database, repo } = createRepo();
    const snapshot = createSnapshotFixture();
    const persistedSnapshot = createSnapshotFixture({
      snapshot_at: "2026-04-17T00:06:00.000Z"
    });

    database.connection.exec(`
      CREATE TRIGGER path_graph_snapshots_normalize_after_insert
      AFTER INSERT ON path_graph_snapshots
      BEGIN
        UPDATE path_graph_snapshots
        SET snapshot_at = '2026-04-17T00:06:00.000Z'
        WHERE snapshot_id = NEW.snapshot_id;
      END;
    `);

    expect(repo.create(snapshot)).toEqual(persistedSnapshot);
    await expect(repo.findLatest(snapshot.workspace_id)).resolves.toEqual(persistedSnapshot);
  });
});

function createRepo(): {
  readonly database: StorageDatabase;
  readonly repo: SqlitePathGraphSnapshotRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  seedWorkspace(database, "workspace-1");

  return {
    database,
    repo: new SqlitePathGraphSnapshotRepo(database)
  };
}

function seedWorkspace(database: StorageDatabase, workspaceId: string): void {
  database.connection
    .prepare(
      `INSERT INTO workspaces (
        workspace_id,
        name,
        root_path,
        workspace_kind,
        default_engine_binding,
        workspace_state,
        created_at,
        archived_at,
        default_engine_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      workspaceId,
      "Path Snapshot Workspace",
      `/tmp/${workspaceId}`,
      "local_repo",
      null,
      "active",
      "2026-04-17T00:00:00.000Z",
      null,
      null
    );
}

function createSnapshotFixture(overrides: Partial<PathGraphSnapshot> = {}): PathGraphSnapshot {
  return {
    snapshot_id: "snapshot-1",
    workspace_id: "workspace-1",
    total_active_paths: 3,
    strength_distribution: {
      very_weak: 0,
      weak: 1,
      moderate: 1,
      strong: 1,
      very_strong: 0
    },
    stability_distribution: {
      volatile: 1,
      normal: 1,
      stable: 1,
      pinned: 0
    },
    governance_distribution: {
      hint_only: 1,
      attention_only: 1,
      recall_allowed: 1,
      strictly_governed: 0
    },
    connectivity: {
      unique_source_anchors: 2,
      unique_target_anchors: 3,
      max_out_degree: 2,
      max_in_degree: 1,
      isolated_anchors: 2
    },
    paths_reinforced_since_last: 2,
    paths_weakened_since_last: 1,
    paths_created_since_last: 3,
    snapshot_at: "2026-04-17T00:05:00.000Z",
    ...overrides
  };
}
