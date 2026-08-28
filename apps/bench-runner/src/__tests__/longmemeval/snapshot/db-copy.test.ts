import { createHash } from "node:crypto";
import { copyFileSync, constants, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  atomicCopy,
  cloneCachedSealedSnapshot,
  cloneOrCopyFile,
  type CopyFileFn
} from "../../../bench/snapshot/freeze/db-copy.js";
import { hashRegularFileNoFollow, peekCachedFileSha256 } from "../../../bench/snapshot/bound-file.js";

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

  it("atomicCopy restores a private working copy without following a symlink source", async () => {
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
