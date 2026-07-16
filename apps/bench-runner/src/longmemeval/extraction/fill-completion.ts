import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CompileSeedExtractionConfig } from "../compile-seed-types.js";
import {
  computeCacheKey,
  inspectCachedExtraction
} from "../compile-seed-cache.js";
import {
  buildExtractionContentClosureIndex,
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  type ExtractionContentClosureIndex,
  type ExtractionContentClosureEntry
} from "./content-closure.js";
import { ExtractionCacheInvariantError } from "./cache-invariant-error.js";

export interface ExtractionFillCompletion {
  readonly expectedTurns: number;
  readonly validTurns: number;
  readonly missingTurns: number;
  readonly invalidTurns: number;
  readonly orphanTurns: number;
  readonly coverage: number;
  readonly expectedKeySetSha256: string;
  readonly contentClosureSha256: string | null;
  readonly contentClosureIndex?: ExtractionContentClosureIndex | null;
}

export interface ExtractionCacheContentInspection {
  readonly shardTurns: number;
  readonly validTurns: number;
  readonly invalidTurns: number;
  readonly keySetSha256: string;
  readonly contentClosureSha256: string | null;
}

interface ShardInspectionInput {
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
}

export function inspectExtractionFillCompletion(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly systemPrompt: string;
  readonly turnContents: readonly string[];
}): ExtractionFillCompletion {
  const expectedKeys = new Set(input.turnContents.map((turnContent) =>
    computeCacheKey(input.model, input.requestProfile, input.systemPrompt, turnContent)
  ));
  const counts = inspectExpectedShards(input, expectedKeys);
  const inventory = inspectShardInventory(input.cacheRoot);
  const orphanTurns = inventory.invalidEntries + [...inventory.keys]
    .filter((cacheKey) => !expectedKeys.has(cacheKey)).length;
  const closure = completeContentClosure(counts, expectedKeys.size);
  return {
    expectedTurns: expectedKeys.size,
    validTurns: counts.valid,
    missingTurns: counts.missing,
    invalidTurns: counts.invalid,
    orphanTurns,
    coverage: expectedKeys.size === 0 ? 1 : counts.valid / expectedKeys.size,
    expectedKeySetSha256: computeExtractionKeySetSha256(expectedKeys),
    contentClosureSha256: closure?.sha256 ?? null,
    contentClosureIndex: closure?.index ?? null
  };
}

export function inspectExtractionCacheContentClosure(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
}): ExtractionCacheContentInspection {
  const inventory = inspectShardInventory(input.cacheRoot);
  const counts = inspectExpectedShards(input, inventory.keys);
  const invalidTurns = inventory.invalidEntries + counts.invalid + counts.missing;
  return {
    shardTurns: inventory.keys.size,
    validTurns: counts.valid,
    invalidTurns,
    keySetSha256: computeExtractionKeySetSha256(inventory.keys),
    contentClosureSha256: invalidTurns === 0
      ? computeExtractionContentClosureSha256(counts.entries)
      : null
  };
}

export function assertExtractionFillComplete(
  completion: ExtractionFillCompletion
): void {
  if (completion.validTurns === completion.expectedTurns &&
    completion.missingTurns === 0 && completion.invalidTurns === 0 &&
    completion.orphanTurns === 0 && completion.contentClosureSha256 !== null &&
    completion.contentClosureIndex != null) return;
  throw new ExtractionCacheInvariantError(
    "extraction-fill completion refused: " +
      `valid=${completion.validTurns}/${completion.expectedTurns} ` +
      `missing=${completion.missingTurns} invalid=${completion.invalidTurns} ` +
      `orphan=${completion.orphanTurns}`
  );
}

function inspectExpectedShards(
  input: ShardInspectionInput,
  expectedKeys: ReadonlySet<string>
): {
  readonly valid: number;
  readonly missing: number;
  readonly invalid: number;
  readonly entries: readonly ExtractionContentClosureEntry[];
} {
  let valid = 0;
  let missing = 0;
  let invalid = 0;
  const entries: ExtractionContentClosureEntry[] = [];
  for (const cacheKey of expectedKeys) {
    const result = inspectCachedExtraction(
      input.cacheRoot, cacheKey, input.model, input.requestProfile
    );
    if (result.status === "hit") {
      valid += 1;
      entries.push({
        cacheKey,
        model: input.model,
        requestProfile: input.requestProfile,
        rawJsonSha256: result.rawJsonSha256,
        rawSignalCount: result.rawSignalCount,
        parsedDraftCount: result.parsedDraftCount
      });
    }
    else if (result.status === "missing") missing += 1;
    else invalid += 1;
  }
  return { valid, missing, invalid, entries };
}

function inspectShardInventory(cacheRoot: string): {
  readonly keys: ReadonlySet<string>;
  readonly invalidEntries: number;
} {
  let entries;
  try {
    entries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch (cause) {
    throw unreadableCacheError(cacheRoot, cause);
  }
  const keys = new Set<string>();
  let invalidEntries = 0;
  for (const prefix of entries) {
    if (!/^[0-9a-f]{2}$/u.test(prefix.name)) continue;
    if (!prefix.isDirectory() || prefix.isSymbolicLink()) {
      throw new ExtractionCacheInvariantError(
        `extraction-fill completion cannot inspect shard prefix ${prefix.name}`
      );
    }
    const prefixInventory = inspectPrefixInventory(cacheRoot, prefix.name);
    for (const key of prefixInventory.keys) keys.add(key);
    invalidEntries += prefixInventory.invalidEntries;
  }
  return { keys, invalidEntries };
}

function inspectPrefixInventory(
  cacheRoot: string,
  prefix: string
): { readonly keys: readonly string[]; readonly invalidEntries: number } {
  let entries;
  try {
    entries = readdirSync(join(cacheRoot, prefix), { withFileTypes: true });
  } catch (cause) {
    throw unreadableCacheError(join(cacheRoot, prefix), cause);
  }
  const keys: string[] = [];
  let invalidEntries = 0;
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const match = /^([0-9a-f]{64})\.json$/u.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || match === null ||
        !match[1]!.startsWith(prefix)) {
      invalidEntries += 1;
    } else {
      keys.push(match[1]!);
    }
  }
  return { keys, invalidEntries };
}

function completeContentClosure(
  counts: ReturnType<typeof inspectExpectedShards>,
  expectedTurns: number
): {
  readonly sha256: string;
  readonly index: ExtractionContentClosureIndex;
} | null {
  if (counts.valid !== expectedTurns || counts.missing !== 0 || counts.invalid !== 0) {
    return null;
  }
  return {
    sha256: computeExtractionContentClosureSha256(counts.entries),
    index: buildExtractionContentClosureIndex(counts.entries)
  };
}

function unreadableCacheError(path: string, cause: unknown): ExtractionCacheInvariantError {
  return new ExtractionCacheInvariantError(
    `extraction-fill completion cannot inspect ${path}`,
    { cause }
  );
}
