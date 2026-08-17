import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readWarmDerivedSnapshotReceipt
} from "../../../bench/snapshot/recall-eval/warm-derived/warm-derived-snapshot-receipt.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warm-derived-receipt-"));
  await mkdir(join(root, "sealed-db"));
  await writeFile(join(root, "sealed-db", "alaya.db"), "sealed");
});

afterEach(async () => {
  await removeTempDirectory(root);
});

describe("warm derived snapshot receipt", () => {
  it("binds the source snapshot, sealed DB, and rebuild report", async () => {
    const receiptPath = await writeReceipt();

    const restored = readWarmDerivedSnapshotReceipt({
      receiptPath,
      sourceSnapshotDbSha256: SHA_A,
      sourceSchemaVersion: 113
    });
    expect(restored).toEqual({
      databasePath: join(root, "sealed-db", "alaya.db"),
      databaseSha256: SHA_B,
      databaseSchemaVersion: 115,
      receiptSha256: createHash("sha256")
        .update(await readFile(receiptPath))
        .digest("hex"),
      rebuildReport: expect.objectContaining({
        input_db_sha256: SHA_A,
        rebuilt_db_identity_sha256: SHA_C,
        working_schema_version: 115
      })
    });
  });

  it("rejects a receipt for another source snapshot", async () => {
    const receiptPath = await writeReceipt();

    expect(() => readWarmDerivedSnapshotReceipt({
      receiptPath,
      sourceSnapshotDbSha256: SHA_C,
      sourceSchemaVersion: 113
    })).toThrow(/source snapshot SHA-256 binding mismatch/u);
  });

  it("rejects a sealed DB path outside the receipt directory", async () => {
    const receiptPath = await writeReceipt({ databasePath: "../outside.db" });

    expect(() => readWarmDerivedSnapshotReceipt({
      receiptPath,
      sourceSnapshotDbSha256: SHA_A,
      sourceSchemaVersion: 113
    })).toThrow(/database path must stay within the receipt directory/u);
  });

  it("rejects an intermediate symlink that escapes the receipt directory", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "warm-derived-outside-"));
    try {
      await writeFile(join(outsideRoot, "alaya.db"), "outside");
      await symlink(outsideRoot, join(root, "linked-db"), "dir");
      const receiptPath = await writeReceipt({ databasePath: "linked-db/alaya.db" });

      expect(() => readWarmDerivedSnapshotReceipt({
        receiptPath,
        sourceSnapshotDbSha256: SHA_A,
        sourceSchemaVersion: 113
      })).toThrow(/database path must stay within the receipt directory/u);
    } finally {
      await removeTempDirectory(outsideRoot);
    }
  });

  it("rejects a promotable derived rebuild report", async () => {
    const receiptPath = await writeReceipt({ promotable: true });

    expect(() => readWarmDerivedSnapshotReceipt({
      receiptPath,
      sourceSnapshotDbSha256: SHA_A,
      sourceSchemaVersion: 113
    })).toThrow(/rebuild report must be non-promotable/u);
  });

  it("rejects a sealed DB identity that differs from the rebuild report", async () => {
    const receiptPath = await writeReceipt({ databaseRebuildIdentity: SHA_B });

    expect(() => readWarmDerivedSnapshotReceipt({
      receiptPath,
      sourceSnapshotDbSha256: SHA_A,
      sourceSchemaVersion: 113
    })).toThrow(/derived rebuild identity mismatch/u);
  });
});

async function writeReceipt(overrides: Readonly<{
  databasePath?: string;
  promotable?: boolean;
  databaseRebuildIdentity?: string;
}> = {}): Promise<string> {
  const receiptPath = join(root, "warm-derived-snapshot.json");
  const report = {
    schema_version: 1,
    promotable: overrides.promotable ?? false,
    input_db_sha256: SHA_A,
    rebuilt_db_identity_sha256: SHA_C,
    source_schema_version: 113,
    working_schema_version: 115,
    eligible_owner_count: 318,
    rebuilt_owner_count: 313,
    rejected_owner_count: 5,
    zero_child_owner_count: 5,
    nonzero_child_owner_count: 313,
    child_count: 313,
    projection_kind_counts: [{ projection_kind: "fact_key", child_count: 313 }],
    projection_content_sha256: SHA_C
  };
  await writeFile(receiptPath, `${JSON.stringify({
    schema_version: 1,
    kind: "longmemeval_warm_derived_snapshot",
    source_snapshot_db_sha256: SHA_A,
    database: {
      path: overrides.databasePath ?? "sealed-db/alaya.db",
      sha256: SHA_B,
      schema_version: 115,
      derived_rebuild_identity_sha256:
        overrides.databaseRebuildIdentity ?? SHA_C
    },
    derived_evidence_projection_rebuild: report
  }, null, 2)}\n`);
  return receiptPath;
}
