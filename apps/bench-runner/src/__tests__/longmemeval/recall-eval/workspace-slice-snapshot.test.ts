import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  closeCachedDatabase,
  initDatabase
} from "@do-soul/alaya-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertQuiescentMainDb,
  digestWorkspaceSliceSnapshotIdentity,
  explodePackedWorkingCopy,
  explodeRecallEvalWorkingCopyIfNeeded,
  installRecallEvalWorkspaceSlice,
  installWorkspaceSlice,
  loadSliceIntoOpenDatabase,
  readValidWorkspaceSliceSnapshotDigest,
  sealFinalizedWorkspaceSlice,
  WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION,
  WORKSPACE_SLICE_SNAPSHOT_SIDECAR_FILENAME,
  workingAlayaDbPath
} from "../../../bench/snapshot/recall-eval/workspace-slice/index.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";
import {
  createPackedTwoWorkspaceDb,
  MEMORY_A,
  TOKEN_A,
  WORKSPACE_A,
  WORKSPACE_B
} from "./workspace-slice-fixture.js";

const previousWriteQueue = process.env.ALAYA_SQLITE_WRITE_QUEUE;

let root: string;
let packedPath: string;

beforeEach(async () => {
  process.env.ALAYA_SQLITE_WRITE_QUEUE = "0";
  root = await mkdtemp(join(tmpdir(), "workspace-slice-snapshot-"));
  packedPath = join(root, "packed.alaya.db");
  await createPackedTwoWorkspaceDb(packedPath);
});

afterEach(async () => {
  closeCachedDatabase(packedPath);
  if (previousWriteQueue === undefined) {
    delete process.env.ALAYA_SQLITE_WRITE_QUEUE;
  } else {
    process.env.ALAYA_SQLITE_WRITE_QUEUE = previousWriteQueue;
  }
  await removeTempDirectory(root);
});

describe("workspace slice snapshot identity", () => {
  it("binds recipe version, workspace, and packed bytes separately", () => {
    const fileHash = "a".repeat(64);
    const first = digestWorkspaceSliceSnapshotIdentity({
      workspaceId: WORKSPACE_A,
      sqliteMainFileSha256: fileHash
    });
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(digestWorkspaceSliceSnapshotIdentity({
      workspaceId: WORKSPACE_B,
      sqliteMainFileSha256: fileHash
    })).not.toBe(first);
    expect(digestWorkspaceSliceSnapshotIdentity({
      workspaceId: WORKSPACE_A,
      sqliteMainFileSha256: "b".repeat(64)
    })).not.toBe(first);
    expect(digestWorkspaceSliceSnapshotIdentity({
      workspaceId: WORKSPACE_A,
      sqliteMainFileSha256: fileHash,
      recipeVersion: "v2"
    })).not.toBe(first);
    expect(digestWorkspaceSliceSnapshotIdentity({
      workspaceId: WORKSPACE_A,
      sqliteMainFileSha256: fileHash,
      recipeVersion: WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION
    })).toBe(first);
  });

  it("seals a stable explode digest distinct from the packed corpus hash", async () => {
    const first = await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir: join(root, "slices-a"),
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    const second = await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir: join(root, "slices-b"),
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    expect(first.sliceSnapshotDigests[WORKSPACE_A]).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.sliceSnapshotDigests).toEqual(second.sliceSnapshotDigests);
    expect(first.sliceSnapshotDigests[WORKSPACE_A])
      .not.toBe(first.sliceSnapshotDigests[WORKSPACE_B]);
    const packedHex = sha256File(packedPath);
    expect(first.sliceSnapshotDigests[WORKSPACE_A]).not.toBe(`sha256:${packedHex}`);
    const sidecar = readSidecar(first.sliceDbPaths[WORKSPACE_A]!);
    expect(sidecar.sqlite_main_file_sha256).not.toBe(packedHex);
    expect(sidecar.recipe_version).toBe(WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION);
    expect(readValidWorkspaceSliceSnapshotDigest({
      workspaceId: WORKSPACE_A,
      dbPath: first.sliceDbPaths[WORKSPACE_A]!
    })).toBe(first.sliceSnapshotDigests[WORKSPACE_A]);
  });

  it("fails closed on leftover WAL and incomplete checkpoint", () => {
    const dirtyPath = join(root, "dirty.db");
    const dirty = new BetterSqlite3(dirtyPath);
    dirty.pragma("journal_mode = WAL");
    dirty.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('a')");
    expect(() => assertQuiescentMainDb(dirtyPath)).toThrow(/leftover WAL/i);
    dirty.close();

    const filename = join(root, "locked.db");
    const database = initDatabase({ filename, busyTimeoutMs: 0 });
    const reader = new BetterSqlite3(filename);
    reader.pragma("busy_timeout = 0");
    reader.exec("BEGIN");
    reader.prepare("SELECT 1 FROM sqlite_master").get();
    database.connection.exec("ANALYZE");
    expect(() => sealFinalizedWorkspaceSlice({
      workspaceId: WORKSPACE_A,
      dbPath: filename,
      database
    })).toThrow(/checkpoint/i);
    reader.exec("ROLLBACK");
    reader.close();
    if (!database.isClosed()) database.close({ optimize: false });
    closeCachedDatabase(filename);
  });

  it("reuses a matching sidecar and rebuilds when it is missing or mismatched", async () => {
    expect(readValidWorkspaceSliceSnapshotDigest({
      workspaceId: WORKSPACE_A,
      dbPath: join(root, "missing", "alaya.db")
    })).toBeNull();
    const dataDir = join(root, "reuse-data");
    installWorkspaceSlice({ dataDir, sliceDbPath: packedPath });
    const first = await explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: dataDir });
    expect(first).not.toBeNull();
    const reused = await explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: dataDir });
    expect(reused?.sliceDbPaths[WORKSPACE_A]).toBe(first!.sliceDbPaths[WORKSPACE_A]);
    expect(reused?.sliceSnapshotDigests).toEqual(first!.sliceSnapshotDigests);

    const sliceA = first!.sliceDbPaths[WORKSPACE_A]!;
    const savedSidecar = readFileSync(sidecarPath(sliceA), "utf8");
    unlinkSync(sidecarPath(sliceA));
    expect(readValidWorkspaceSliceSnapshotDigest({
      workspaceId: WORKSPACE_A,
      dbPath: sliceA
    })).toBeNull();
    writeFileSync(sidecarPath(sliceA), savedSidecar);

    writeFileSync(sidecarPath(sliceA), `${JSON.stringify({
      ...readSidecar(first!.sliceDbPaths[WORKSPACE_A]!),
      recipe_version: "v0"
    })}\n`);
    const rebuilt = await explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: dataDir });
    expect(rebuilt).not.toBeNull();
    expect(readSidecar(rebuilt!.sliceDbPaths[WORKSPACE_A]!).recipe_version)
      .toBe(WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION);
    expect(rebuilt!.sliceSnapshotDigests[WORKSPACE_A])
      .toBe(first!.sliceSnapshotDigests[WORKSPACE_A]);
  });

  it("leaves snapshot identity unavailable on skip and single-workspace paths", async () => {
    const skipDir = join(root, "skip-data");
    installWorkspaceSlice({ dataDir: skipDir, sliceDbPath: packedPath });
    expect(await explodeRecallEvalWorkingCopyIfNeeded({
      dataDirRoot: skipDir,
      env: { ALAYA_RECALL_EVAL_SKIP_WORKSPACE_SLICE: "1" }
    })).toBeNull();

    const oneDir = join(root, "one-workspace");
    const exploded = await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir: join(root, "slices-one"),
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    installWorkspaceSlice({
      dataDir: oneDir,
      sliceDbPath: exploded.sliceDbPaths[WORKSPACE_A]!
    });
    expect(await explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: oneDir })).toBeNull();
  });

  it("keeps the sealed slice digest after live install mutates the working copy", async () => {
    const destDir = join(root, "slices-live");
    const dataDir = join(root, "live-data");
    const exploded = await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    const sealed = exploded.sliceSnapshotDigests[WORKSPACE_A]!;
    const slicePath = exploded.sliceDbPaths[WORKSPACE_A]!;
    const sliceFileHash = readSidecar(slicePath).sqlite_main_file_sha256;
    installWorkspaceSlice({ dataDir, sliceDbPath: slicePath });
    const live = initDatabase({ filename: workingAlayaDbPath(dataDir) });
    live.connection.exec("ANALYZE");
    live.close();
    expect(exploded.sliceSnapshotDigests[WORKSPACE_A]).toBe(sealed);
    expect(readValidWorkspaceSliceSnapshotDigest({
      workspaceId: WORKSPACE_A,
      dbPath: slicePath
    })).toBe(sealed);
    expect(sha256File(workingAlayaDbPath(dataDir))).not.toBe(sliceFileHash);
  });

  it("rejects a mutated slice file and rebuilds instead of trusting the sidecar", async () => {
    const dataDir = join(root, "tamper-data");
    installWorkspaceSlice({ dataDir, sliceDbPath: packedPath });
    const first = await explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: dataDir });
    expect(first).not.toBeNull();
    const sliceA = first!.sliceDbPaths[WORKSPACE_A]!;
    const sealed = first!.sliceSnapshotDigests[WORKSPACE_A]!;
    const saved = readSidecar(sliceA);

    const dirty = new BetterSqlite3(sliceA);
    dirty.prepare("UPDATE schema_version SET applied_at = ? WHERE version = 1")
      .run("1999-01-01T00:00:00.000Z");
    dirty.close();
    expect(sha256File(sliceA)).not.toBe(saved.sqlite_main_file_sha256);
    expect(readValidWorkspaceSliceSnapshotDigest({
      workspaceId: WORKSPACE_A,
      dbPath: sliceA
    })).toBeNull();
    const rebuiltBytes = await explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: dataDir });
    expect(rebuiltBytes!.sliceSnapshotDigests[WORKSPACE_A]).toBe(sealed);

    writeFileSync(sidecarPath(rebuiltBytes!.sliceDbPaths[WORKSPACE_A]!), `${JSON.stringify({
      ...readSidecar(rebuiltBytes!.sliceDbPaths[WORKSPACE_A]!),
      snapshot_digest: `sha256:${"c".repeat(64)}`
    })}\n`);
    expect(readValidWorkspaceSliceSnapshotDigest({
      workspaceId: WORKSPACE_A,
      dbPath: rebuiltBytes!.sliceDbPaths[WORKSPACE_A]!
    })).toBeNull();

    writeFileSync(
      sidecarPath(rebuiltBytes!.sliceDbPaths[WORKSPACE_A]!),
      readFileSync(sidecarPath(rebuiltBytes!.sliceDbPaths[WORKSPACE_B]!), "utf8")
    );
    expect(readValidWorkspaceSliceSnapshotDigest({
      workspaceId: WORKSPACE_A,
      dbPath: rebuiltBytes!.sliceDbPaths[WORKSPACE_A]!
    })).toBeNull();
    const rebuiltSidecar = await explodeRecallEvalWorkingCopyIfNeeded({ dataDirRoot: dataDir });
    expect(rebuiltSidecar!.sliceSnapshotDigests[WORKSPACE_A]).toBe(sealed);
  });

  it("refuses to install bytes that drift after sealed-slice verification", async () => {
    const slices = await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir: join(root, "install-drift-slices"),
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    writeFileSync(slices.sliceDbPaths[WORKSPACE_A]!, "drifted after verification");

    expect(() => installRecallEvalWorkspaceSlice({
      dataDirRoot: join(root, "install-drift-data"),
      workspaceId: WORKSPACE_A,
      slices
    })).toThrow(/changed after verification/u);
    expect(existsSync(workingAlayaDbPath(join(root, "install-drift-data")))).toBe(false);
  });

  it("does not mutate the sealed source file when installing or reloading", async () => {
    const destDir = join(root, "slices-ro");
    const dataDir = join(root, "ro-data");
    const exploded = await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir,
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    const sliceA = exploded.sliceDbPaths[WORKSPACE_A]!;
    const sliceB = exploded.sliceDbPaths[WORKSPACE_B]!;
    const hashA = sha256File(sliceA);
    const hashB = sha256File(sliceB);
    installWorkspaceSlice({ dataDir, sliceDbPath: sliceA });
    installWorkspaceSlice({ dataDir, sliceDbPath: sliceB });
    const live = initDatabase({ filename: workingAlayaDbPath(dataDir) });
    try {
      loadSliceIntoOpenDatabase(live, sliceA);
      const matched = live.connection.prepare(
        "SELECT object_id FROM memory_content_fts_porter WHERE memory_content_fts_porter MATCH ?"
      ).all(TOKEN_A) as ReadonlyArray<{ readonly object_id: string }>;
      expect(matched.map((row) => row.object_id)).toEqual([MEMORY_A]);
    } finally {
      live.close();
    }
    expect(sha256File(sliceA)).toBe(hashA);
    expect(sha256File(sliceB)).toBe(hashB);
    expect(readValidWorkspaceSliceSnapshotDigest({
      workspaceId: WORKSPACE_A,
      dbPath: sliceA
    })).toBe(exploded.sliceSnapshotDigests[WORKSPACE_A]);
  });

  it("treats leftover SHM as outside the sealed main-file preimage", async () => {
    const exploded = await explodePackedWorkingCopy({
      packedDbPath: packedPath,
      destDir: join(root, "slices-shm"),
      workspaceIds: [WORKSPACE_A, WORKSPACE_B]
    });
    const sliceA = exploded.sliceDbPaths[WORKSPACE_A]!;
    assertQuiescentMainDb(sliceA);
    const sealedHex = sha256File(sliceA);
    const shmPath = `${sliceA}-shm`;
    writeFileSync(shmPath, Buffer.alloc(32 * 1024, 1));
    expect(sha256File(sliceA)).toBe(sealedHex);
    expect(readValidWorkspaceSliceSnapshotDigest({
      workspaceId: WORKSPACE_A,
      dbPath: sliceA
    })).toBe(exploded.sliceSnapshotDigests[WORKSPACE_A]);
    unlinkSync(shmPath);
    expect(sha256File(sliceA)).toBe(sealedHex);
  });
});

function sidecarPath(dbPath: string): string {
  return join(dirname(dbPath), WORKSPACE_SLICE_SNAPSHOT_SIDECAR_FILENAME);
}

function readSidecar(dbPath: string): {
  readonly recipe_version: string;
  readonly sqlite_main_file_sha256: string;
  readonly snapshot_digest: string;
} {
  expect(existsSync(sidecarPath(dbPath))).toBe(true);
  return JSON.parse(readFileSync(sidecarPath(dbPath), "utf8")) as {
    readonly recipe_version: string;
    readonly sqlite_main_file_sha256: string;
    readonly snapshot_digest: string;
  };
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}
