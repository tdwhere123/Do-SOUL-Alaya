import { resolve } from "node:path";
import { readSnapshotSidecar } from "../../snapshot/materialize.js";
import { queryCachePrefixedSha256 } from "../query-semantic-factor-cache-identity.js";

export function compareQueryCacheCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function canonicalizeQueryCacheSourceTexts(
  sourceTexts: readonly string[]
): readonly string[] {
  if (sourceTexts.some((sourceText) => sourceText.length === 0)) {
    throw new Error("query semantic factor cache source set contains an empty source");
  }
  const canonical = [...new Set(sourceTexts)].sort(compareQueryCacheCodeUnits);
  if (canonical.length === 0) {
    throw new Error("query semantic factor cache request source set is empty");
  }
  return canonical;
}

export function queryCacheSourceSetDigest(sourceTexts: readonly string[]): string {
  return queryCachePrefixedSha256(canonicalizeQueryCacheSourceTexts(sourceTexts)
    .map((sourceText) => queryCachePrefixedSha256(sourceText))
    .sort(compareQueryCacheCodeUnits)
    .join("\n"));
}

export function querySemanticFactorCacheSourceSetSha256(
  sourceTexts: readonly string[]
): string {
  return queryCacheSourceSetDigest(sourceTexts);
}

export function queryCacheRequiredSourceTexts(snapshotPath: string): readonly string[] {
  return canonicalizeQueryCacheSourceTexts(
    readSnapshotSidecar(resolve(snapshotPath)).questions.map((question) => question.question)
  );
}

export function resolveQueryCacheRequestSourceTexts(request: Readonly<{
  readonly snapshotPath?: string;
  readonly requiredSourceTexts?: readonly string[];
}>): readonly string[] {
  if (request.snapshotPath !== undefined) {
    return queryCacheRequiredSourceTexts(request.snapshotPath);
  }
  if (request.requiredSourceTexts !== undefined) {
    return canonicalizeQueryCacheSourceTexts(request.requiredSourceTexts);
  }
  throw new Error("query semantic factor cache current bind requires a request source set");
}

export function assertQueryCacheSourceSet(
  cache: Readonly<{
    source_set_sha256: string;
    entries: readonly Readonly<{ source_text: string }>[];
  }>,
  requiredSourceTexts: readonly string[]
): void {
  const required = canonicalizeQueryCacheSourceTexts(requiredSourceTexts);
  const sources = new Set(cache.entries.map((entry) => entry.source_text));
  for (const sourceText of required) {
    if (!sources.has(sourceText)) {
      throw new Error("query semantic factor cache is missing a required query source");
    }
  }
  if (cache.source_set_sha256 !== queryCacheSourceSetDigest(required)) {
    throw new Error("query semantic factor cache source set does not match this request");
  }
}
