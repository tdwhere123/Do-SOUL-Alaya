import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "@do-soul/alaya-storage";
import { RECALL_PIPELINE_VERSION } from "../../shared/version.js";
import {
  BENCH_DAEMON_DB_FILENAME,
  assertSnapshotVersionMatch,
  checkpointAndCopyBenchDb,
  readSchemaMigrationVersion,
  readSnapshotManifest,
  readSnapshotSidecar,
  restoreSnapshotToDataDir,
  snapshotManifestPath,
  snapshotSidecarPath,
  writeSnapshotManifest,
  writeSnapshotSidecar,
  type LongMemEvalSnapshotManifest
} from "../../longmemeval/snapshot.js";

// @anchor recall-eval-snapshot-contract: checkpoint+copy, restore-to-working-
// copy, version binding, and sidecar/manifest round-trip. Uses a freshly
// migrated SQLite DB (no daemon needed for the file-plumbing assertions).

let tmpDir: string;

function freshMigratedDb(dbPath: string): void {
  // initDatabase runs migrations and caches the connection by path; closing it
  // releases the cache slot so checkpoint reopens cleanly.
  const db = initDatabase({ filename: dbPath });
  db.connection
    .prepare("CREATE TABLE IF NOT EXISTS snapshot_probe (k TEXT PRIMARY KEY)")
    .run();
  db.connection.prepare("INSERT OR REPLACE INTO snapshot_probe (k) VALUES (?)").run("v");
}

function manifestFor(
  dbPath: string,
  overrides: Partial<LongMemEvalSnapshotManifest> = {}
): LongMemEvalSnapshotManifest {
  return {
    schema_version: 1,
    variant: "longmemeval_oracle",
    question_count: 1,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    schema_migration_version: readSchemaMigrationVersion(dbPath),
    bench_runner_version: "0.3.11-test",
    alaya_commit: "test123",
    db_filename: "snapshot.db",
    sidecar_filename: "snapshot.db.sidecar.json",
    built_at: "2026-05-29T00:00:00Z",
    extraction_provenance: null,
    ...overrides
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "snapshot-test-"));
});

afterEach(async () => {
  // Close any cached connections so the cache map does not leak across tests.
  for (const path of [
    join(tmpDir, "live", BENCH_DAEMON_DB_FILENAME),
    join(tmpDir, "snapshot.db"),
    join(tmpDir, "restore", BENCH_DAEMON_DB_FILENAME)
  ]) {
    try {
      initDatabase({ filename: path }).close();
    } catch {
      // Path may not exist for a given test; ignore.
    }
  }
  await rm(tmpDir, { recursive: true, force: true });
});

describe("snapshot plumbing", () => {
  it("checkpoints + copies a live DB to a frozen snapshot path", () => {
    const liveDbPath = join(tmpDir, "live", BENCH_DAEMON_DB_FILENAME);
    freshMigratedDb(liveDbPath);
    const snapshotDbPath = join(tmpDir, "snapshot.db");
    checkpointAndCopyBenchDb(liveDbPath, snapshotDbPath);
    expect(existsSync(snapshotDbPath)).toBe(true);

    // The copy is a valid SQLite DB with the probe row preserved.
    const copy = initDatabase({ filename: snapshotDbPath });
    const row = copy.connection
      .prepare("SELECT k FROM snapshot_probe WHERE k = ?")
      .get("v") as { k: string } | undefined;
    expect(row?.k).toBe("v");
    copy.close();
  });

  it("restores a snapshot into a working copy under a dataDirRoot", () => {
    const liveDbPath = join(tmpDir, "live", BENCH_DAEMON_DB_FILENAME);
    freshMigratedDb(liveDbPath);
    const snapshotDbPath = join(tmpDir, "snapshot.db");
    checkpointAndCopyBenchDb(liveDbPath, snapshotDbPath);

    const restoreRoot = join(tmpDir, "restore");
    const returned = restoreSnapshotToDataDir({
      snapshotDbPath,
      dataDirRoot: restoreRoot
    });
    expect(returned).toBe(restoreRoot);
    const workingDbPath = join(restoreRoot, BENCH_DAEMON_DB_FILENAME);
    expect(existsSync(workingDbPath)).toBe(true);

    const working = initDatabase({ filename: workingDbPath });
    const row = working.connection
      .prepare("SELECT k FROM snapshot_probe WHERE k = ?")
      .get("v") as { k: string } | undefined;
    expect(row?.k).toBe("v");
    working.close();
  });

  it("round-trips the snapshot manifest + sidecar JSON", () => {
    const liveDbPath = join(tmpDir, "live", BENCH_DAEMON_DB_FILENAME);
    freshMigratedDb(liveDbPath);
    const snapshotDbPath = join(tmpDir, "snapshot.db");
    checkpointAndCopyBenchDb(liveDbPath, snapshotDbPath);

    const manifest = manifestFor(snapshotDbPath);
    writeSnapshotManifest(snapshotDbPath, manifest);
    writeSnapshotSidecar(snapshotDbPath, {
      schema_version: 1,
      variant: "longmemeval_oracle",
      questions: [
        {
          questionId: "q001",
          question: "what?",
          answerSessionIds: ["s-001"],
          workspaceId: "ws-001",
          runId: "run-001",
          sidecar: [
            {
              objectId: "mem-1",
              objectKind: "memory_entry",
              sessionId: "s-001",
              hasAnswer: true
            }
          ]
        }
      ]
    });
    expect(existsSync(snapshotManifestPath(snapshotDbPath))).toBe(true);
    expect(existsSync(snapshotSidecarPath(snapshotDbPath))).toBe(true);

    const readManifest = readSnapshotManifest(snapshotDbPath);
    expect(readManifest.recall_pipeline_version).toBe(RECALL_PIPELINE_VERSION);
    const readSidecar = readSnapshotSidecar(snapshotDbPath);
    expect(readSidecar.questions).toHaveLength(1);
    expect(readSidecar.questions[0]?.sidecar[0]?.objectId).toBe("mem-1");
  });

  it("passes the version-binding guard when pipeline + migration match", () => {
    const liveDbPath = join(tmpDir, "live", BENCH_DAEMON_DB_FILENAME);
    freshMigratedDb(liveDbPath);
    const snapshotDbPath = join(tmpDir, "snapshot.db");
    checkpointAndCopyBenchDb(liveDbPath, snapshotDbPath);
    const restoreRoot = join(tmpDir, "restore");
    restoreSnapshotToDataDir({ snapshotDbPath, dataDirRoot: restoreRoot });
    const restoredDbPath = join(restoreRoot, BENCH_DAEMON_DB_FILENAME);

    expect(() =>
      assertSnapshotVersionMatch(manifestFor(restoredDbPath), restoredDbPath)
    ).not.toThrow();
  });

  it("throws on a recall_pipeline_version mismatch (pipeline changed)", () => {
    const liveDbPath = join(tmpDir, "live", BENCH_DAEMON_DB_FILENAME);
    freshMigratedDb(liveDbPath);
    const snapshotDbPath = join(tmpDir, "snapshot.db");
    checkpointAndCopyBenchDb(liveDbPath, snapshotDbPath);
    const restoreRoot = join(tmpDir, "restore");
    restoreSnapshotToDataDir({ snapshotDbPath, dataDirRoot: restoreRoot });
    const restoredDbPath = join(restoreRoot, BENCH_DAEMON_DB_FILENAME);

    expect(() =>
      assertSnapshotVersionMatch(
        manifestFor(restoredDbPath, {
          recall_pipeline_version: "stale-pipeline-v0"
        }),
        restoredDbPath
      )
    ).toThrow(/recall_pipeline_version/u);
  });

  it("throws on a schema_migration_version mismatch (schema migrated)", () => {
    const liveDbPath = join(tmpDir, "live", BENCH_DAEMON_DB_FILENAME);
    freshMigratedDb(liveDbPath);
    const snapshotDbPath = join(tmpDir, "snapshot.db");
    checkpointAndCopyBenchDb(liveDbPath, snapshotDbPath);
    const restoreRoot = join(tmpDir, "restore");
    restoreSnapshotToDataDir({ snapshotDbPath, dataDirRoot: restoreRoot });
    const restoredDbPath = join(restoreRoot, BENCH_DAEMON_DB_FILENAME);

    expect(() =>
      assertSnapshotVersionMatch(
        manifestFor(restoredDbPath, { schema_migration_version: 99999 }),
        restoredDbPath
      )
    ).toThrow(/schema_migration_version/u);
  });
});
