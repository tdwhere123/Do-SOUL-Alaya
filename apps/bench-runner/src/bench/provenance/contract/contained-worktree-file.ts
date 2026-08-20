import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  isContainedPath,
  resolveOpenedDescriptorPath
} from "../../fs/opened-contained-path.js";
import {
  assertSafeUntrackedRelativePath,
  fileModeFromStatMode
} from "./untracked-worktree-frame.js";

export async function readContainedWorktreeFile(
  checkoutRoot: string,
  rawPath: string
): Promise<{ readonly bytes: Buffer; readonly mode: number }> {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("untracked provenance no-follow validation is unavailable");
  }
  const relativePath = assertSafeUntrackedRelativePath(rawPath, checkoutRoot);
  await assertNoSymlinkPathComponents(checkoutRoot, relativePath);
  const handle = await openWorktreeFile(checkoutRoot, relativePath);
  try {
    await assertOpenedPathInsideWorktree(handle, checkoutRoot);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("untracked provenance path must be a regular non-symlink file");
    }
    return {
      bytes: await handle.readFile(),
      mode: fileModeFromStatMode(stat.mode)
    };
  } finally {
    await handle.close();
  }
}

async function openWorktreeFile(
  checkoutRoot: string,
  relativePath: string
): Promise<FileHandle> {
  try {
    return await open(
      resolve(checkoutRoot, relativePath),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
  } catch (cause) {
    throw new Error("untracked provenance path must be a regular non-symlink file", {
      cause
    });
  }
}

async function assertOpenedPathInsideWorktree(
  handle: FileHandle,
  checkoutRoot: string
): Promise<void> {
  const realRoot = await realpath(checkoutRoot);
  let openedPath: string;
  try {
    openedPath = await resolveOpenedDescriptorPath(handle);
  } catch {
    // Descriptor realpath is unavailable; component lstat already ran.
    // Concurrent parent replacement after that walk is out of threat model.
    return;
  }
  if (!isContainedPath(realRoot, openedPath)) {
    throw new Error("untracked provenance path escapes the worktree");
  }
}

async function assertNoSymlinkPathComponents(
  checkoutRoot: string,
  relativePath: string
): Promise<void> {
  let current = resolve(checkoutRoot);
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    const stat = await lstatPath(current);
    if (stat.isSymbolicLink()) {
      throw new Error("untracked provenance path must be a regular non-symlink file");
    }
  }
}

async function lstatPath(path: string): ReturnType<typeof lstat> {
  try {
    return await lstat(path);
  } catch (cause) {
    throw new Error("untracked provenance path must be a regular non-symlink file", {
      cause
    });
  }
}
