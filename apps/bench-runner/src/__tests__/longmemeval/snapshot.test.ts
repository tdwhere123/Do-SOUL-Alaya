import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "@do-soul/alaya-storage";
import { RECALL_PIPELINE_VERSION } from "../../shared/version.js";
import {
  BENCH_DAEMON_DB_FILENAME,
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
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
import { EXTRACTION_CACHE_MANIFEST_VERSION } from "../../longmemeval/extraction-cache-manifest.js";

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
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
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
  }, 30_000);

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
      schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
      variant: "longmemeval_oracle",
      questions: [
        {
          questionId: "q001",
          question: "what?",
          questionDate: "2026-01-02T00:00:00.000Z",
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
    expect(readManifest.attribution).toEqual({
      status: "legacy_unattributed",
      gate_eligible: false
    });
    const readSidecar = readSnapshotSidecar(snapshotDbPath);
    expect(readSidecar.questions).toHaveLength(1);
    expect(readSidecar.questions[0]?.sidecar[0]?.objectId).toBe("mem-1");
  });

  it("rejects an attributed manifest when its binding evidence is incomplete", () => {
    const snapshotDbPath = join(tmpDir, "snapshot.db");
    writeSnapshotManifest(snapshotDbPath, manifestFor(snapshotDbPath, {
      attribution: { status: "attributed", gate_eligible: false }
    }));

    expect(() => readSnapshotManifest(snapshotDbPath)).toThrow(
      /attributed snapshot manifest.*incomplete/u
    );
  });

  it("rejects v2 snapshot extraction provenance without model_family", () => {
    const snapshotDbPath = join(tmpDir, "snapshot.db");
    writeSnapshotManifest(snapshotDbPath, manifestFor(snapshotDbPath, {
      extraction_provenance: {
        manifest_sha256: "a".repeat(64),
        schema_version: 2,
        extraction_model: "fixture-model",
        provider_url: `sha256:${"b".repeat(64)}`,
        system_prompt_sha256: "c".repeat(64),
        cache_key_algo: "fixture-v1",
        dataset: "longmemeval-s",
        dataset_revision: "d".repeat(64)
      } as LongMemEvalSnapshotManifest["extraction_provenance"]
    }));
    expect(() => readSnapshotManifest(snapshotDbPath)).toThrow(
      /extraction provenance.*model_family/u
    );
  });

  it("requires a closed request_profile on v3 snapshot extraction provenance", () => {
    const snapshotDbPath = join(tmpDir, "snapshot.db");
    const common = {
      manifest_sha256: "a".repeat(64),
      schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
      extraction_model: "fixture-model",
      model_family: "fixture-family",
      provider_url: `sha256:${"b".repeat(64)}`,
      system_prompt_sha256: "c".repeat(64),
      cache_key_algo: "fixture-v1",
      dataset: "longmemeval-s",
      dataset_revision: "d".repeat(64)
    };
    writeSnapshotManifest(snapshotDbPath, manifestFor(snapshotDbPath, {
      extraction_provenance: common as LongMemEvalSnapshotManifest["extraction_provenance"]
    }));
    expect(() => readSnapshotManifest(snapshotDbPath)).toThrow(
      /extraction provenance.*request_profile/u
    );

    writeSnapshotManifest(snapshotDbPath, manifestFor(snapshotDbPath, {
      extraction_provenance: {
        ...common,
        request_profile: "deepseek-v4-nonthinking-v1"
      } as LongMemEvalSnapshotManifest["extraction_provenance"]
    }));
    expect(readSnapshotManifest(snapshotDbPath).extraction_provenance).toMatchObject({
      schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
      request_profile: "deepseek-v4-nonthinking-v1"
    });
  });

  it.each([
    [undefined, /missing questionDate/u],
    ["2026-02-31", /invalid questionDate/u],
    ["2026/01/02 (Fri) 00:00", /normalized ISO questionDate/u]
  ])("rejects a snapshot sidecar with a non-canonical question date", (questionDate, error) => {
    const snapshotDbPath = join(tmpDir, "snapshot.db");
    writeFileSync(snapshotSidecarPath(snapshotDbPath), JSON.stringify({
      schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
      variant: "longmemeval_oracle",
      questions: [{
        questionId: "q001",
        question: "what?",
        ...(questionDate === undefined ? {} : { questionDate }),
        answerSessionIds: [],
        workspaceId: "ws-001",
        runId: "run-001",
        sidecar: []
      }]
    }));

    expect(() => readSnapshotSidecar(snapshotDbPath)).toThrow(error);
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
