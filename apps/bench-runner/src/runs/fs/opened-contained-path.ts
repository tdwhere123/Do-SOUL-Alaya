import { lstatSync, realpathSync } from "node:fs";
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

/** Prefix aliases (/var vs /private/var) keep the same inode; symlink leaves do not. */
export function isPhysicalNamedPath(input: string): boolean {
  try {
    const named = lstatSync(input);
    if (named.isSymbolicLink()) return false;
    const physical = lstatSync(realpathSync(input));
    return named.dev === physical.dev && named.ino === physical.ino;
  } catch {
    return false;
  }
}

export function isContainedPath(root: string, candidate: string): boolean {
  if (root.includes("\0") || candidate.includes("\0")) return false;
  const paths = path.posix.isAbsolute(root)
    ? path.posix
    : path.win32.isAbsolute(root) ? path.win32 : path;
  if (paths === path.posix && candidate.includes("\\")) return false;
  const realRoot = bindContainedPath(root, paths);
  const realCandidate = bindContainedPath(candidate, paths);
  const relative = paths.relative(realRoot, realCandidate);
  return relative.length > 0 &&
    !paths.isAbsolute(relative) &&
    !relative.split(paths.sep).includes("..");
}

export function samePhysicalLocation(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return comparableWin32Path(left) === comparableWin32Path(right);
  }
  return canonicalPath(left) === canonicalPath(right);
}

function comparableWin32Path(input: string): string {
  const native = input.replaceAll("/", "\\");
  let resolved = native;
  try {
    resolved = realpathSync.native(native);
  } catch {
    resolved = canonicalPath(native);
  }
  return stripWin32NamespacePrefix(path.win32.toNamespacedPath(resolved))
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

function stripWin32NamespacePrefix(input: string): string {
  return input.replace(/^\\\\\?\\UNC\\/iu, "\\\\").replace(/^\\\\\?\\/u, "");
}

function bindContainedPath(
  input: string,
  paths: typeof path.posix | typeof path.win32 | typeof path
): string {
  if (paths === path.win32 && process.platform !== "win32") {
    return paths.normalize(input);
  }
  return canonicalPath(input);
}
