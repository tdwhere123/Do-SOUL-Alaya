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

async function sourceWithLedgerMutation(sql = "DELETE FROM schema_version WHERE version = 104"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "legacy-compatibility-"));
  roots.push(root);
  const path = join(root, "source.db");
  const db = initDatabase({ filename: path });
  db.connection.exec(sql);
  db.close();
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy snapshot migration compatibility", () => {
  it("checks the frozen producer before migrating only the working copy", async () => {
    const source = await sourceWithLedgerMutation();
    expect(() => assertLegacySnapshotSourceCompatibility(manifest(), source)).not.toThrow();
    const working = join(source, "..", "working.db");
    copyFileSync(source, working);
    expect(() => prepareLegacySnapshotConsumer(manifest(), working)).not.toThrow();
    expect(readSchemaMigrationLedger(source).at(-1)).toBe(103);
    expect(readSchemaMigrationLedger(working).at(-1)).toBe(104);
    initDatabase({ filename: working }).close();
  });

  it("rejects lower, higher, incomplete, or pipeline-drifted producer tuples", async () => {
    const lower = await sourceWithLedgerMutation(
      "DELETE FROM schema_version WHERE version IN (103, 104)"
    );
    expect(() => assertLegacySnapshotSourceCompatibility(manifest(), lower)).toThrow(/ledger mismatch/u);
    const higher = await sourceWithLedgerMutation("");
    expect(() => assertLegacySnapshotSourceCompatibility(manifest(), higher)).toThrow(/ledger mismatch/u);
    const incomplete = await sourceWithLedgerMutation(
      "DELETE FROM schema_version WHERE version IN (50, 104)"
    );
    expect(() => assertLegacySnapshotSourceCompatibility(manifest(), incomplete)).toThrow(/ledger mismatch/u);
    expect(() => assertLegacySnapshotSourceCompatibility({
      ...manifest(), recall_pipeline_version: "future-pipeline"
    }, lower)).toThrow(/compatibility mismatch/u);
  });
});
