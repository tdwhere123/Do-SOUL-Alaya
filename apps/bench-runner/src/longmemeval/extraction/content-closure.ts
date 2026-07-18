import { createHash } from "node:crypto";
import {
  parseOfficialApiSignals
} from "@do-soul/alaya-soul";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { ExtractionCacheInvariantError } from "./cache/cache-invariant-error.js";

export interface ExtractionRawJsonInspection {
  readonly rawJsonSha256: string;
  readonly rawSignalCount: number;
  readonly parsedDraftCount: number;
}

export interface ExtractionContentClosureEntry extends ExtractionRawJsonInspection {
  readonly cacheKey: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
}

export type ExtractionContentClosureIndexValue = readonly [
  rawJsonSha256: string,
  rawSignalCount: number,
  parsedDraftCount: number
];

export type ExtractionContentClosureIndex = Readonly<Record<
  string,
  ExtractionContentClosureIndexValue
>>;

export function computeExtractionRawJsonSha256(rawJson: string): string {
  return createHash("sha256").update(rawJson, "utf8").digest("hex");
}

export function inspectExtractionRawJson(rawJson: string): ExtractionRawJsonInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch (cause) {
    throw new Error("extraction raw_json is not strict JSON", { cause });
  }
  const parsedDraftCount = parseOfficialApiSignals(rawJson).length;
  return {
    rawJsonSha256: computeExtractionRawJsonSha256(rawJson),
    rawSignalCount: countRawEnvelopeSignals(parsed),
    parsedDraftCount
  };
}

export function computeExtractionKeySetSha256(keys: Iterable<string>): string {
  return createHash("sha256")
    .update([...new Set(keys)].sort().join("\n"), "utf8")
    .digest("hex");
}

export function computeExtractionContentClosureSha256(
  entries: readonly ExtractionContentClosureEntry[]
): string {
  const rows = [...uniqueEntriesByKey(entries).values()]
    .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey))
    .map((entry) => JSON.stringify([
      entry.cacheKey,
      entry.model,
      entry.requestProfile,
      entry.rawJsonSha256,
      entry.rawSignalCount,
      entry.parsedDraftCount
    ]));
  return createHash("sha256").update(rows.join("\n"), "utf8").digest("hex");
}

export function buildExtractionContentClosureIndex(
  entries: readonly ExtractionContentClosureEntry[]
): ExtractionContentClosureIndex {
  return Object.fromEntries([...uniqueEntriesByKey(entries).values()]
    .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey))
    .map((entry) => [entry.cacheKey, [
      entry.rawJsonSha256,
      entry.rawSignalCount,
      entry.parsedDraftCount
    ] as const]));
}

export function extractionContentClosureEntriesFromIndex(
  index: ExtractionContentClosureIndex,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]
): readonly ExtractionContentClosureEntry[] {
  return Object.entries(index).map(([
    cacheKey,
    [rawJsonSha256, rawSignalCount, parsedDraftCount]
  ]) => ({
    cacheKey,
    model,
    requestProfile,
    rawJsonSha256,
    rawSignalCount,
    parsedDraftCount
  }));
}

function uniqueEntriesByKey(
  entries: readonly ExtractionContentClosureEntry[]
): ReadonlyMap<string, ExtractionContentClosureEntry> {
  const byKey = new Map(entries.map((entry) => [entry.cacheKey, entry] as const));
  if (byKey.size === entries.length) return byKey;
  throw new ExtractionCacheInvariantError(
    "extraction content closure contains duplicate cache keys"
  );
}

function countRawEnvelopeSignals(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null) return 0;
  const signals = (parsed as { readonly signals?: unknown }).signals;
  return Array.isArray(signals) ? signals.length : 0;
}
