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

export function isContainedPath(root: string, candidate: string): boolean {
  if (root.includes("\0") || candidate.includes("\0")) return false;
  const paths = path.posix.isAbsolute(root)
    ? path.posix
    : path.win32.isAbsolute(root) ? path.win32 : path;
  if (paths === path.posix && candidate.includes("\\")) return false;
  const relative = paths.relative(paths.resolve(root), paths.resolve(candidate));
  return relative.length > 0 &&
    !paths.isAbsolute(relative) &&
    !relative.split(paths.sep).includes("..");
}
