import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ControlledReplayArchive } from "./types.js";

const CONTROLLED_REPLAY_HISTORY_SPLIT = "controlled-replay";

export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function resolveCommitSha7(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "0000000";
  }
}

export async function assertArchiveSlotFree(historyRoot: string, slug: string): Promise<void> {
  const entryDir = join(historyRoot, CONTROLLED_REPLAY_HISTORY_SPLIT, slug);
  try {
    await access(entryDir);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  throw archiveCollisionError(slug, entryDir);
}

export async function writeControlledReplayArchive(
  historyRoot: string,
  slug: string,
  archive: ControlledReplayArchive
): Promise<string> {
  const benchRoot = join(historyRoot, CONTROLLED_REPLAY_HISTORY_SPLIT);
  const entryDir = join(benchRoot, slug);
  await mkdir(benchRoot, { recursive: true });
  try {
    await mkdir(entryDir);
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) {
      throw archiveCollisionError(slug, entryDir);
    }
    throw error;
  }
  const archivePath = join(entryDir, "controlled-replay.json");
  try {
    await writeFile(archivePath, JSON.stringify(archive, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx"
    });
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) {
      throw archiveCollisionError(slug, archivePath);
    }
    throw error;
  }
  return archivePath;
}

function archiveCollisionError(slug: string, path: string): Error {
  return new Error(
    `controlled-replay archive slug '${slug}' already exists at ${path}; refusing to overwrite`
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
