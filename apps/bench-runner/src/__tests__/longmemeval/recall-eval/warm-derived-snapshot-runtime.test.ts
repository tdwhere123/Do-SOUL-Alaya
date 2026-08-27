import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, readSchemaMigrationLedger } from "@do-soul/alaya-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareRecallEvalDataRoot } from
  "../../../bench/lifecycle/recall-eval/recall-eval-runtime.js";
import { openRecallEvalWorkingSqlite, recallEvalWorkingDbPath } from
  "../../../bench/snapshot/recall-eval/recall-eval-working-sqlite.js";
import { readWarmDerivedSnapshotReceipt } from
  "../../../bench/snapshot/recall-eval/warm-derived/warm-derived-snapshot-receipt.js";
import type { RecallEvalSnapshotBundle } from
  "../../../bench/snapshot/recall-eval/recall-eval-loader.js";
import { sha256File } from "../../../bench/snapshot/integrity.js";
import type { LongMemEvalSnapshotManifest } from
  "../../../bench/snapshot/materialize.js";
import { SNAPSHOT_SEED_IDENTITY } from "../../../shared/version.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";

const SOURCE_SHA = "a".repeat(64);
const REPORT_IDENTITY = "b".repeat(64);
const PROJECTION_SHA = "c".repeat(64);

let root: string;
let databasePath: string;
let databaseSha256: string;
let databaseSchemaVersion: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warm-derived-runtime-"));
  databasePath = join(root, "sealed.db");
  const db = initDatabase({ filename: databasePath });
  db.close();
  databaseSha256 = await sha256File(databasePath);
  databaseSchemaVersion = readSchemaMigrationLedger(databasePath).at(-1)!;
});

afterEach(async () => {
  await removeTempDirectory(root);
});

describe("warm derived snapshot restore", () => {
  it("restores the sealed DB and carries its non-promotable identity", async () => {
    const receiptPath = await writeReceipt();
    const dataDirRoot = join(root, "working");

    const prepared = await prepareRecallEvalDataRoot(
      options(receiptPath, dataDirRoot), bundle()
    );

    expect(await readFile(join(dataDirRoot, "alaya.db"))).toEqual(
      await readFile(databasePath)
    );
    expect(prepared.evidenceProjectionRebuild).toMatchObject({
      promotable: false,
      rebuilt_db_identity_sha256: REPORT_IDENTITY
    });
    expect(prepared.warmDerivedSnapshot).toMatchObject({
      database_sha256: databaseSha256,
      database_schema_version: databaseSchemaVersion,
      derived_rebuild_identity_sha256: REPORT_IDENTITY
    });
  }, 20_000);

  it("rejects a sealed DB whose physical SHA differs from the receipt", async () => {
    const receiptPath = await writeReceipt({ databaseSha256: "d".repeat(64) });

    await expect(prepareRecallEvalDataRoot(
      options(receiptPath, join(root, "sha-mismatch")), bundle()
    )).rejects.toThrow(/SHA-256 mismatch/u);
  });

  it("rejects a sealed DB whose migration ledger differs from the receipt", async () => {
    const receiptPath = await writeReceipt({
      databaseSchemaVersion: databaseSchemaVersion + 1
    });
    const dataDirRoot = join(root, "schema-mismatch");
    await prepareRecallEvalDataRoot(
      options(receiptPath, dataDirRoot), bundle()
    );

    await expect(openRecallEvalWorkingSqlite({
      restoredDbPath: recallEvalWorkingDbPath(dataDirRoot),
      options: options(receiptPath, dataDirRoot),
      manifest: bundle().manifest,
      warm: readWarmDerivedSnapshotReceipt({
        receiptPath,
        sourceSnapshotDbSha256: SOURCE_SHA,
        sourceSchemaVersion: 113
      })
    })).rejects.toThrow(/schema binding mismatch/u);
  });
});

function options(receiptPath: string, dataDirRoot: string) {
  return {
    snapshotDbPath: join(root, "source.db"),
    variant: "longmemeval_s" as const,
    historyRoot: join(root, "history"),
    experiment: true,
    warmDerivedSnapshotReceiptPath: receiptPath,
    dataDirRoot
  };
}

function bundle(): RecallEvalSnapshotBundle {
  return {
    snapshotDbPath: join(root, "immutable-source.db"),
    manifest: {
      artifact_integrity: {
        db_sha256: SOURCE_SHA,
        sidecar_sha256: "e".repeat(64)
      },
      schema_migration_version: 113,
      recall_pipeline_version: SNAPSHOT_SEED_IDENTITY
    } as LongMemEvalSnapshotManifest
  } as RecallEvalSnapshotBundle;
}

async function writeReceipt(overrides: Readonly<{
  databaseSha256?: string;
  databaseSchemaVersion?: number;
}> = {}): Promise<string> {
  const receiptPath = join(root, `receipt-${Math.random()}.json`);
  const workingVersion = overrides.databaseSchemaVersion ?? databaseSchemaVersion;
  await writeFile(receiptPath, `${JSON.stringify({
    schema_version: 1,
    kind: "longmemeval_warm_derived_snapshot",
    source_snapshot_db_sha256: SOURCE_SHA,
    database: {
      path: "sealed.db",
      sha256: overrides.databaseSha256 ?? databaseSha256,
      schema_version: workingVersion,
      derived_rebuild_identity_sha256: REPORT_IDENTITY
    },
    derived_evidence_projection_rebuild: rebuildReport(workingVersion)
  }, null, 2)}\n`);
  return receiptPath;
}

function rebuildReport(workingSchemaVersion: number) {
  return {
    schema_version: 1,
    promotable: false,
    input_db_sha256: SOURCE_SHA,
    rebuilt_db_identity_sha256: REPORT_IDENTITY,
    source_schema_version: 113,
    working_schema_version: workingSchemaVersion,
    eligible_owner_count: 1,
    rebuilt_owner_count: 1,
    rejected_owner_count: 0,
    zero_child_owner_count: 0,
    nonzero_child_owner_count: 1,
    child_count: 1,
    projection_kind_counts: [{ projection_kind: "fact_key", child_count: 1 }],
    projection_content_sha256: PROJECTION_SHA
  };
}
