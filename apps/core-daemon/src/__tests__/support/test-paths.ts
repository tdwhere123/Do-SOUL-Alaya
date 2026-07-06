import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  return toPosixPath(filePath).endsWith(segments.join("/"));
}

export function quoteSingle(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

export function fixturePath(...segments: string[]): string {
  return path.join(os.tmpdir(), ...segments);
}

export function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

export function fileModuleUrl(...segmentsFromCoreDaemon: string[]): string {
  const modulePath = path.resolve(
    path.parse(process.cwd()).root,
    "workspace",
    "apps",
    "core-daemon",
    ...segmentsFromCoreDaemon
  );
  return pathToFileURL(modulePath).href;
}
