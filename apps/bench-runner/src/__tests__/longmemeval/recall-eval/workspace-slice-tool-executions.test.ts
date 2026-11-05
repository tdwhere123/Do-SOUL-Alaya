import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { initDatabase } from "@do-soul/alaya-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { explodePackedWorkingCopy, workspaceSliceDbPath } from
  "../../../runs/snapshot/recall-eval/workspace-slice/explode.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import { createPackedTwoWorkspaceDb, WORKSPACE_A, WORKSPACE_B } from "./workspace-slice-fixture.js";

let root: string;
let packedPath: string;
const previousWriteQueue = process.env.ALAYA_SQLITE_WRITE_QUEUE;

beforeEach(async () => {
  process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
  root = await mkdtemp(join(tmpdir(), "workspace-slice-tool-executions-"));
  packedPath = join(root, "packed.alaya.db");
  await createPackedTwoWorkspaceDb(packedPath);
  seedToolExecutions(packedPath);
});

afterEach(async () => {
  if (previousWriteQueue === undefined) delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
  else process.env.ALAYA_SQLITE_WRITE_QUEUE = previousWriteQueue;
  await removeTempDirectory(root);
});

describe("workspace slice tool execution ownership", () => {
  it.each([{ workspaceIds: [WORKSPACE_A, WORKSPACE_B] }, { workspaceIds: [WORKSPACE_A] }])(
    "preserves principal and worker audit rows only for selected workspaces $workspaceIds",
    async ({ workspaceIds }) => {
      const before = readFileSync(packedPath);
      const exploded = await explodePackedWorkingCopy({
        packedDbPath: packedPath, destDir: join(root, "slices"), workspaceIds
      });
      expect(readFileSync(packedPath).equals(before)).toBe(true);
      expect(Object.keys(exploded.sliceDbPaths)).toEqual(workspaceIds);
      const packed = new BetterSqlite3(packedPath, { readonly: true });
      try {
        for (const workspaceId of workspaceIds) {
          const slice = new BetterSqlite3(exploded.sliceDbPaths[workspaceId]!, { readonly: true });
          try {
            // Expected ownership comes from the schema joins, not the copy policy.
            const expected = packed.prepare(`
              SELECT execution.* FROM tool_execution_records execution
              LEFT JOIN runs principal ON principal.run_id = execution.requesting_principal_run_id
              LEFT JOIN worker_runs worker ON worker.worker_run_id = execution.requesting_worker_run_id
              WHERE principal.workspace_id = ? OR worker.workspace_id = ?
              ORDER BY execution.execution_id
            `).all(workspaceId, workspaceId);
            expect(expected).toHaveLength(workspaceId === WORKSPACE_A ? 3 : 2);
            expect(slice.prepare("SELECT * FROM tool_execution_records ORDER BY execution_id").all())
              .toEqual(expected);
            expect(slice.pragma("foreign_key_check")).toEqual([]);
          } finally {
            slice.close();
          }
        }
      } finally {
        packed.close();
      }
    }
  );

  it("rejects ambiguous owner references rather than leaking an audit row across slices", async () => {
    const packed = new BetterSqlite3(packedPath);
    try {
      packed.pragma("ignore_check_constraints = ON");
      packed.prepare(`UPDATE tool_execution_records SET requesting_principal_run_id = 'run-b'
        WHERE execution_id = 'worker-a-execution'`).run();
    } finally {
      packed.close();
    }
    const before = readFileSync(packedPath);
    const destDir = join(root, "ambiguous-slices");
    await expect(explodePackedWorkingCopy({ packedDbPath: packedPath, destDir }))
      .rejects.toThrow("ambiguous workspace owner for tool_execution_records");
    expect(readFileSync(packedPath).equals(before)).toBe(true);
    for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
      const path = workspaceSliceDbPath(destDir, workspaceId);
      expect(existsSync(path)).toBe(true);
      const slice = new BetterSqlite3(path, { readonly: true });
      try {
        expect(slice.prepare("SELECT * FROM tool_execution_records").all()).toEqual([]);
      } finally {
        slice.close();
      }
    }
  });
});

function seedToolExecutions(path: string): void {
  const database = initDatabase({ filename: path });
  const connection = database.connection;
  try {
    connection.prepare(`INSERT INTO tool_specs (
      tool_id, category, description, scope_guard, read_only, destructive, concurrency_safe,
      interrupt_behavior, requires_confirmation, requires_evidence_reopen, rollback_support,
      fast_path_eligible
    ) VALUES ('slice-tool', 'read', 'Slice audit fixture', 'workspace', 1, 0, 1,
      'continue', 0, 0, 'none', 1)`).run();
    const worker = connection.prepare(`INSERT INTO worker_runs (
      worker_run_id, principal_run_id, workspace_id, requesting_principal_run_id,
      requesting_worker_run_id, engine_class, state, subtask_description, local_surface_ref,
      restricted_tool_set_json, local_budget_json, agreed_return_format_json,
      principal_security_snapshot_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'coding_engine', 'completed', 'Audit fixture', 'surface',
      '[]', '{}', '{}', '{}', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')`);
    // Colliding identifiers across the two parent tables expose wrong-FK routing.
    worker.run("run-b", "run-a", WORKSPACE_A, "run-a", null);
    worker.run("run-a", "run-b", WORKSPACE_B, "run-b", null);
    worker.run("nested-worker-a", "run-a", WORKSPACE_A, null, "run-b");
    const execution = connection.prepare(`INSERT INTO tool_execution_records (
      execution_id, tool_id, requested_by, requesting_principal_run_id, requesting_worker_run_id,
      governance_decision_ref, permission_result, executed, result_summary, rollback_status
    ) VALUES (?, 'slice-tool', ?, ?, ?, 'decision', 'allow', 1, ?, 'none')`);
    execution.run("principal-a-execution", "principal", "run-a", null, "Principal A");
    execution.run("principal-b-execution", "principal", "run-b", null, "Principal B");
    execution.run("worker-a-execution", "worker", null, "run-b", "Worker A");
    execution.run("worker-b-execution", "worker", null, "run-a", "Worker B");
    execution.run("nested-worker-a-execution", "worker", null, "nested-worker-a", "Nested worker A");
    expect(connection.pragma("foreign_key_check")).toEqual([]);
  } finally {
    database.close();
  }
}
