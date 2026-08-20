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
import {
  computeSourceAssertionSupplementEntrySetSha256,
  computeSourceAssertionSupplementSidecarProjectionSha256
} from "../../extraction/cache/semantic-supplement/source-assertion-supplement-closure.js";
import type {
  LongMemEvalSnapshotExtractionShard,
  LongMemEvalSnapshotSeedRound,
  SnapshotExtractionProvenanceV3
} from "../materialize.js";

interface ObservedSemanticSupplementEntry {
  readonly receipt: SourceAssertionSupplementBatchReceipt;
  observedOccurrences: number;
}

export interface SemanticSupplementEntries {
  readonly observed: Map<string, ObservedSemanticSupplementEntry>;
  readonly canonicalOccurrences: Map<string, number>;
}

export function createSemanticSupplementEntries(): SemanticSupplementEntries {
  return { observed: new Map(), canonicalOccurrences: new Map() };
}

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
  if (input.semanticBinding === undefined) {
    if (input.semantic.length > 0) {
      throw new Error("snapshot semantic supplement authority is missing");
    }
    return;
  }
  if (input.requests.length !== input.cacheKeys.length) {
    throw new Error("snapshot semantic supplement request plan cardinality mismatch");
  }
  recordCanonicalOccurrences(input.semanticEntries, input.cacheKeys);
  if (input.semantic.length === 0) return;
  const requests = new Map(input.cacheKeys.map((cacheKey, index) => [
    cacheKey,
    input.requests[index]
  ]));
  const seen = new Set<string>();
  for (const shard of input.semantic) {
    assertBatchIdentity(shard, requests.get(shard.primaryCacheKey), input, seen);
    const prior = input.semanticEntries.observed.get(shard.primaryCacheKey);
    if (prior !== undefined && !isDeepStrictEqual(prior.receipt, shard)) {
      throw new Error("snapshot semantic supplement batch content drifted");
    }
    if (prior === undefined) {
      input.semanticEntries.observed.set(shard.primaryCacheKey, {
        receipt: shard,
        observedOccurrences: 1
      });
    } else {
      prior.observedOccurrences += 1;
    }
  }
}

export function assertSemanticSupplementClosure(
  extraction: SnapshotExtractionProvenanceV3,
  entries: Readonly<SemanticSupplementEntries>,
  binding: SourceAssertionSupplementBinding | undefined
): void {
  if (binding === undefined) {
    if (entries.observed.size > 0) {
      throw new Error("snapshot semantic supplement authority is missing");
    }
    return;
  }
  const values = [...entries.observed.values()];
  const assertionCount = values.reduce(
    (total, entry) => total + entry.receipt.sourceObservationSha256s.length, 0
  );
  const occurrenceCount = values.reduce(
    (total, entry) => total + entry.observedOccurrences, 0
  );
  if (binding.receipt_schema_version !== 3 ||
      binding.mapping_basis !== "source-draft-to-current-anchor-v3" ||
      binding.primary_manifest_sha256 !== extraction.manifest_sha256 ||
      binding.parser_semantics !== OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION ||
      binding.grounding_semantics !== OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION ||
      binding.entry_count !== entries.observed.size ||
      binding.assertion_count !== assertionCount ||
      binding.occurrence_count !== occurrenceCount ||
      computeObservedEntrySetSha256(values) !== binding.entry_set_sha256 ||
      values.some(({ receipt, observedOccurrences }) =>
        receipt.semanticSupplementReceiptSha256 !== binding.receipt_sha256 ||
        receipt.occurrenceCount !== observedOccurrences ||
        receipt.occurrenceCount !==
          entries.canonicalOccurrences.get(receipt.primaryCacheKey)
      )) {
    throw new Error("snapshot semantic supplement closure mismatch");
  }
}

function recordCanonicalOccurrences(
  entries: SemanticSupplementEntries,
  cacheKeys: readonly string[]
): void {
  for (const cacheKey of cacheKeys) {
    entries.canonicalOccurrences.set(
      cacheKey,
      (entries.canonicalOccurrences.get(cacheKey) ?? 0) + 1
    );
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
      shard.sidecarProjectionSha256 !==
        computeSourceAssertionSupplementSidecarProjectionSha256(shard) ||
      !isSortedAssertionSubset(shard.anchorAssertionIds, allowed) ||
      !isSortedUniqueStrings(shard.sourceObservationSha256s)) {
    throw new Error("snapshot semantic supplement batch identity mismatch");
  }
  seen.add(shard.primaryCacheKey);
}

function computeObservedEntrySetSha256(
  entries: readonly ObservedSemanticSupplementEntry[]
): string {
  return computeSourceAssertionSupplementEntrySetSha256(entries.map(({ receipt }) => ({
    primaryCacheKey: receipt.primaryCacheKey,
    receiptEntrySha256: receipt.receiptEntrySha256,
    sidecarProjectionSha256: receipt.sidecarProjectionSha256
  })));
}

function isSortedUniqueStrings(values: readonly string[]): boolean {
  return values.length > 0 && values.every((value, index) =>
    /^[a-f0-9]{64}$/u.test(value) &&
    (index === 0 || Buffer.from(values[index - 1]!).compare(Buffer.from(value)) < 0)
  );
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
