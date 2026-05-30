import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../db.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";
import { SqliteEnrichPendingRepo } from "../repos/enrich-pending-repo.js";

const databases = new Set<StorageDatabase>();
const tempDirs = new Set<string>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function openMemoryDb(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  seedWorkspaces(database);
  return database;
}

function openFileDb(filename: string): StorageDatabase {
  const database = initDatabase({ filename });
  databases.add(database);
  return database;
}

function seedWorkspaces(database: StorageDatabase): void {
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  for (const workspaceId of ["workspace-1", "workspace-2"]) {
    workspaceRepo.create({
      workspace_id: workspaceId,
      name: workspaceId,
      root_path: `/tmp/${workspaceId}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      default_engine_class: null,
      workspace_state: WorkspaceState.ACTIVE
    });
  }
}

describe("SqliteEnrichPendingRepo", () => {
  it("applies migration 086 and exposes the enrich_pending columns", () => {
    const database = openMemoryDb();
    const applied = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 86")
      .get() as { readonly version: number } | undefined;
    expect(applied?.version).toBe(86);

    const columns = (
      database.connection.prepare("PRAGMA table_info(enrich_pending)").all() as ReadonlyArray<{
        readonly name: string;
      }>
    ).map((row) => row.name);
    expect(columns).toEqual([
      "workspace_id",
      "memory_id",
      "run_id",
      "source_signal_id",
      "enqueued_at",
      "claimed_at",
      "processed_at"
    ]);
  });

  it("enqueue is an idempotent upsert on (workspace_id, memory_id)", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-2",
      sourceSignalId: "signal-2",
      enqueuedAt: "2026-05-30T00:01:00.000Z"
    });

    expect(repo.countPending("workspace-1")).toBe(1);

    // Re-enqueue of a still-pending row keeps the original enqueued_at and does
    // not duplicate. A distinct memory adds a second row.
    const rows = database.connection
      .prepare("SELECT memory_id, enqueued_at FROM enrich_pending WHERE workspace_id = ?")
      .all("workspace-1") as ReadonlyArray<{
      readonly memory_id: string;
      readonly enqueued_at: string;
    }>;
    expect(rows).toEqual([{ memory_id: "memory-1", enqueued_at: "2026-05-30T00:00:00.000Z" }]);

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-2",
      runId: null,
      sourceSignalId: null,
      enqueuedAt: "2026-05-30T00:02:00.000Z"
    });
    expect(repo.countPending("workspace-1")).toBe(2);
  });

  it("claimBatch claims oldest-first, atomically, and never re-hands a claimed row", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-b",
      runId: "run-1",
      sourceSignalId: "signal-b",
      enqueuedAt: "2026-05-30T00:02:00.000Z"
    });
    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-a",
      runId: "run-1",
      sourceSignalId: "signal-a",
      enqueuedAt: "2026-05-30T00:01:00.000Z"
    });
    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-c",
      runId: "run-1",
      sourceSignalId: "signal-c",
      enqueuedAt: "2026-05-30T00:03:00.000Z"
    });
    // Another workspace's rows must never leak into a workspace-scoped claim.
    repo.enqueue({
      workspaceId: "workspace-2",
      memoryId: "memory-z",
      runId: "run-2",
      sourceSignalId: "signal-z",
      enqueuedAt: "2026-05-30T00:00:30.000Z"
    });

    const first = repo.claimBatch("workspace-1", 2, "2026-05-30T01:00:00.000Z");
    expect(first.map((claim) => claim.memoryId)).toEqual(["memory-a", "memory-b"]);
    expect(first[0]).toMatchObject({
      workspaceId: "workspace-1",
      memoryId: "memory-a",
      runId: "run-1",
      sourceSignalId: "signal-a"
    });

    // A second cycle gets only the remaining unclaimed row, never the two
    // already in-flight.
    const second = repo.claimBatch("workspace-1", 5, "2026-05-30T01:01:00.000Z");
    expect(second.map((claim) => claim.memoryId)).toEqual(["memory-c"]);

    const third = repo.claimBatch("workspace-1", 5, "2026-05-30T01:02:00.000Z");
    expect(third).toEqual([]);
  });

  it("markProcessed removes a row from pending and from future claims (idempotent re-mark)", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    const claimed = repo.claimBatch("workspace-1", 5, "2026-05-30T01:00:00.000Z");
    expect(claimed).toHaveLength(1);

    repo.markProcessed("workspace-1", "memory-1", "2026-05-30T02:00:00.000Z");
    expect(repo.countPending("workspace-1")).toBe(0);
    // A re-mark of an already-processed row is a harmless no-op.
    repo.markProcessed("workspace-1", "memory-1", "2026-05-30T03:00:00.000Z");
    expect(repo.countPending("workspace-1")).toBe(0);
    // A processed row is never re-handed out, even after another claim cycle.
    expect(repo.claimBatch("workspace-1", 5, "2026-05-30T04:00:00.000Z")).toEqual([]);
  });

  it("re-enqueue after processed re-arms the memory for a fresh enrichment cycle", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    repo.claimBatch("workspace-1", 5, "2026-05-30T01:00:00.000Z");
    repo.markProcessed("workspace-1", "memory-1", "2026-05-30T02:00:00.000Z");

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-9",
      sourceSignalId: "signal-9",
      enqueuedAt: "2026-05-30T05:00:00.000Z"
    });
    expect(repo.countPending("workspace-1")).toBe(1);
    const reclaimed = repo.claimBatch("workspace-1", 5, "2026-05-30T06:00:00.000Z");
    expect(reclaimed.map((claim) => claim.memoryId)).toEqual(["memory-1"]);
  });

  it("releaseClaim re-arms a claimed row; releaseClaim after markProcessed is a no-op", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    const claimed = repo.claimBatch("workspace-1", 5, "2026-05-30T01:00:00.000Z");
    expect(claimed.map((claim) => claim.memoryId)).toEqual(["memory-1"]);
    // A second claim cycle sees nothing — the row is in-flight.
    expect(repo.claimBatch("workspace-1", 5, "2026-05-30T01:01:00.000Z")).toEqual([]);

    // releaseClaim against the REAL SQL clears claimed_at so the row is claimable
    // again (a transient per-memory failure must never strand the marker).
    repo.releaseClaim("workspace-1", "memory-1");
    const reclaimed = repo.claimBatch("workspace-1", 5, "2026-05-30T02:00:00.000Z");
    expect(reclaimed.map((claim) => claim.memoryId)).toEqual(["memory-1"]);

    // Now mark it processed, then releaseClaim again: the WHERE processed_at IS
    // NULL guard makes it a no-op — a completed memory is never re-handed out.
    repo.markProcessed("workspace-1", "memory-1", "2026-05-30T03:00:00.000Z");
    expect(repo.countPending("workspace-1")).toBe(0);
    repo.releaseClaim("workspace-1", "memory-1");
    expect(repo.countPending("workspace-1")).toBe(0);
    expect(repo.claimBatch("workspace-1", 5, "2026-05-30T04:00:00.000Z")).toEqual([]);
  });

  it("delete drops a pending row: countPending falls and a later claim returns nothing", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-2",
      runId: null,
      sourceSignalId: null,
      enqueuedAt: "2026-05-30T00:01:00.000Z"
    });
    expect(repo.countPending("workspace-1")).toBe(2);

    repo.delete("workspace-1", "memory-1");
    expect(repo.countPending("workspace-1")).toBe(1);
    const remaining = repo.claimBatch("workspace-1", 5, "2026-05-30T01:00:00.000Z");
    expect(remaining.map((claim) => claim.memoryId)).toEqual(["memory-2"]);
    // The deleted memory is never re-handed out, even unclaimed.
    expect(remaining.some((claim) => claim.memoryId === "memory-1")).toBe(false);
  });

  it("reclaimStale re-arms a claim stranded by a crash (no markProcessed) so it drains again (B1)", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    // Claim the batch and then DROP the worker without markProcessed: claimed_at
    // is committed but processed_at stays NULL — a crash between claim and
    // processed. The row is now unclaimable (claimBatch requires claimed_at NULL).
    const claimed = repo.claimBatch("workspace-1", 5, "2026-05-30T01:00:00.000Z");
    expect(claimed).toHaveLength(1);
    expect(repo.claimBatch("workspace-1", 5, "2026-05-30T01:05:00.000Z")).toEqual([]);

    // A reclaim whose cutoff is BEFORE the claim time reclaims nothing (a still
    // in-flight cycle younger than the TTL is never pulled out from under itself).
    expect(repo.reclaimStale("2026-05-30T01:04:00.000Z", 5 * 60 * 1000)).toBe(0);

    // A reclaim whose cutoff is PAST the TTL re-arms the stranded claim.
    const reclaimed = repo.reclaimStale("2026-05-30T01:20:00.000Z", 10 * 60 * 1000);
    expect(reclaimed).toBe(1);

    // The previously stranded row is claimable again and a subsequent drain
    // processes it — enrichment is not silently lost on a daemon crash/restart.
    const redrained = repo.claimBatch("workspace-1", 5, "2026-05-30T01:21:00.000Z");
    expect(redrained.map((claim) => claim.memoryId)).toEqual(["memory-1"]);
    repo.markProcessed("workspace-1", "memory-1", "2026-05-30T01:22:00.000Z");
    expect(repo.countPending("workspace-1")).toBe(0);

    // A processed row is never reclaimed (reclaimStale requires processed_at NULL).
    expect(repo.reclaimStale("2026-05-30T02:00:00.000Z", 1)).toBe(0);
  });

  it("reclaimStale rejects an invalid now / negative TTL", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);
    expect(() => repo.reclaimStale("not-a-date", 1000)).toThrow();
    expect(() => repo.reclaimStale("2026-05-30T00:00:00.000Z", -1)).toThrow();
  });

  it("survives a fresh repo instance over the same on-disk DB (restart-safety)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alaya-enrich-pending-"));
    tempDirs.add(dir);
    const filename = path.join(dir, "alaya.db");

    const firstDb = openFileDb(filename);
    seedWorkspaces(firstDb);
    const firstRepo = new SqliteEnrichPendingRepo(firstDb);
    firstRepo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    expect(firstRepo.countPending("workspace-1")).toBe(1);
    firstDb.close();
    databases.delete(firstDb);

    // A daemon restart opens a new connection over the same file. The queued
    // enrichment marker must still be claimable — it was never lost.
    const secondDb = openFileDb(filename);
    const secondRepo = new SqliteEnrichPendingRepo(secondDb);
    expect(secondRepo.countPending("workspace-1")).toBe(1);
    const claimed = secondRepo.claimBatch("workspace-1", 5, "2026-05-30T01:00:00.000Z");
    expect(claimed.map((claim) => claim.memoryId)).toEqual(["memory-1"]);
  });
});
