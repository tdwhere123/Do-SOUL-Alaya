import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ExtractionCacheInvariantError } from "./cache-invariant-error.js";

const EXTRACTION_FILL_LOCK_DIR = ".extraction-fill.lock";

export interface ExtractionCacheWriteLease {
  readonly cacheRoot: string;
  assertOwned(): void;
  release(): void;
}

export function acquireExtractionCacheWriteLease(
  cacheRoot: string
): ExtractionCacheWriteLease {
  mkdirSync(cacheRoot, { recursive: true });
  const lockPath = join(cacheRoot, EXTRACTION_FILL_LOCK_DIR);
  const token = randomUUID();
  try {
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() })}\n`,
      "utf8"
    );
  } catch (cause) {
    if (hasErrorCode(cause, "EEXIST")) {
      throw new ExtractionCacheInvariantError(
        `extraction cache root ${cacheRoot} already has a writer lock; ` +
          `remove ${lockPath} only after verifying its owner process is stopped`
      );
    }
    rmSync(lockPath, { recursive: true, force: true });
    throw cause;
  }
  return {
    cacheRoot,
    assertOwned: () => assertExtractionCacheWriteLeaseOwner(lockPath, token),
    release: () => releaseExtractionCacheWriteLease(lockPath, token)
  };
}

export async function withExtractionCacheWriteLease<T>(
  lease: ExtractionCacheWriteLease,
  task: () => Promise<T>
): Promise<T> {
  let failed = false;
  let failure: unknown;
  try {
    return await task();
  } catch (cause) {
    failed = true;
    failure = cause;
    throw cause;
  } finally {
    try {
      lease.release();
    } catch (releaseFailure) {
      if (failed) {
        throw new AggregateError(
          [failure, releaseFailure],
          "extraction failed and its cache writer lock could not be released"
        );
      }
      throw releaseFailure;
    }
  }
}

export function assertManifestlessCacheIsEmpty(cacheRoot: string): void {
  let entries;
  try {
    entries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch (cause) {
    throw new Error(
      `extraction-fill: cannot inspect manifest-less cache root ${cacheRoot}: ${String(cause)}`
    );
  }
  for (const entry of entries) {
    if (!/^[0-9a-f]{2}$/u.test(entry.name)) continue;
    assertEmptyShardPrefix(cacheRoot, entry);
  }
}

function assertEmptyShardPrefix(
  cacheRoot: string,
  entry: { readonly name: string; isDirectory(): boolean; isSymbolicLink(): boolean }
): void {
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new ExtractionCacheInvariantError(
      "extraction-fill: manifest-less cache has a suspicious shard prefix"
    );
  }
  let children: string[];
  try {
    children = readdirSync(join(cacheRoot, entry.name));
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `extraction-fill: cannot inspect shard prefix ${entry.name}: ${String(cause)}`
    );
  }
  if (children.length > 0) {
    throw new ExtractionCacheInvariantError(
      "extraction-fill: cache identity is not initialized but shard files already exist"
    );
  }
}

function releaseExtractionCacheWriteLease(lockPath: string, token: string): void {
  assertExtractionCacheWriteLeaseOwner(lockPath, token);
  rmSync(lockPath, { recursive: true, force: true });
}

function assertExtractionCacheWriteLeaseOwner(lockPath: string, token: string): void {
  let currentToken: unknown;
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as {
      readonly token?: unknown;
    };
    currentToken = owner.token;
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `cannot verify extraction cache writer lock owner: ${String(cause)}`
    );
  }
  if (currentToken !== token) {
    throw new ExtractionCacheInvariantError(
      "extraction cache writer lock ownership changed before release"
    );
  }
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null &&
    "code" in cause && cause.code === code;
}
