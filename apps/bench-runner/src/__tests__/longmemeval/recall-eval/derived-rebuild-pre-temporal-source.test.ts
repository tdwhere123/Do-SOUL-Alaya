import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSchemaMigrationLedger,
  TEMPORAL_OFFLINE_MIGRATION_VERSION
} from "@do-soul/alaya-storage";
import { rebuildEvidenceSearchProjectionsOnWorkingCopy } from
  "../../../bench/snapshot/recall-eval/evidence-search-projection-rebuild.js";
import { prepareRecallEvalRestoredDb } from
  "../../../bench/snapshot/recall-eval/recall-eval-db.js";
import type { LongMemEvalSnapshotManifest } from
  "../../../bench/snapshot/materialize.js";
import { RECALL_PIPELINE_VERSION } from "../../../shared/version.js";

const APPLIED_AT = "2026-08-19T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("derived evidence projection rebuild pre-temporal source", () => {
  it("rejects a working copy below the temporal offline version before any mutation", async () => {
    const dbPath = await createPreTemporalLedger();
    const before = await fileIdentity(dbPath);

    await expect(rebuildEvidenceSearchProjectionsOnWorkingCopy({
      workingDbPath: dbPath
    })).rejects.toThrow(
      `derived evidence projection rebuild requires working schema ${TEMPORAL_OFFLINE_MIGRATION_VERSION} or newer`
    );

    expect(await fileIdentity(dbPath)).toEqual(before);
  });

  it("rejects a restored snapshot below the temporal offline version before any mutation", async () => {
    const dbPath = await createPreTemporalLedger();
    const sourceVersion = readSchemaMigrationLedger(dbPath).at(-1);
    const before = await fileIdentity(dbPath);

    expect(() => prepareRecallEvalRestoredDb({
      manifest: derivedRebuildManifest(sourceVersion!),
      restoredDbPath: dbPath,
      legacySnapshot: false,
      derivedEvidenceProjectionRebuild: true
    })).toThrow(
      `[recall-eval] derived rebuild requires snapshot schema ${TEMPORAL_OFFLINE_MIGRATION_VERSION} or newer`
    );

    expect(await fileIdentity(dbPath)).toEqual(before);
  });
});

async function createPreTemporalLedger(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "derived-rebuild-pre-temporal-"));
  roots.push(root);
  const dbPath = join(root, "alaya.db");
  const database = new BetterSqlite3(dbPath);
  try {
    database.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    database.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
    ).run(TEMPORAL_OFFLINE_MIGRATION_VERSION - 1, APPLIED_AT);
  } finally {
    database.close();
  }
  return dbPath;
}

function derivedRebuildManifest(schemaMigrationVersion: number): LongMemEvalSnapshotManifest {
  return {
    schema_version: 1,
    variant: "longmemeval_s",
    question_count: 0,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    schema_migration_version: schemaMigrationVersion,
    bench_runner_version: "test",
    alaya_commit: "0000000",
    db_filename: "alaya.db",
    sidecar_filename: "alaya.db.sidecar.json",
    built_at: APPLIED_AT,
    extraction_provenance: null
  };
}

async function fileIdentity(filePath: string): Promise<Readonly<{
  readonly sha256: string;
  readonly ledger: readonly number[];
  readonly userTables: readonly string[];
}>> {
  return {
    sha256: createHash("sha256").update(await readFile(filePath)).digest("hex"),
    ledger: readSchemaMigrationLedger(filePath),
    userTables: listUserTables(filePath)
  };
}

function listUserTables(dbPath: string): readonly string[] {
  const database = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as ReadonlyArray<{ name: string }>;
    return Object.freeze(rows.map((row) => row.name));
  } finally {
    database.close();
  }
}
