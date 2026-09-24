import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheFilePath } from "../../compile-seed/cache/cache-shard.js";
import { readBoundedCanonicalUtf8Artifact } from "../cache-audit/bounded-artifact-reader.js";
import { providerRawAttemptInputPaths } from "../fill/provider-raw-attempt.js";
import { SourceRequestLineSchema } from "../request-artifact.js";
import { extractionCacheManifestPath } from "./extraction-cache-manifest.js";

const SourceKey = SourceRequestLineSchema.unwrap().shape.key;

function entries(path: string) {
  try { return readdirSync(path, { withFileTypes: true }); }
  catch (cause) {
    if (cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ENOTDIR")) return [];
    throw cause;
  }
}

/** A retained preflight supplies path references even when another field cannot be admitted. */
export function retainedSourceRequestInputKeys(path: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(readBoundedCanonicalUtf8Artifact({ path,
      maxBytes: 32 * 1024 * 1024, label: "source request path inventory" }));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const keys = new Set<string>();
    for (const field of ["selected_keys", "ready_requests", "planned_requests"] as const) {
      const rows = record[field];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const candidate = field === "selected_keys" ? row : row !== null && typeof row === "object" ? row.key : undefined;
        if (SourceKey.safeParse(candidate).success) keys.add(candidate as string);
      }
    }
    return [...keys];
  } catch { return []; }
}

/** Physical source-cache inputs, independent of whether any shard or attempt is admissible. */
export function sourceCacheInputPaths(cacheRoot: string, knownKeys: readonly string[] = []): readonly string[] {
  const rawRoot = join(cacheRoot, "provider-raw");
  const paths = new Set([cacheRoot, extractionCacheManifestPath(cacheRoot), rawRoot]);
  const keys = new Set(knownKeys.filter(key => SourceKey.safeParse(key).success));
  for (const entry of entries(cacheRoot)) {
    const path = join(cacheRoot, entry.name);
    if (/^[0-9a-f]{2}$/u.test(entry.name)) {
      paths.add(path);
      if (entry.isDirectory()) for (const file of entries(path)) {
        if (!/^[0-9a-f]{64}\.json$/u.test(file.name)) continue;
        paths.add(join(path, file.name));
        keys.add(file.name.slice(0, 64));
      }
    } else if (/\.(?:json|jsonl)$/u.test(entry.name)) paths.add(path);
  }
  for (const bucket of entries(rawRoot)) {
    if (!/^[0-9a-f]{2}$/u.test(bucket.name)) continue;
    const path = join(rawRoot, bucket.name);
    paths.add(path);
    if (bucket.isDirectory()) for (const file of entries(path)) {
      if (!file.name.endsWith(".json")) continue;
      paths.add(join(path, file.name));
      if (/^[0-9a-f]{64}\..+\.json$/u.test(file.name)) keys.add(file.name.slice(0, 64));
    }
  }
  for (const key of keys) {
    const shard = cacheFilePath(cacheRoot, key);
    paths.add(dirname(shard));
    paths.add(shard);
    for (const path of providerRawAttemptInputPaths(cacheRoot, key)) paths.add(path);
  }
  return [...paths];
}
