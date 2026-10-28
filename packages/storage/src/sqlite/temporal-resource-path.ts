import fs from "node:fs";
import path from "node:path";

/** Physical identity for existing resources, dangling file links, and new children. */
export function resolveTemporalResourcePath(filename: string): string {
  const resolved = path.resolve(filename);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    try {
      return resolveTemporalResourcePath(path.resolve(path.dirname(resolved), fs.readlinkSync(resolved)));
    } catch (linkError) {
      if (!hasCode(linkError, "ENOENT") && !hasCode(linkError, "EINVAL")) throw linkError;
    }
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(resolveTemporalResourcePath(parent), path.basename(resolved));
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
