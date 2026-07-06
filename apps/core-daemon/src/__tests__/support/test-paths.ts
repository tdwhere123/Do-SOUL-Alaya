import path from "node:path";

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function pathsEqual(left: string, right: string): boolean {
  return path.normalize(left) === path.normalize(right);
}

export function pathEndsWith(filePath: string, suffix: string): boolean {
  return path.normalize(filePath).endsWith(path.normalize(suffix));
}

export function pathEndsWithPosixSegments(filePath: string, ...segments: string[]): boolean {
  return pathEndsWith(filePath, path.join(...segments));
}

export function quoteSingle(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

export function supportsPosixFileModeAssertions(): boolean {
  return process.platform !== "win32";
}
