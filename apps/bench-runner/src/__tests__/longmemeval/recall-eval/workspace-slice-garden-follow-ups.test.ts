import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { closeCachedDatabase, initDatabase } from "@do-soul/alaya-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  explodePackedWorkingCopy,
  loadSliceIntoOpenDatabase
} from "../../../runs/snapshot/recall-eval/workspace-slice/index.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import {
  createPackedTwoWorkspaceDb,
  WORKSPACE_A,
  WORKSPACE_B
} from "./workspace-slice-fixture.js";

const CLOCK = "2026-08-10T00:00:00.000Z";
const previousWriteQueue = process.env.ALAYA_SQLITE_WRITE_QUEUE;
let root: string;
let packedPath: string;

beforeEach(async () => {
  process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
  root = await mkdtemp(join(tmpdir(), "workspace-slice-garden-"));
  packedPath = join(root, "packed.alaya.db");
  await createPackedTwoWorkspaceDb(packedPath);
  const packed = initDatabase({ filename: packedPath });
  try {
    seedFollowUps(packed, WORKSPACE_A, 1);
    seedFollowUps(packed, WORKSPACE_B, 11);
  } finally {
    packed.close();
  }
});

afterEach(async () => {
  closeCachedDatabase(packedPath);
  if (previousWriteQueue === undefined) delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
  else process.env.ALAYA_SQLITE_WRITE_QUEUE = previousWriteQueue;
  await removeTempDirectory(root);
});

describe("workspace slice Garden follow-ups", () => {
  it("retains completed and failed task parents with only their workspace's backfill objects", async () => {
    const packedBytes = readFileSync(packedPath);
    const exploded = await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir: join(root, "slices")
    });
    for (const [workspaceId, sequence] of [[WORKSPACE_A, 1], [WORKSPACE_B, 11]] as const) {
      const slice = new BetterSqlite3(exploded.sliceDbPaths[workspaceId]!, { readonly: true });
      try {
        assertFollowUps(slice, workspaceId, sequence);
      } finally {
        slice.close();
      }
    }
    expect(readFileSync(packedPath)).toEqual(packedBytes);
  });

  it("replaces both parent and child rows when switching an open database between slices", async () => {
    const exploded = await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir: join(root, "slices")
    });
    const live = initDatabase({ filename: join(root, "live.db") });
    try {
      for (const [workspaceId, sequence] of [[WORKSPACE_A, 1], [WORKSPACE_B, 11], [WORKSPACE_A, 1]] as const) {
        const slicePath = exploded.sliceDbPaths[workspaceId]!;
        const sealedBytes = readFileSync(slicePath);
        loadSliceIntoOpenDatabase(live, slicePath);
        assertFollowUps(live.connection, workspaceId, sequence);
        expect(live.connection.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(readFileSync(slicePath)).toEqual(sealedBytes);
      }
    } finally {
      live.close();
    }
  });
});

function seedFollowUps(
  database: ReturnType<typeof initDatabase>,
  workspaceId: string,
  firstSequence: number
): void {
  const db = database.connection;
  for (const [index, status] of ["completed", "failed"].entries()) {
    const taskId = `${workspaceId}-${status}`;
    db.prepare(`INSERT INTO garden_tasks
      (id, workspace_id, role, kind, payload_json, status, outcome, created_at, completed_at)
      VALUES (?, ?, 'librarian', 'embedding_backfill', '{}', ?, ?, ?, ?)`)
      .run(taskId, workspaceId, status, status, CLOCK, CLOCK);
    db.prepare(`INSERT INTO garden_embedding_backfill_runs
      (task_id, workspace_id, state, mode, backfill_outcome, attempt_count, updated_at)
      VALUES (?, ?, ?, 'production', ?, 2, ?)`)
      .run(taskId, workspaceId, index === 0 ? "pending" : "blocked", status, CLOCK);
    // Object IDs overlap across task/workspace rows; only task ownership scopes this table.
    db.prepare(`INSERT INTO garden_embedding_backfill_objects
      (sequence, task_id, object_id, content_hash) VALUES (?, ?, 'shared-object', ?)`)
      .run(firstSequence + index, taskId, `sha256:${taskId}`);
  }
  db.prepare(`INSERT INTO garden_tasks
    (id, workspace_id, role, kind, payload_json, status, created_at)
    VALUES (?, ?, 'librarian', 'embedding_backfill', '{}', 'pending', ?)`)
    .run(`${workspaceId}-unstarted`, workspaceId, CLOCK);
}

function assertFollowUps(
  db: Pick<BetterSqlite3.Database, "prepare">,
  workspaceId: string,
  firstSequence: number
): void {
  expect(db.prepare("SELECT id, workspace_id, status, outcome FROM garden_tasks ORDER BY id").all()).toEqual([
    { id: `${workspaceId}-completed`, workspace_id: workspaceId, status: "completed", outcome: "completed" },
    { id: `${workspaceId}-failed`, workspace_id: workspaceId, status: "failed", outcome: "failed" },
    { id: `${workspaceId}-unstarted`, workspace_id: workspaceId, status: "pending", outcome: null }
  ]);
  expect(db.prepare(`SELECT task_id, workspace_id, state, mode, owner_token, backfill_outcome, attempt_count
    FROM garden_embedding_backfill_runs ORDER BY task_id`).all()).toEqual([
    { task_id: `${workspaceId}-completed`, workspace_id: workspaceId, state: "pending", mode: "production",
      owner_token: null, backfill_outcome: "completed", attempt_count: 2 },
    { task_id: `${workspaceId}-failed`, workspace_id: workspaceId, state: "blocked", mode: "production",
      owner_token: null, backfill_outcome: "failed", attempt_count: 2 }
  ]);
  expect(db.prepare("SELECT * FROM garden_embedding_backfill_objects ORDER BY sequence").all()).toEqual([
    { sequence: firstSequence, task_id: `${workspaceId}-completed`, object_id: "shared-object",
      content_hash: `sha256:${workspaceId}-completed` },
    { sequence: firstSequence + 1, task_id: `${workspaceId}-failed`, object_id: "shared-object",
      content_hash: `sha256:${workspaceId}-failed` }
  ]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}
