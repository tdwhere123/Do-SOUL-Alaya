import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DYNAMICS_CONSTANTS, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../sqlite/db.js";
import { SqliteWorkspaceRepo } from "../../repos/runtime/workspace-repo.js";
import { SqliteEnrichPendingRepo } from "../../repos/enrich-pending-repo.js";

const MAX_ATTEMPTS = DYNAMICS_CONSTANTS.enrich.max_attempts;

// Claim against the production attempt cap unless a test pins a smaller cap to
// drive the dead-letter boundary.
function claim(
  repo: SqliteEnrichPendingRepo,
  workspaceId: string,
  limit: number,
  claimedAt: string,
  maxAttempts: number = MAX_ATTEMPTS
): readonly { readonly memoryId: string }[] {
  return repo.claimBatch(workspaceId, limit, claimedAt, maxAttempts);
}

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
      "processed_at",
      "attempt_count",
      "abandoned_at"
    ]);
  });

  it("applies migration 088 and defaults attempt_count to 0 with a null abandoned_at", () => {
    const database = openMemoryDb();
    const applied = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 88")
      .get() as { readonly version: number } | undefined;
    expect(applied?.version).toBe(88);

    const repo = new SqliteEnrichPendingRepo(database);
    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    const row = database.connection
      .prepare(
        "SELECT attempt_count, abandoned_at FROM enrich_pending WHERE workspace_id = ? AND memory_id = ?"
      )
      .get("workspace-1", "memory-1") as
      | { readonly attempt_count: number; readonly abandoned_at: string | null }
      | undefined;
    expect(row?.attempt_count).toBe(0);
    expect(row?.abandoned_at).toBeNull();
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

    const first = repo.claimBatch("workspace-1", 2, "2026-05-30T01:00:00.000Z", MAX_ATTEMPTS);
    expect(first.map((entry) => entry.memoryId)).toEqual(["memory-a", "memory-b"]);
    expect(first[0]).toMatchObject({
      workspaceId: "workspace-1",
      memoryId: "memory-a",
      runId: "run-1",
      sourceSignalId: "signal-a"
    });

    // A second cycle gets only the remaining unclaimed row, never the two
    // already in-flight.
    const second = claim(repo, "workspace-1", 5, "2026-05-30T01:01:00.000Z");
    expect(second.map((entry) => entry.memoryId)).toEqual(["memory-c"]);

    const third = claim(repo, "workspace-1", 5, "2026-05-30T01:02:00.000Z");
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
    const claimed = claim(repo, "workspace-1", 5, "2026-05-30T01:00:00.000Z");
    expect(claimed).toHaveLength(1);

    repo.markProcessed("workspace-1", "memory-1", "2026-05-30T02:00:00.000Z");
    expect(repo.countPending("workspace-1")).toBe(0);
    // A re-mark of an already-processed row is a harmless no-op.
    repo.markProcessed("workspace-1", "memory-1", "2026-05-30T03:00:00.000Z");
    expect(repo.countPending("workspace-1")).toBe(0);
    // A processed row is never re-handed out, even after another claim cycle.
    expect(claim(repo, "workspace-1", 5, "2026-05-30T04:00:00.000Z")).toEqual([]);
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
    claim(repo, "workspace-1", 5, "2026-05-30T01:00:00.000Z");
    repo.markProcessed("workspace-1", "memory-1", "2026-05-30T02:00:00.000Z");

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-9",
      sourceSignalId: "signal-9",
      enqueuedAt: "2026-05-30T05:00:00.000Z"
    });
    expect(repo.countPending("workspace-1")).toBe(1);
    const reclaimed = claim(repo, "workspace-1", 5, "2026-05-30T06:00:00.000Z");
    expect(reclaimed.map((entry) => entry.memoryId)).toEqual(["memory-1"]);
  });

  it("recordFailedAttempt increments attempt_count and re-arms a claim under the cap; a no-op after markProcessed", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    const claimed = claim(repo, "workspace-1", 5, "2026-05-30T01:00:00.000Z");
    expect(claimed.map((entry) => entry.memoryId)).toEqual(["memory-1"]);
    // A second claim cycle sees nothing — the row is in-flight.
    expect(claim(repo, "workspace-1", 5, "2026-05-30T01:01:00.000Z")).toEqual([]);

    // A transient failure under the cap increments attempt_count and clears
    // claimed_at so the row is claimable again (a transient per-memory failure
    // must never strand the marker) and is NOT dead-lettered.
    const firstAttempt = repo.recordFailedAttempt(
      "workspace-1",
      "memory-1",
      MAX_ATTEMPTS,
      "2026-05-30T01:30:00.000Z"
    );
    expect(firstAttempt).toEqual({ attemptCount: 1, abandoned: false });
    const reclaimed = claim(repo, "workspace-1", 5, "2026-05-30T02:00:00.000Z");
    expect(reclaimed.map((entry) => entry.memoryId)).toEqual(["memory-1"]);

    // Now mark it processed, then record another failure: the processed_at guard
    // freezes the count and makes it a no-op — a completed memory is never
    // re-handed out, and a late failure cannot dead-letter a settled marker.
    repo.markProcessed("workspace-1", "memory-1", "2026-05-30T03:00:00.000Z");
    expect(repo.countPending("workspace-1")).toBe(0);
    const afterProcessed = repo.recordFailedAttempt(
      "workspace-1",
      "memory-1",
      MAX_ATTEMPTS,
      "2026-05-30T03:30:00.000Z"
    );
    expect(afterProcessed.abandoned).toBe(false);
    expect(afterProcessed.attemptCount).toBe(1);
    expect(repo.countPending("workspace-1")).toBe(0);
    expect(claim(repo, "workspace-1", 5, "2026-05-30T04:00:00.000Z")).toEqual([]);
  });

  it("recordFailedAttempt dead-letters a marker at the cap: abandoned_at set, excluded from claims, still counted unprocessed", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);
    const cap = 3;

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-poison",
      runId: "run-1",
      sourceSignalId: "signal-poison",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    // A healthy marker queued behind the poison one must still drain once the
    // poison marker stops consuming the per-pass budget.
    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-healthy",
      runId: "run-1",
      sourceSignalId: "signal-healthy",
      enqueuedAt: "2026-05-30T00:01:00.000Z"
    });

    let lastOutcome = { attemptCount: 0, abandoned: false };
    for (let attempt = 1; attempt <= cap; attempt += 1) {
      const claimed = claim(repo, "workspace-1", 1, `2026-05-30T0${attempt}:00:00.000Z`, cap);
      // Oldest-first: the poison marker is claimed every pass until it is
      // dead-lettered (it consumes the single-slot budget each pass).
      expect(claimed.map((entry) => entry.memoryId)).toEqual(["memory-poison"]);
      lastOutcome = repo.recordFailedAttempt(
        "workspace-1",
        "memory-poison",
        cap,
        `2026-05-30T0${attempt}:30:00.000Z`
      );
    }
    expect(lastOutcome).toEqual({ attemptCount: cap, abandoned: true });

    const abandonedRow = database.connection
      .prepare(
        "SELECT abandoned_at, attempt_count FROM enrich_pending WHERE workspace_id = ? AND memory_id = ?"
      )
      .get("workspace-1", "memory-poison") as
      | { readonly abandoned_at: string | null; readonly attempt_count: number }
      | undefined;
    expect(abandonedRow?.abandoned_at).not.toBeNull();
    expect(abandonedRow?.attempt_count).toBe(cap);

    // The dead-lettered marker is excluded from every future claim, so the
    // healthy marker behind it now drains and the per-pass budget is freed.
    const next = claim(repo, "workspace-1", 5, "2026-05-30T09:00:00.000Z", cap);
    expect(next.map((entry) => entry.memoryId)).toEqual(["memory-healthy"]);

    // countPending still sees the abandoned (unprocessed) row — dead-letter is a
    // terminal hold, not a delete, so the abandon stays auditable in the table.
    expect(repo.countPending("workspace-1")).toBe(2);
  });

  it("claimBatch never re-serves a marker already at/over the cap even without an abandon write", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);

    repo.enqueue({
      workspaceId: "workspace-1",
      memoryId: "memory-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      enqueuedAt: "2026-05-30T00:00:00.000Z"
    });
    // Drive attempt_count to 2 directly, then claim with a cap of 2: the
    // attempt_count < maxAttempts guard excludes it independently of abandoned_at.
    database.connection
      .prepare(
        "UPDATE enrich_pending SET attempt_count = 2 WHERE workspace_id = ? AND memory_id = ?"
      )
      .run("workspace-1", "memory-1");
    expect(claim(repo, "workspace-1", 5, "2026-05-30T01:00:00.000Z", 2)).toEqual([]);
    // A higher cap re-admits it (the bound is the only gate, not a permanent drop).
    expect(claim(repo, "workspace-1", 5, "2026-05-30T01:01:00.000Z", 3).map((entry) => entry.memoryId)).toEqual([
      "memory-1"
    ]);
  });

  it("recordFailedAttempt on an empty/clean table is a safe no-op", () => {
    const database = openMemoryDb();
    const repo = new SqliteEnrichPendingRepo(database);
    // No row exists: the increment/select find nothing, the count stays 0, and
    // the outcome reports no abandon.
    const outcome = repo.recordFailedAttempt(
      "workspace-1",
      "missing-memory",
      MAX_ATTEMPTS,
      "2026-05-30T01:00:00.000Z"
    );
    expect(outcome).toEqual({ attemptCount: 0, abandoned: false });
    expect(repo.countPending("workspace-1")).toBe(0);
    expect(() => repo.recordFailedAttempt("workspace-1", "missing", 0, "2026-05-30T01:00:00.000Z")).toThrow();
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
    const remaining = claim(repo, "workspace-1", 5, "2026-05-30T01:00:00.000Z");
    expect(remaining.map((entry) => entry.memoryId)).toEqual(["memory-2"]);
    // The deleted memory is never re-handed out, even unclaimed.
    expect(remaining.some((entry) => entry.memoryId === "memory-1")).toBe(false);
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
    const claimed = claim(repo, "workspace-1", 5, "2026-05-30T01:00:00.000Z");
    expect(claimed).toHaveLength(1);
    expect(claim(repo, "workspace-1", 5, "2026-05-30T01:05:00.000Z")).toEqual([]);

    // A reclaim whose cutoff is BEFORE the claim time reclaims nothing (a still
    // in-flight cycle younger than the TTL is never pulled out from under itself).
    expect(repo.reclaimStale("2026-05-30T01:04:00.000Z", 5 * 60 * 1000)).toBe(0);

    // A reclaim whose cutoff is PAST the TTL re-arms the stranded claim.
    const reclaimed = repo.reclaimStale("2026-05-30T01:20:00.000Z", 10 * 60 * 1000);
    expect(reclaimed).toBe(1);

    // The previously stranded row is claimable again and a subsequent drain
    // processes it — enrichment is not silently lost on a daemon crash/restart.
    const redrained = claim(repo, "workspace-1", 5, "2026-05-30T01:21:00.000Z");
    expect(redrained.map((entry) => entry.memoryId)).toEqual(["memory-1"]);
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
    const claimed = claim(secondRepo, "workspace-1", 5, "2026-05-30T01:00:00.000Z");
    expect(claimed.map((entry) => entry.memoryId)).toEqual(["memory-1"]);
  });
});
