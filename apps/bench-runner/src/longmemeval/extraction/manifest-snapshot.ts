import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  extractionCacheManifestPath,
  parseExtractionCacheManifestContents,
  type ExtractionCacheManifestIdentity
} from "../extraction-cache-manifest.js";

export interface ExtractionCacheManifestSnapshot {
  readonly identity: ExtractionCacheManifestIdentity | undefined;
  readonly raw: string | undefined;
}

export function captureExtractionCacheManifestSnapshot(
  cacheRoot: string
): ExtractionCacheManifestSnapshot {
  const path = extractionCacheManifestPath(cacheRoot);
  if (!existsSync(path)) return { identity: undefined, raw: undefined };
  const raw = readFileSync(path, "utf8");
  const manifest = parseExtractionCacheManifestContents(raw, path);
  return {
    identity: {
      manifest,
      manifestSha256: createHash("sha256").update(raw, "utf8").digest("hex")
    },
    raw
  };
}

export function restoreExtractionCacheManifestSnapshot(
  cacheRoot: string,
  snapshot: ExtractionCacheManifestSnapshot,
  expectedPinnedManifestSha256: string
): void {
  const current = captureExtractionCacheManifestSnapshot(cacheRoot).identity;
  if (current?.manifestSha256 !== expectedPinnedManifestSha256) {
    throw new Error("extraction cache manifest changed before authority rollback");
  }
  const path = extractionCacheManifestPath(cacheRoot);
  if (snapshot.raw === undefined) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, snapshot.raw, "utf8");
  renameSync(temporary, path);
}
