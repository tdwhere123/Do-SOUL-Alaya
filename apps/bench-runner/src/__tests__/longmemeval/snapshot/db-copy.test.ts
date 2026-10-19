import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { initDatabase } from "@do-soul/alaya-storage";
import {
  atomicCopy,
  checkpointAndCopyBenchDb,
  cloneCachedSealedSnapshot,
  cloneOrCopyFile,
  type CopyFileFn
} from "../../../runs/snapshot/freeze/db-copy.js";
import { hashRegularFileNoFollow, peekCachedFileSha256 } from "../../../runs/snapshot/bound-file.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; source: string; bytes: Buffer }> {
  const root = await mkdtemp(join(tmpdir(), "db-copy-"));
  roots.push(root);
  const source = join(root, "frozen.db");
  const bytes = Buffer.from("frozen snapshot bytes", "utf8");
  await writeFile(source, bytes);
  return { root, source, bytes };
}

describe("clone-or-copy snapshot restore", () => {
  it("uses a forced reflink and keeps the frozen source unwritten", async () => {
    const input = await fixture();
    const target = join(input.root, "working.db");
    const flags: number[] = [];
    const copyFile: CopyFileFn = (source, dest, mode) => {
      flags.push(mode ?? -1);
      copyFileSync(source, dest);
    };

    cloneOrCopyFile(input.source, target, copyFile);

    expect(flags).toEqual([constants.COPYFILE_FICLONE_FORCE]);
    expect(await readFile(target)).toEqual(input.bytes);
    await writeFile(target, "working mutation");
    expect(await readFile(input.source)).toEqual(input.bytes);
  });

  it("falls back to an unflagged copy when clone is unsupported", async () => {
    const input = await fixture();
    const target = join(input.root, "working.db");
    const flags: number[] = [];
    const copyFile: CopyFileFn = (source, dest, mode) => {
      flags.push(mode ?? -1);
      if (mode === constants.COPYFILE_FICLONE_FORCE) {
        const error = new Error("clone unsupported") as NodeJS.ErrnoException;
        error.code = "ENOTSUP";
        throw error;
      }
      copyFileSync(source, dest);
    };

    cloneOrCopyFile(input.source, target, copyFile);

    expect(flags).toEqual([constants.COPYFILE_FICLONE_FORCE, -1]);
    expect(await readFile(target)).toEqual(input.bytes);
    await writeFile(target, "working mutation");
    expect(await readFile(input.source)).toEqual(input.bytes);
  });

  it("does not fall back when clone fails for a reason other than missing reflink", async () => {
    const input = await fixture();
    const target = join(input.root, "working.db");
    const copyFile: CopyFileFn = () => {
      const error = new Error("source vanished") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };

    expect(() => cloneOrCopyFile(input.source, target, copyFile)).toThrow(/source vanished/u);
    await expect(readFile(target)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("atomicCopy restores a private working copy without following a symlink source", async () => {
    const input = await fixture();
    const working = join(input.root, "restore", "alaya.db");
    atomicCopy(input.source, working);
    expect(await readFile(working)).toEqual(input.bytes);
    await writeFile(working, "working mutation");
    expect(sha256(await readFile(input.source))).toBe(sha256(input.bytes));

    const linked = join(input.root, "linked.db");
    await symlink(input.source, linked);
    expect(() => atomicCopy(linked, join(input.root, "from-link.db"))).toThrow();
  });

  it.skipIf(process.platform === "win32")("refuses a destination directory alias before deleting source sidecars", async () => {
    const input = await fixture();
    const alias = join(input.root, "alias");
    await symlink(input.root, alias, "dir");
    await writeFile(`${input.source}-wal`, "source WAL");
    await writeFile(`${input.source}-shm`, "source SHM");

    expect(() => atomicCopy(input.source, join(alias, "frozen.db"))).toThrow(/must differ/u);
    expect(await readFile(input.source)).toEqual(input.bytes);
    expect(await readFile(`${input.source}-wal`, "utf8")).toBe("source WAL");
    expect(await readFile(`${input.source}-shm`, "utf8")).toBe("source SHM");
  });

  it("rehashes a sealed digest when the process cache is cold", async () => {
    const input = await fixture();
    const digest = hashRegularFileNoFollow(input.source);
    const cold = join(input.root, "cold.db");
    await writeFile(cold, input.bytes);
    const target = join(input.root, "restore-cold", "alaya.db");
    cloneCachedSealedSnapshot({
      sourcePath: cold,
      targetPath: target,
      expectedSha256: digest
    });
    expect(await readFile(target)).toEqual(input.bytes);
  });

  it("clones from a cached sealed digest without rewriting the source", async () => {
    const input = await fixture();
    const digest = hashRegularFileNoFollow(input.source);
    const target = join(input.root, "restore", "alaya.db");
    cloneCachedSealedSnapshot({
      sourcePath: input.source,
      targetPath: target,
      expectedSha256: digest
    });
    expect(peekCachedFileSha256(target)).toBe(digest);
    expect(await readFile(target)).toEqual(input.bytes);
    await writeFile(input.source, "swapped after digest");
    expect(() => cloneCachedSealedSnapshot({
      sourcePath: input.source,
      targetPath: join(input.root, "restore-drift", "alaya.db"),
      expectedSha256: digest
    })).toThrow(/SHA-256 mismatch|changed after cached digest/u);
  });

  it("keeps the cached inode bound when its source path is replaced during clone", async () => {
    const input = await fixture();
    const digest = hashRegularFileNoFollow(input.source);
    const target = join(input.root, "restore-bound", "alaya.db");
    const originalPath = `${input.source}.original`;
    let planted = false;
    let failedClosed = false;
    try {
      cloneCachedSealedSnapshot({
        sourcePath: input.source,
        targetPath: target,
        expectedSha256: digest,
        copyFile: (openedSource, dest) => {
          planted = true;
          renameSync(input.source, originalPath);
          writeFileSync(input.source, "untrusted replacement");
          try {
            copyFileSync(openedSource, dest);
          } finally {
            rmSync(input.source, { force: true });
            renameSync(originalPath, input.source);
          }
        }
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      failedClosed = true;
    }

    expect(planted).toBe(true);
    if (failedClosed) await expect(readFile(target)).rejects.toThrow();
    else expect(await readFile(target)).toEqual(input.bytes);
    expect(await readFile(input.source)).toEqual(input.bytes);
  });
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PLANT_COMMITTED_DESTINATION_WAL = `
import { createRequire } from "node:module";
import { statSync, writeFileSync } from "node:fs";
const require = createRequire(process.env.REQUIRE_FROM);
const Database = require("better-sqlite3");
const db = new Database(process.env.DEST);
db.pragma("journal_mode = WAL");
db.pragma("wal_autocheckpoint = 0");
db.pragma("synchronous = FULL");
db.prepare("INSERT OR REPLACE INTO snapshot_probe (k) VALUES (?)").run(process.env.POISON);
const committed = db.prepare("SELECT k FROM snapshot_probe WHERE k = ?").get(process.env.POISON);
const walBytes = statSync(process.env.DEST + "-wal").size;
if (committed?.k !== process.env.POISON || walBytes <= 0) {
  throw new Error("destination WAL plant did not commit into an uncheckpointed WAL");
}
writeFileSync(process.env.RECEIPT, JSON.stringify({ row: committed.k, walBytes }));
process.kill(process.pid, "SIGKILL");
`;

describe("destination WAL reset before sealing", () => {
  it("does not replay a committed destination WAL after replacing the main file", async () => {
    const paths = await sqliteCopyFixture();
    plantCommittedDestinationWal(paths.dest, "poison");
    expect(statSync(`${paths.dest}-wal`).size).toBeGreaterThan(0);
    expect(hashRegularFileNoFollow(paths.dest)).toBe(paths.sourceSha);

    atomicCopy(paths.source, paths.dest);

    const sealed = hashRegularFileNoFollow(paths.dest);
    expect(sealed).toBe(paths.sourceSha);
    expect(existsSync(`${paths.dest}-wal`)).toBe(false);
    expect(probeValues(paths.dest)).toEqual(["source"]);
    expect(hashRegularFileNoFollow(paths.dest)).toBe(sealed);
    expect(readFileSync(paths.source)).toEqual(readFileSync(paths.dest));
  });

  it("retries after a failed copy without leaving destination WAL to replay", async () => {
    const paths = await sqliteCopyFixture();
    plantCommittedDestinationWal(paths.dest, "poison");
    expect(() => atomicCopy(paths.source, paths.dest, () => {
      throw new Error("copy failed");
    })).toThrow(/copy failed/u);
    expect(existsSync(`${paths.dest}-wal`)).toBe(false);
    expect(hashRegularFileNoFollow(paths.dest)).toBe(paths.sourceSha);
    expect(probeValues(paths.dest)).toEqual(["source"]);

    atomicCopy(paths.source, paths.dest);
    expect(probeValues(paths.dest)).toEqual(["source"]);
    expect(hashRegularFileNoFollow(paths.dest)).toBe(paths.sourceSha);
  });

  it("releases a cached destination connection before replacing the main file", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-copy-live-dest-"));
    roots.push(root);
    const source = join(root, "source.db");
    const dest = join(root, "dest.db");
    writeCheckpointedBenchDb(source, "source");
    copyFileSync(source, dest);
    const live = initDatabase({ filename: dest });
    live.connection.pragma("wal_autocheckpoint = 0");
    live.connection.prepare("INSERT OR REPLACE INTO snapshot_probe (k) VALUES (?)").run("poison");
    expect(statSync(`${dest}-wal`).size).toBeGreaterThan(0);

    atomicCopy(source, dest);

    expect(live.isClosed()).toBe(true);
    expect(probeValues(dest)).toEqual(["source"]);
    expect(hashRegularFileNoFollow(dest)).toBe(hashRegularFileNoFollow(source));
  });

  it("keeps source WAL bytes and seals a freeze copy without destination WAL", async () => {
    const paths = await sqliteCopyFixture();
    writeFileSync(`${paths.source}-wal`, "source-wal");
    plantCommittedDestinationWal(paths.dest, "poison");
    cloneCachedSealedSnapshot({
      sourcePath: paths.source,
      targetPath: paths.dest,
      expectedSha256: paths.sourceSha
    });
    expect(readFileSync(`${paths.source}-wal`, "utf8")).toBe("source-wal");
    expect(existsSync(`${paths.dest}-wal`)).toBe(false);
    expect(probeValues(paths.dest)).toEqual(["source"]);

    const live = join(paths.root, "bench-live.db");
    const freeze = join(paths.root, "bench-freeze.db");
    writeCheckpointedBenchDb(live, "source");
    copyFileSync(live, freeze);
    plantCommittedDestinationWal(freeze, "poison");
    checkpointAndCopyBenchDb(live, freeze);
    expect(existsSync(`${freeze}-wal`)).toBe(false);
    expect(probeValues(freeze)).toEqual(["source"]);
  });
});

async function sqliteCopyFixture(): Promise<{
  root: string;
  source: string;
  dest: string;
  sourceSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "db-copy-wal-"));
  roots.push(root);
  const source = join(root, "source.db");
  const dest = join(root, "dest.db");
  writeCheckpointedSqlite(source, "source");
  copyFileSync(source, dest);
  return { root, source, dest, sourceSha: hashRegularFileNoFollow(source) };
}

function writeCheckpointedBenchDb(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = initDatabase({ filename: path });
  db.connection.exec("CREATE TABLE IF NOT EXISTS snapshot_probe (k TEXT PRIMARY KEY)");
  db.connection.prepare("INSERT OR REPLACE INTO snapshot_probe (k) VALUES (?)").run(value);
  db.connection.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

function writeCheckpointedSqlite(path: string, value: string): void {
  const db = new BetterSqlite3(path);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE snapshot_probe (k TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO snapshot_probe (k) VALUES (?)").run(value);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

function plantCommittedDestinationWal(destPath: string, poison: string): void {
  const receiptPath = `${destPath}.plant-receipt`;
  rmSync(receiptPath, { force: true });
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", PLANT_COMMITTED_DESTINATION_WAL], {
    env: {
      ...process.env,
      DEST: destPath,
      POISON: poison,
      RECEIPT: receiptPath,
      REQUIRE_FROM: import.meta.url
    },
    encoding: "utf8"
  });
  // Node emulates SIGKILL on Windows with TerminateProcess, so the crash surfaces
  // as exit status 1 without a signal. Only the committed-WAL receipt, which a
  // startup or SQLite fault cannot reach, makes that termination the simulated crash.
  const crashed = process.platform === "win32"
    ? child.status === 1 && child.signal === null
    : child.status === null && child.signal === "SIGKILL";
  if (!crashed) {
    throw new Error(`destination WAL plant was not killed after committing: status=${child.status} signal=${child.signal}: ${child.stderr}`);
  }
  assertCommittedWalReceipt(receiptPath, poison);
  rmSync(receiptPath, { force: true });
  if (!existsSync(`${destPath}-wal`) || statSync(`${destPath}-wal`).size <= 0) {
    throw new Error("destination WAL plant did not leave committed WAL bytes");
  }
}

function assertCommittedWalReceipt(receiptPath: string, poison: string): void {
  if (!existsSync(receiptPath)) {
    throw new Error("destination WAL plant did not report a committed WAL");
  }
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
    readonly row?: unknown;
    readonly walBytes?: unknown;
  };
  if (receipt.row !== poison || typeof receipt.walBytes !== "number" || receipt.walBytes <= 0) {
    throw new Error(`destination WAL plant reported an incomplete committed WAL: ${JSON.stringify(receipt)}`);
  }
}

function probeValues(path: string): string[] {
  const db = new BetterSqlite3(path, { fileMustExist: true });
  try {
    return (db.prepare("SELECT k FROM snapshot_probe ORDER BY k").all() as Array<{ k: string }>)
      .map((row) => row.k);
  } finally {
    db.close();
  }
}
