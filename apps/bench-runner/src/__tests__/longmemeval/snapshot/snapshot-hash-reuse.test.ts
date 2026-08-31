import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase, closeCachedDatabase } from "@do-soul/alaya-storage";
import {
  BENCH_DAEMON_DB_FILENAME,
  checkpointAndCopyBenchDb,
  restoreSnapshotToDataDir
} from "../../../runs/snapshot/materialize.js";
import { sha256File } from "../../../runs/snapshot/integrity.js";
import { boundFileFullContentReadCount } from "../../../runs/snapshot/bound-file.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "snapshot-hash-reuse-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("sealed snapshot digest reuse", () => {
  it("fails closed when sealed bytes change after the cached digest", async () => {
    const sourcePath = join(tmpDir, "sealed-digest.db");
    writeFileSync(sourcePath, "sealed source");
    const expectedSha256 = await sha256File(sourcePath);
    writeFileSync(sourcePath, "swapped after digest");
    const restoreRoot = join(tmpDir, "restore-digest-drift");

    expect(() => restoreSnapshotToDataDir({
      snapshotDbPath: sourcePath,
      dataDirRoot: restoreRoot,
      expectedSha256
    })).toThrow(/changed after cached digest/u);
    expect(existsSync(join(restoreRoot, BENCH_DAEMON_DB_FILENAME))).toBe(false);
  });

  it("does not full-hash a sealed snapshot twice between restores", async () => {
    const liveDbPath = join(tmpDir, "live", BENCH_DAEMON_DB_FILENAME);
    const db = initDatabase({ filename: liveDbPath });
    db.connection
      .prepare("CREATE TABLE IF NOT EXISTS snapshot_probe (k TEXT PRIMARY KEY)")
      .run();
    closeCachedDatabase(liveDbPath);
    const snapshotDbPath = join(tmpDir, "once.db");
    checkpointAndCopyBenchDb(liveDbPath, snapshotDbPath);
    const expectedSha256 = await sha256File(snapshotDbPath);
    restoreSnapshotToDataDir({
      snapshotDbPath,
      dataDirRoot: join(tmpDir, "restore-a"),
      expectedSha256
    });
    const afterFirst = boundFileFullContentReadCount();
    restoreSnapshotToDataDir({
      snapshotDbPath,
      dataDirRoot: join(tmpDir, "restore-b"),
      expectedSha256
    });
    expect(boundFileFullContentReadCount()).toBe(afterFirst);
    expect(await sha256File(snapshotDbPath)).toBe(expectedSha256);
    expect(boundFileFullContentReadCount()).toBe(afterFirst);
  });
});
