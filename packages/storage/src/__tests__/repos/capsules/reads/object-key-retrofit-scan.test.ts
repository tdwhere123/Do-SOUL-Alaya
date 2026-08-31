import { afterEach, describe, expect, it } from "vitest";
import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import { scanObjectKeyRetrofitSources } from "../../../../repos/capsules/reads/object-key-retrofit-scan.js";
import { SqliteRunRepo } from "../../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../../repos/runtime/workspace-repo.js";
import { initDatabase, type StorageDatabase } from "../../../../sqlite/db.js";
import { StorageError } from "../../../../shared/errors.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("scanObjectKeyRetrofitSources", () => {
  it("throws VALIDATION_FAILED when persisted evidence_refs JSON is corrupt", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    await new SqliteWorkspaceRepo(database).create({
      workspace_id: "workspace-1",
      name: "workspace",
      root_path: "/tmp/workspace",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await new SqliteRunRepo(database).create({
      run_id: "run-1",
      workspace_id: "workspace-1",
      title: "run",
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });
    database.connection.prepare(`
      INSERT INTO memory_entries (
        object_id, created_at, updated_at, created_by, dimension, source_kind,
        formation_kind, scope_class, content, evidence_refs, workspace_id, run_id
      ) VALUES (?, ?, ?, 'user', 'fact', 'user', 'explicit', 'project', 'content', ?, ?, ?)
    `).run(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "2026-08-26T00:00:00.000Z",
      "2026-08-26T00:00:00.000Z",
      "{not-json",
      "workspace-1",
      "run-1"
    );

    expect(() => scanObjectKeyRetrofitSources(database)).toThrow(StorageError);
    expect(() => scanObjectKeyRetrofitSources(database)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" })
    );
  });
});
