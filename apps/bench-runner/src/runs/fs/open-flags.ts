import { constants } from "node:fs";
import { isAbsolute, parse, sep } from "node:path";

export const NO_FOLLOW_OPEN_FLAG = typeof constants.O_NOFOLLOW === "number"
  ? constants.O_NOFOLLOW
  : 0;
export const DIRECTORY_OPEN_FLAG = typeof constants.O_DIRECTORY === "number"
  ? constants.O_DIRECTORY
  : 0;
export const NONBLOCK_OPEN_FLAG = typeof constants.O_NONBLOCK === "number"
  ? constants.O_NONBLOCK
  : 0;
// FlushFileBuffers requires GENERIC_WRITE; O_RDONLY is EPERM on Windows.
export const FSYNC_FILE_OPEN_FLAG = (
  process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY
) | NO_FOLLOW_OPEN_FLAG;

export function splitAbsolutePath(absolute: string): {
  readonly root: string;
  readonly segments: readonly string[];
} {
  const parsed = parse(absolute);
  if (!isAbsolute(absolute) || parsed.root.length === 0) {
    throw new Error("path must be absolute");
  }
  return {
    root: parsed.root,
    segments: absolute.slice(parsed.root.length).split(sep).filter(Boolean)
  };
}
