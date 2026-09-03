import { closeSync } from "node:fs";
import { inspectCachedRawExtraction } from
  "../../../compile-seed/cache/cache-shard.js";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import { readExtractionCacheManifestIdentity } from
  "../../cache/extraction-cache-manifest.js";
import { hasCompleteExtractionFillSummary } from "../fill-authority.js";
import {
  assertDirectoryIdentity,
  openExistingCacheRoot,
  type DirectoryIdentity
} from "./root-directory-binding.js";

export interface HistoricalSubstrateBinding {
  readonly cacheRoot: string;
  readonly identity: DirectoryIdentity;
  readonly manifestSha256: string;
}

export interface HistoricalKeyRawClosure {
  readonly claimedComplete: boolean;
  readonly complete: boolean;
  readonly coverage: number;
  readonly expectedKeys: number;
  readonly missingKeys: number;
  readonly invalidKeys: number;
  readonly manifestSha256?: string;
}

export function captureHistoricalSubstrateBinding(
  cacheRoot: string
): HistoricalSubstrateBinding {
  const bound = openExistingCacheRoot(cacheRoot);
  try {
    const closure = inspectBoundHistoricalKeyRawClosure(bound);
    assertCompleteHistoricalKeyRawClosure(closure);
    assertDirectoryIdentity(
      bound.path, bound.identity, "historical extraction cache root"
    );
    return Object.freeze({
      cacheRoot: bound.path,
      identity: bound.identity,
      manifestSha256: closure.manifestSha256!
    });
  } finally {
    closeSync(bound.descriptor);
  }
}

export function assertHistoricalKeyRawClosure(
  binding: HistoricalSubstrateBinding
): void {
  assertHistoricalSubstratePublish(binding);
}

export function assertHistoricalSubstratePublish(
  binding: HistoricalSubstrateBinding
): void {
  assertDirectoryIdentity(
    binding.cacheRoot, binding.identity, "historical extraction cache root"
  );
  const opened = openExistingCacheRoot(binding.cacheRoot);
  try {
    if (opened.identity.device !== binding.identity.device ||
        opened.identity.inode !== binding.identity.inode) {
      throw new ExtractionCacheInvariantError(
        "historical extraction cache root identity changed while leased"
      );
    }
    const closure = inspectBoundHistoricalKeyRawClosure(opened);
    if (closure.manifestSha256 !== binding.manifestSha256) {
      throw new ExtractionCacheInvariantError(
        "historical extraction cache manifest identity changed while leased"
      );
    }
    assertCompleteHistoricalKeyRawClosure(closure);
  } finally {
    closeSync(opened.descriptor);
  }
}

export function assertClaimedHistoricalKeyRawClosure(cacheRoot: string): void {
  const closure = inspectHistoricalKeyRawClosure(cacheRoot);
  if (!closure.claimedComplete) return;
  assertCompleteHistoricalKeyRawClosure(closure);
}

export function inspectHistoricalKeyRawClosure(
  cacheRoot: string
): HistoricalKeyRawClosure {
  const bound = openExistingCacheRoot(cacheRoot);
  try {
    return inspectBoundHistoricalKeyRawClosure(bound);
  } finally {
    closeSync(bound.descriptor);
  }
}

function inspectBoundHistoricalKeyRawClosure(
  bound: ReturnType<typeof openExistingCacheRoot>
): HistoricalKeyRawClosure {
  const stableRoot = `/proc/self/fd/${bound.descriptor}`;
  const identity = readExtractionCacheManifestIdentity(stableRoot);
  if (identity === undefined) return unclaimedClosure();
  const manifest = identity.manifest;
  const claimedComplete = hasCompleteExtractionFillSummary(manifest);
  const index = manifest.content_closure_index;
  const model = manifest.extraction_model;
  const requestProfile = manifest.request_profile;
  if (index === undefined || requestProfile === undefined) {
    return Object.freeze({
      claimedComplete,
      complete: false,
      coverage: 0,
      expectedKeys: 0,
      missingKeys: 0,
      invalidKeys: 0,
      manifestSha256: identity.manifestSha256
    });
  }
  const keys = Object.keys(index);
  let missingKeys = 0;
  let invalidKeys = 0;
  for (const cacheKey of keys) {
    const expected = index[cacheKey];
    const inspected = inspectCachedRawExtraction(
      stableRoot, cacheKey, model, requestProfile
    );
    if (inspected.status === "missing") {
      missingKeys += 1;
      continue;
    }
    if (inspected.status !== "hit" || expected === undefined ||
        inspected.rawJsonSha256 !== expected[0] ||
        inspected.rawSignalCount !== expected[1]) {
      invalidKeys += 1;
    }
  }
  const expectedKeys = keys.length;
  const validKeys = expectedKeys - missingKeys - invalidKeys;
  const complete = claimedComplete && missingKeys === 0 && invalidKeys === 0 &&
    validKeys === expectedKeys;
  const coverage = expectedKeys === 0 ? 1 : validKeys / expectedKeys;
  return Object.freeze({
    claimedComplete,
    complete,
    coverage: complete ? 1 : coverage,
    expectedKeys,
    missingKeys,
    invalidKeys,
    manifestSha256: identity.manifestSha256
  });
}

function assertCompleteHistoricalKeyRawClosure(closure: HistoricalKeyRawClosure): void {
  if (closure.complete && closure.coverage === 1) return;
  throw new ExtractionCacheInvariantError(
    "historical F0-F2 key/raw closure is incomplete; coverage cannot be 1: " +
      `missing=${closure.missingKeys} invalid=${closure.invalidKeys} ` +
      `expected=${closure.expectedKeys}`
  );
}

function unclaimedClosure(): HistoricalKeyRawClosure {
  return Object.freeze({
    claimedComplete: false,
    complete: false,
    coverage: 0,
    expectedKeys: 0,
    missingKeys: 0,
    invalidKeys: 0
  });
}
