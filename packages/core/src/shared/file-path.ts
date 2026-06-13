import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve a stored (potentially relative) file path safely within a base directory.
 * Returns the absolute path if valid, or null if the resolved path escapes the base
 * directory (path traversal).
 */
export function resolveStoredFilePath(filesDirectory: string, storagePath: string): string | null {
  const baseDirectory = resolve(filesDirectory);
  const absolutePath = resolve(baseDirectory, storagePath);
  const relativePath = relative(baseDirectory, absolutePath);
  const [firstSegment] = relativePath.split(sep);

  if (relativePath === "" || relativePath === "." || isAbsolute(relativePath) || firstSegment === "..") {
    return null;
  }

  return absolutePath;
}
