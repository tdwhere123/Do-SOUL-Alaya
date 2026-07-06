import path from "node:path";

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function pathsEqual(left: string, right: string): boolean {
  return path.normalize(left) === path.normalize(right);
}

export function pathEndsWithPosixSegments(filePath: string, ...segments: string[]): boolean {
  return toPosixPath(filePath).endsWith(segments.join("/"));
}

export function pathIsStrictlyOutside(baseDir: string, targetPath: string): boolean {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  if (base === target) {
    return false;
  }
  const relative = path.relative(base, target);
  return relative.startsWith("..") || path.isAbsolute(relative);
}
