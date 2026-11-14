import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });

import BetterSqlite3 from "better-sqlite3";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "@do-soul/alaya-storage";
import {
  explodePackedWorkingCopy,
  loadSliceIntoOpenDatabase
} from "../../../runs/snapshot/recall-eval/workspace-slice/index.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import { createPackedTwoWorkspaceDb, WORKSPACE_A, WORKSPACE_B } from "./workspace-slice-fixture.js";

describe("workspace slice erase recovery", () => {
  it("preserves scoped progress and pending counts while reseeding suppression on explode and live replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-slice-erase-recovery-"));
    const packedPath = join(root, "packed.db");
    try {
      await createPackedTwoWorkspaceDb(packedPath);
      const packed = new BetterSqlite3(packedPath);
      try {
        seedRecovery(packed, WORKSPACE_A, 7, 7, 0);
        seedRecovery(packed, WORKSPACE_B, 9, 4, 1);
        // Defensive reset: even an incorrectly persisted active flag must not transfer.
        packed.exec("UPDATE source_erase_repair_control SET repairing = 1");
      } finally { packed.close(); }
      const slices = await explodePackedWorkingCopy({
        packedDbPath: packedPath, destDir: join(root, "slices"),
        workspaceIds: [WORKSPACE_A, WORKSPACE_B]
      });
      for (const [workspace, revision, checked, dirty] of [
        [WORKSPACE_A, 7, 7, 0], [WORKSPACE_B, 9, 4, 1]
      ] as const) {
        const slice = new BetterSqlite3(slices.sliceDbPaths[workspace]!, { readonly: true });
        try {
          assertRecovery(slice, workspace, revision, checked, dirty);
          expect(slice.prepare("SELECT * FROM source_erase_repair_control").all())
            .toEqual([{ singleton: 1, repairing: 0 }]);
        } finally { slice.close(); }
      }
      const unchanged = new BetterSqlite3(packedPath, { readonly: true });
      try {
        expect(unchanged.prepare("SELECT repairing FROM source_erase_repair_control").get()).toEqual({ repairing: 1 });
      } finally { unchanged.close(); }

      const activeSlicePath = join(root, "active-slice.db");
      await copyFile(slices.sliceDbPaths[WORKSPACE_A]!, activeSlicePath);
      const activeSlice = new BetterSqlite3(activeSlicePath);
      try { activeSlice.exec("UPDATE source_erase_repair_control SET repairing = 1"); }
      finally { activeSlice.close(); }
      const live = initDatabase({ filename: join(root, "live.db") });
      try {
        for (const mode of ["active", "missing"] as const) {
          live.connection.exec(mode === "active"
            ? "UPDATE source_erase_repair_control SET repairing = 1"
            : "DELETE FROM source_erase_repair_control");
          loadSliceIntoOpenDatabase(live, activeSlicePath);
          assertRecovery(live.connection, WORKSPACE_A, 7, 7, 0);
          expect(live.connection.prepare("SELECT * FROM source_erase_repair_control").all())
            .toEqual([{ singleton: 1, repairing: 0 }]);
          assertRestoredTriggers(live.connection, WORKSPACE_A);
          // Replacing a nonempty live workspace also removes the previous recovery rows.
          loadSliceIntoOpenDatabase(live, slices.sliceDbPaths[WORKSPACE_B]!);
          assertRecovery(live.connection, WORKSPACE_B, 9, 4, 1);
        }
      } finally { live.close(); }
    } finally { await removeTempDirectory(root); }
  });
});

function seedRecovery(db: BetterSqlite3.Database, workspace: string, revision: number, checked: number, dirty: number): void {
  db.prepare(`INSERT INTO host_session_containers
    (workspace_id, container_key, producer, newest_position, newest_admitted_at)
    VALUES (?, 'container', 'fixture', 2, '2026-08-10T00:00:00.000Z')`).run(workspace);
  const insertRound = db.prepare(`INSERT INTO host_session_rounds
    (workspace_id, container_key, round_index, root_id, state) VALUES (?, 'container', ?, ?, ?)`);
  insertRound.run(workspace, 0, "root", "pending");
  insertRound.run(workspace, 1, "other-root", "erased_pending");
  insertRound.run(workspace, 2, "done-root", "done");
  db.prepare(`INSERT INTO projection_erase_barriers
    (workspace_id, barrier_id, receipt_identity, subject_kind, subject_id, erased_at)
    VALUES (?, 'barrier', 'receipt', 'source_record', 'root', '2026-08-10T00:00:00.000Z')`).run(workspace);
  db.prepare(`UPDATE source_erase_closure_progress
    SET data_revision = ?, checked_revision = ?, rule_version = 1, dirty = ? WHERE workspace_id = ?`)
    .run(revision, checked, dirty, workspace);
}

function assertRecovery(db: BetterSqlite3.Database, workspace: string, revision: number, checked: number, dirty: number): void {
  expect(db.prepare("SELECT * FROM source_erase_closure_progress").all()).toEqual([{
    workspace_id: workspace, barrier_id: "barrier", data_revision: revision,
    checked_revision: checked, rule_version: 1, dirty
  }]);
  expect(db.prepare("SELECT workspace_id, pending_round_count FROM host_session_containers").all())
    .toEqual([{ workspace_id: workspace, pending_round_count: 2 }]);
  expect(db.prepare("SELECT DISTINCT workspace_id FROM host_session_rounds").all())
    .toEqual([{ workspace_id: workspace }]);
  expect(db.prepare("SELECT workspace_id, barrier_id FROM projection_erase_barriers").all())
    .toEqual([{ workspace_id: workspace, barrier_id: "barrier" }]);
}

function assertRestoredTriggers(db: BetterSqlite3.Database, workspace: string): void {
  db.prepare("UPDATE host_session_rounds SET state = 'done' WHERE workspace_id = ? AND round_index = 0").run(workspace);
  expect(db.prepare("SELECT data_revision, checked_revision, dirty FROM source_erase_closure_progress").get())
    .toEqual({ data_revision: 8, checked_revision: 7, dirty: 1 });
  expect(db.prepare("SELECT pending_round_count FROM host_session_containers").get()).toEqual({ pending_round_count: 1 });
  db.prepare("DELETE FROM host_session_rounds WHERE workspace_id = ? AND round_index = 1").run(workspace);
  expect(db.prepare("SELECT pending_round_count FROM host_session_containers").get()).toEqual({ pending_round_count: 0 });
  db.prepare(`INSERT INTO host_session_rounds VALUES (?, 'container', 3, 'new-root', 'pending')`).run(workspace);
  expect(db.prepare("SELECT pending_round_count FROM host_session_containers").get()).toEqual({ pending_round_count: 1 });
}
