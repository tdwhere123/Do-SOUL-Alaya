import { isDeepStrictEqual } from "node:util";
import {
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import type {
  SourceAssertionSupplementBatchReceipt,
  SourceAssertionSupplementBinding
} from "../../extraction/cache/semantic-supplement/source-assertion-supplement.js";
import type {
  LongMemEvalSnapshotExtractionShard,
  LongMemEvalSnapshotSeedRound,
  SnapshotExtractionProvenanceV3
} from "../materialize.js";

export type SemanticSupplementEntries = Map<
  string,
  SourceAssertionSupplementBatchReceipt
>;

export function readRoundSemanticSupplementShards(
  round: LongMemEvalSnapshotSeedRound
): readonly SourceAssertionSupplementBatchReceipt[] {
  return round.semanticSupplementShards ?? [];
}

export function sumExtractionShardCount(
  primary: readonly LongMemEvalSnapshotExtractionShard[],
  semantic: readonly SourceAssertionSupplementBatchReceipt[],
  field: "rawSignalCount" | "draftCount"
): number {
  return [...primary, ...semantic].reduce((sum, shard) => sum + shard[field], 0);
}

export function assertSemanticSupplementRound(input: {
  readonly semantic: readonly SourceAssertionSupplementBatchReceipt[];
  readonly semanticEntries: SemanticSupplementEntries;
  readonly semanticBinding: SourceAssertionSupplementBinding | undefined;
  readonly cacheKeys: readonly string[];
  readonly requests: readonly OfficialApiExtractionRequest[];
}): void {
  if (input.semantic.length === 0) return;
  if (input.semanticBinding === undefined) {
    throw new Error("snapshot semantic supplement authority is missing");
  }
  if (input.requests.length !== input.cacheKeys.length) {
    throw new Error("snapshot semantic supplement request plan cardinality mismatch");
  }
  const requests = new Map(input.cacheKeys.map((cacheKey, index) => [
    cacheKey,
    input.requests[index]
  ]));
  const seen = new Set<string>();
  for (const shard of input.semantic) {
    assertBatchIdentity(shard, requests.get(shard.primaryCacheKey), input, seen);
    const prior = input.semanticEntries.get(shard.primaryCacheKey);
    if (prior !== undefined && !isDeepStrictEqual(prior, shard)) {
      throw new Error("snapshot semantic supplement batch content drifted");
    }
    input.semanticEntries.set(shard.primaryCacheKey, shard);
  }
}

export function assertSemanticSupplementClosure(
  extraction: SnapshotExtractionProvenanceV3,
  entries: ReadonlyMap<string, SourceAssertionSupplementBatchReceipt>,
  binding: SourceAssertionSupplementBinding | undefined
): void {
  if (binding === undefined) {
    if (entries.size > 0) {
      throw new Error("snapshot semantic supplement authority is missing");
    }
    return;
  }
  const values = [...entries.values()];
  const assertionCount = values.reduce(
    (total, entry) => total + entry.assertionIds.length, 0
  );
  const occurrenceCount = values.reduce(
    (total, entry) => total + entry.occurrenceCount, 0
  );
  if (binding.primary_manifest_sha256 !== extraction.manifest_sha256 ||
      binding.parser_semantics !== OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION ||
      binding.grounding_semantics !== OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION ||
      binding.entry_count !== entries.size ||
      binding.assertion_count !== assertionCount ||
      binding.occurrence_count !== occurrenceCount ||
      values.some((entry) =>
        entry.semanticSupplementReceiptSha256 !== binding.receipt_sha256
      )) {
    throw new Error("snapshot semantic supplement closure mismatch");
  }
}

function assertBatchIdentity(
  shard: SourceAssertionSupplementBatchReceipt,
  request: OfficialApiExtractionRequest | undefined,
  input: Parameters<typeof assertSemanticSupplementRound>[0],
  seen: Set<string>
): void {
  const allowed = new Set(request?.source_assertions.map(
    ({ assertion_id }) => assertion_id
  ) ?? []);
  if (request === undefined || seen.has(shard.primaryCacheKey) ||
      shard.semanticSupplementReceiptSha256 !== input.semanticBinding?.receipt_sha256 ||
      shard.sourceCorpusIdentity !== request.source_corpus_identity ||
      shard.rawSignalCount < 1 || shard.rawSignalCount !== shard.draftCount ||
      !isSortedAssertionSubset(shard.assertionIds, allowed)) {
    throw new Error("snapshot semantic supplement batch identity mismatch");
  }
  seen.add(shard.primaryCacheKey);
}

function isSortedAssertionSubset(
  assertionIds: readonly number[],
  allowed: ReadonlySet<number>
): boolean {
  return assertionIds.length > 0 && assertionIds.every((assertionId, index) =>
    allowed.has(assertionId) && assertionId > 0 &&
    (index === 0 || assertionIds[index - 1]! < assertionId)
  );
}
