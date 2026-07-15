import { copyFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initDatabase,
  readSchemaMigrationLedger
} from "@do-soul/alaya-storage";
import { afterEach, describe, expect, it } from "vitest";
import type { LongMemEvalSnapshotManifest } from "../../../longmemeval/snapshot.js";
import {
  assertLegacySnapshotSourceCompatibility,
  prepareLegacySnapshotConsumer
} from "../../../longmemeval/snapshot/legacy-compatibility.js";
import {
  createDatabaseThroughMigration,
  executeSqlite
} from "./legacy-database-fixture.js";

const roots: string[] = [];

function manifest(): LongMemEvalSnapshotManifest {
  return {
    schema_version: 1,
    variant: "longmemeval_s",
    question_count: 1,
    recall_pipeline_version: "fusion-rrf-synthesis-v2",
    schema_migration_version: 103,
    bench_runner_version: "0.3.11",
    alaya_commit: "d7266aa",
    db_filename: "snapshot.db",
    sidecar_filename: "snapshot.db.sidecar.json",
    built_at: "2026-07-12T00:00:00.000Z",
    extraction_provenance: null
  };
}

async function sourceAtMigration(
  maxVersion = 103,
  sql?: string
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "legacy-compatibility-"));
  roots.push(root);
  const path = join(root, "source.db");
  createDatabaseThroughMigration(path, maxVersion);
  if (sql !== undefined) executeSqlite(path, sql);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy snapshot migration compatibility", () => {
  it("checks the frozen producer before migrating only the working copy", async () => {
    const source = await sourceAtMigration();
    expect(() => assertLegacySnapshotSourceCompatibility(manifest(), source)).not.toThrow();
    const working = join(source, "..", "working.db");
    copyFileSync(source, working);
    expect(() => prepareLegacySnapshotConsumer(manifest(), working)).not.toThrow();
    expect(readSchemaMigrationLedger(source).at(-1)).toBe(103);
    expect(readSchemaMigrationLedger(working).at(-1)).toBe(106);
    initDatabase({ filename: working }).close();
  });

  it("rejects a lower producer ledger", async () => {
    const lower = await sourceAtMigration(102);
    expect(() => assertLegacySnapshotSourceCompatibility(manifest(), lower)).toThrow(/ledger mismatch/u);
  });

  it("rejects a higher producer ledger", async () => {
    const higher = await sourceAtMigration();
    initDatabase({ filename: higher }).close();
    expect(() => assertLegacySnapshotSourceCompatibility(manifest(), higher)).toThrow(/ledger mismatch/u);
  });

  it("rejects an incomplete producer ledger", async () => {
    const incomplete = await sourceAtMigration(
      103,
      "DELETE FROM schema_version WHERE version = 50"
    );
    expect(() => assertLegacySnapshotSourceCompatibility(manifest(), incomplete)).toThrow(/ledger mismatch/u);
  });

  it("rejects a pipeline-drifted producer tuple", async () => {
    const lower = await sourceAtMigration(102);
    expect(() => assertLegacySnapshotSourceCompatibility({
      ...manifest(), recall_pipeline_version: "future-pipeline"
    }, lower)).toThrow(/compatibility mismatch/u);
  });
});
