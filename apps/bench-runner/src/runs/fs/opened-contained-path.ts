import { realpathSync } from "node:fs";
import { realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

export async function resolveOpenedDescriptorPath(
  handle: FileHandle,
  fallbackPath?: string
): Promise<string> {
  if (process.platform === "linux") {
    try {
      return await realpath(path.join("/proc/self/fd", String(handle.fd)));
    } catch {
      if (fallbackPath !== undefined) {
        return await realpath(fallbackPath);
      }
      throw new Error("cannot validate opened file descriptor on linux");
    }
  }
  if (fallbackPath !== undefined) {
    return await realpath(fallbackPath);
  }
  throw new Error("cannot validate opened file descriptor without a fallback path");
}

export function canonicalPath(input: string): string {
  const absolute = path.resolve(input);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(canonicalPath(parent), path.basename(absolute));
  }
}

export function isContainedPath(root: string, candidate: string): boolean {
  if (root.includes("\0") || candidate.includes("\0")) return false;
  const realRoot = canonicalPath(root);
  const realCandidate = canonicalPath(candidate);
  const paths = path.posix.isAbsolute(realRoot)
    ? path.posix
    : path.win32.isAbsolute(realRoot) ? path.win32 : path;
  if (paths === path.posix && realCandidate.includes("\\")) return false;
  const relative = paths.relative(realRoot, realCandidate);
  return relative.length > 0 &&
    !paths.isAbsolute(relative) &&
    !relative.split(paths.sep).includes("..");
}
