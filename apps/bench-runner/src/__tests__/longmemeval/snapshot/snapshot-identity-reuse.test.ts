import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeCachedDatabase, initDatabase } from "@do-soul/alaya-storage";
import { RecallEvalAttributionSchema } from "../../../../../../packages/eval/src/contracts/kpi-schema.js";
import {
  RECALL_RANKING_IDENTITY,
  SNAPSHOT_SEED_IDENTITY
} from "../../../shared/version.js";
import { buildRecallEvalSnapshotBinding } from
  "../../../runs/lifecycle/recall-eval/recall-eval-runtime.js";
import {
  BENCH_DAEMON_DB_FILENAME,
  RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
  checkpointAndCopyBenchDb,
  restoreSnapshotToDataDir,
  type LongMemEvalSnapshotManifest
} from "../../../runs/snapshot/materialize.js";
import {
  assertSnapshotConsumeIdentity,
  readSchemaMigrationVersion
} from "../../../runs/snapshot/snapshot-seed-identity.js";
import { hashRegularFileNoFollow } from "../../../runs/snapshot/bound-file.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "snapshot-identity-reuse-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("snapshot seed vs ranking consume", () => {
  it("ranking-only identity drift still consumes the sealed snapshot", () => {
    const restoredDbPath = restoreFreshSnapshot();
    expect(() => assertSnapshotConsumeIdentity({
      manifest: manifestFor(restoredDbPath, {
        recall_pipeline_version: "seed-v3"
      }),
      restoredDbPath,
      runningSeedIdentity: "seed-v3"
    })).not.toThrow();
    expect("seed-v3").not.toBe(RECALL_RANKING_IDENTITY);
  });

  it("seed-only identity drift refuses the old snapshot", () => {
    const restoredDbPath = restoreFreshSnapshot();
    expect(() => assertSnapshotConsumeIdentity({
      manifest: manifestFor(restoredDbPath, {
        recall_pipeline_version: "stale-seed-v0"
      }),
      restoredDbPath,
      runningSeedIdentity: "seed-v3"
    })).toThrow(/seed identity/u);
  });

  it("refuses a restored DB whose packed snapshot bytes drifted", () => {
    const restoredDbPath = restoreFreshSnapshot();
    expect(() => assertSnapshotConsumeIdentity({
      manifest: manifestFor(restoredDbPath, {
        recall_pipeline_version: SNAPSHOT_SEED_IDENTITY,
        artifact_integrity: {
          db_sha256: "0".repeat(64),
          sidecar_sha256: "1".repeat(64)
        }
      }),
      restoredDbPath,
      runningSeedIdentity: SNAPSHOT_SEED_IDENTITY
    })).toThrow(/snapshot DB SHA-256/u);
  });

  it("hashes the sealed snapshot, not a recycled workspace-slice working copy", () => {
    const sealed = restoreFreshSnapshot();
    const slicePath = join(tmpDir, "slice.db");
    const slice = initDatabase({ filename: slicePath });
    slice.connection.exec("CREATE TABLE IF NOT EXISTS snapshot_probe (k TEXT PRIMARY KEY)");
    slice.connection.exec("CREATE TABLE IF NOT EXISTS slice_only (k TEXT PRIMARY KEY)");
    closeCachedDatabase(slicePath);
    expect(hashRegularFileNoFollow(slicePath)).not.toBe(hashRegularFileNoFollow(sealed));
    expect(() => assertSnapshotConsumeIdentity({
      manifest: manifestFor(sealed, {
        recall_pipeline_version: SNAPSHOT_SEED_IDENTITY
      }),
      restoredDbPath: slicePath,
      snapshotBytePath: sealed,
      runningSeedIdentity: SNAPSHOT_SEED_IDENTITY
    })).not.toThrow();
    expect(() => assertSnapshotConsumeIdentity({
      manifest: manifestFor(sealed, {
        recall_pipeline_version: SNAPSHOT_SEED_IDENTITY
      }),
      restoredDbPath: slicePath,
      runningSeedIdentity: SNAPSHOT_SEED_IDENTITY
    })).toThrow(/snapshot DB SHA-256/u);
  });

  it("omits unknown snapshot_binding keys so strict KPI attribution still parses", () => {
    const restoredDbPath = restoreFreshSnapshot();
    const binding = buildRecallEvalSnapshotBinding(
      manifestFor(restoredDbPath),
      "d".repeat(64)
    );
    expect(binding).not.toHaveProperty("consumer_seed_identity");
    expect(binding).not.toHaveProperty("consumer_ranking_identity");
    expect(binding.producer_recall_pipeline_version).toBe(SNAPSHOT_SEED_IDENTITY);
    expect(binding.consumer_recall_pipeline_version).toBe(RECALL_RANKING_IDENTITY);
    expect(RecallEvalAttributionSchema.shape.snapshot_binding.parse(binding))
      .toEqual(binding);
  });
});

function restoreFreshSnapshot(): string {
  const liveDbPath = join(tmpDir, "live", BENCH_DAEMON_DB_FILENAME);
  const db = initDatabase({ filename: liveDbPath });
  db.connection.exec("CREATE TABLE IF NOT EXISTS snapshot_probe (k TEXT PRIMARY KEY)");
  closeCachedDatabase(liveDbPath);
  const snapshotDbPath = join(tmpDir, "snapshot.db");
  checkpointAndCopyBenchDb(liveDbPath, snapshotDbPath);
  const restoreRoot = join(tmpDir, "restore");
  restoreSnapshotToDataDir({ snapshotDbPath, dataDirRoot: restoreRoot });
  return join(restoreRoot, BENCH_DAEMON_DB_FILENAME);
}

function manifestFor(
  dbPath: string,
  overrides: Partial<LongMemEvalSnapshotManifest> = {}
): LongMemEvalSnapshotManifest {
  return {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: "longmemeval_oracle",
    question_count: 1,
    recall_pipeline_version: SNAPSHOT_SEED_IDENTITY,
    schema_migration_version: readSchemaMigrationVersion(dbPath),
    bench_runner_version: "0.3.11-test",
    alaya_commit: "test123",
    db_filename: "snapshot.db",
    sidecar_filename: "snapshot.db.sidecar.json",
    built_at: "2026-05-29T00:00:00Z",
    extraction_provenance: null,
    question_id_digest: "a".repeat(64),
    dataset_sha256: "b".repeat(64),
    artifact_integrity: {
      db_sha256: hashRegularFileNoFollow(dbPath),
      sidecar_sha256: "c".repeat(64)
    },
    ...overrides
  };
}
