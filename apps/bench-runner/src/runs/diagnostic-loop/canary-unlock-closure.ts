import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { canonicalPath } from "../fs/opened-contained-path.js";
import { parseCheckpoint } from "./checkpoint.js";
import type { DiagnosticLoopCheckpoint } from "./types.js";

export async function readContainedFile(
  workRoot: string,
  candidate: string
): Promise<{ readonly path: string; readonly bytes: Buffer }> {
  const path = resolveContainedPath(workRoot, candidate);
  return { path, bytes: await readFile(path) };
}

export function resolveContainedPath(workRoot: string, candidate: string): string {
  if (candidate.trim().length === 0) {
    throw new Error("canary unlock artifact path is empty");
  }
  const root = canonicalPath(workRoot);
  const resolved = canonicalPath(resolve(root, candidate));
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolved === dirname(root)) {
    throw new Error(`canary unlock artifact escapes the unlock work-root: ${candidate}`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`canary unlock artifact is missing: ${candidate}`);
  }
  return resolved;
}

export function parseContainedCheckpoint(
  bytes: Buffer,
  path: string
): DiagnosticLoopCheckpoint {
  return parseCheckpoint(JSON.parse(bytes.toString("utf8")), path);
}
