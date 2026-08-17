import { createHash } from "node:crypto";

export interface SourceAssertionSupplementSidecarProjection {
  readonly primaryCacheKey: string;
  readonly sourceCacheKey: string;
  readonly sourceRawJsonSha256: string;
  readonly primaryRawJsonSha256: string;
  readonly selectedRawJsonSha256: string;
  readonly sourceCorpusIdentity: string;
  readonly anchorAssertionIds: readonly number[];
  readonly sourceObservationSha256s: readonly string[];
  readonly occurrenceCount: number;
  readonly rawSignalCount: number;
  readonly draftCount: number;
}

export interface SourceAssertionSupplementEntrySetMember {
  readonly primaryCacheKey: string;
  readonly receiptEntrySha256: string;
  readonly sidecarProjectionSha256: string;
}

interface ReceiptEntryProjectionSource {
  readonly primary_cache_key: string;
  readonly source_cache_key: string;
  readonly source_raw_json_sha256: string;
  readonly primary_raw_json_sha256: string;
  readonly selected_raw_json_sha256: string;
  readonly source_corpus_identity: string;
  readonly anchor_assertion_ids: readonly number[];
  readonly source_observation_sha256s: readonly string[];
  readonly occurrence_count: number;
  readonly selected_draft_count: number;
}

export function computeSourceAssertionSupplementSidecarProjectionSha256(
  projection: SourceAssertionSupplementSidecarProjection
): string {
  return digest(JSON.stringify({
    primaryCacheKey: projection.primaryCacheKey,
    sourceCacheKey: projection.sourceCacheKey,
    sourceRawJsonSha256: projection.sourceRawJsonSha256,
    primaryRawJsonSha256: projection.primaryRawJsonSha256,
    selectedRawJsonSha256: projection.selectedRawJsonSha256,
    sourceCorpusIdentity: projection.sourceCorpusIdentity,
    anchorAssertionIds: projection.anchorAssertionIds,
    sourceObservationSha256s: projection.sourceObservationSha256s,
    occurrenceCount: projection.occurrenceCount,
    rawSignalCount: projection.rawSignalCount,
    draftCount: projection.draftCount
  }));
}

export function computeSourceAssertionSupplementEntrySetSha256(
  members: readonly SourceAssertionSupplementEntrySetMember[]
): string {
  const sorted = [...members].sort((left, right) =>
    bytewiseCompare(left.primaryCacheKey, right.primaryCacheKey)
  );
  return digest(JSON.stringify(sorted));
}

export function computeSourceAssertionSupplementReceiptEntrySetSha256<
  Entry extends ReceiptEntryProjectionSource
>(entries: readonly Entry[]): string {
  return computeSourceAssertionSupplementEntrySetSha256(entries.map((entry) => ({
    primaryCacheKey: entry.primary_cache_key,
    receiptEntrySha256: computeSourceAssertionSupplementReceiptEntrySha256(entry),
    sidecarProjectionSha256: computeSourceAssertionSupplementSidecarProjectionSha256(
      sourceAssertionSupplementSidecarProjection(entry)
    )
  })));
}

export function computeSourceAssertionSupplementReceiptEntrySha256(
  entry: ReceiptEntryProjectionSource
): string {
  return digest(JSON.stringify(entry));
}

export function sourceAssertionSupplementSidecarProjection(
  entry: ReceiptEntryProjectionSource
): SourceAssertionSupplementSidecarProjection {
  return Object.freeze({
    primaryCacheKey: entry.primary_cache_key,
    sourceCacheKey: entry.source_cache_key,
    sourceRawJsonSha256: entry.source_raw_json_sha256,
    primaryRawJsonSha256: entry.primary_raw_json_sha256,
    selectedRawJsonSha256: entry.selected_raw_json_sha256,
    sourceCorpusIdentity: entry.source_corpus_identity,
    anchorAssertionIds: entry.anchor_assertion_ids,
    sourceObservationSha256s: entry.source_observation_sha256s,
    occurrenceCount: entry.occurrence_count,
    rawSignalCount: entry.selected_draft_count,
    draftCount: entry.selected_draft_count
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
