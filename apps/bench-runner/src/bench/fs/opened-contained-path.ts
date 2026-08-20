import { realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

export async function resolveOpenedDescriptorPath(handle: FileHandle): Promise<string> {
  let lastError: unknown;
  for (const descriptorRoot of ["/proc/self/fd", "/dev/fd"] as const) {
    try {
      return await realpath(path.join(descriptorRoot, String(handle.fd)));
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`cannot validate opened file descriptor: ${message}`);
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
