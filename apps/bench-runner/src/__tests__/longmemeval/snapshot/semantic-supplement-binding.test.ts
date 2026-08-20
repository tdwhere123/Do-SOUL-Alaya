import { describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION,
  parseOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  assertSemanticSupplementClosure,
  assertSemanticSupplementRound,
  createSemanticSupplementEntries,
  type SemanticSupplementEntries
} from "../../../bench/snapshot/seed-ledger/semantic-supplement-binding.js";
import {
  computeSourceAssertionSupplementEntrySetSha256,
  computeSourceAssertionSupplementSidecarProjectionSha256,
  type SourceAssertionSupplementSidecarProjection
} from "../../../bench/extraction/cache/semantic-supplement/source-assertion-supplement-closure.js";

const PRIMARY_KEY = "1".repeat(64);
const RECEIPT_SHA = "2".repeat(64);
const PRIMARY_MANIFEST_SHA = "3".repeat(64);
const CORPUS_SHA = "4".repeat(64);

describe("snapshot semantic supplement binding", () => {
  it("closes exact receipt counts over unique bounded batches", () => {
    const entries = createSemanticSupplementEntries();
    const receipt = batch();
    observe(entries, receipt);
    observe(entries, receipt);
    assertSemanticSupplementClosure(extraction(), entries, binding(receipt));
    expect(entries.observed.size).toBe(1);
  });

  it("requires actual occurrences and the exact receipt entry set", () => {
    const receipt = batch();
    const missingOccurrence = createSemanticSupplementEntries();
    observe(missingOccurrence, receipt);
    observeWithoutSemantic(missingOccurrence, receipt);
    expect(() => assertSemanticSupplementClosure(
      extraction(), missingOccurrence, binding(receipt)
    )).toThrow(/closure/u);

    const replacement = batch({ sourceCacheKey: "c".repeat(64) });
    const replacedEntries = createSemanticSupplementEntries();
    observe(replacedEntries, replacement);
    observe(replacedEntries, replacement);
    expect(() => assertSemanticSupplementClosure(
      extraction(), replacedEntries, binding(receipt)
    )).toThrow(/closure/u);
  });

  it("fails closed on unbound or request-drifted supplemental batches", () => {
    expect(() => assertSemanticSupplementRound({
      semantic: [batch()],
      semanticEntries: createSemanticSupplementEntries(),
      semanticBinding: undefined,
      cacheKeys: [PRIMARY_KEY],
      requests: [request()]
    })).toThrow(/authority/u);
    expect(() => assertSemanticSupplementRound({
      semantic: [batch()],
      semanticEntries: createSemanticSupplementEntries(),
      semanticBinding: binding(batch()),
      cacheKeys: [PRIMARY_KEY],
      requests: []
    })).toThrow(/request plan cardinality/u);
    expect(() => assertSemanticSupplementRound({
      semantic: [{ ...batch(), sourceCorpusIdentity: "9".repeat(64) }],
      semanticEntries: createSemanticSupplementEntries(),
      semanticBinding: binding(batch()),
      cacheKeys: [PRIMARY_KEY],
      requests: [request()]
    })).toThrow(/identity/u);
  });

  it("rejects grounding semantics predating canonical v2 receipts", () => {
    const entries = createSemanticSupplementEntries();
    const receipt = batch();
    observe(entries, receipt);
    observe(entries, receipt);

    expect(() => assertSemanticSupplementClosure(extraction(), entries, {
      ...binding(receipt),
      grounding_semantics: "official-api-source-grounding-v2"
    })).toThrow(/closure/u);
  });
});

function request() {
  return parseOfficialApiExtractionRequest({
    schema_version: 2,
    source_locator_contract_version: 2,
    batch_contract_version: 1,
    source_corpus_identity: CORPUS_SHA,
    batch_index: 0,
    batch_count: 1,
    source_assertions: [{ assertion_id: 7, text: "User: selected" }]
  });
}

function batch(
  overrides: Partial<SourceAssertionSupplementSidecarProjection> = {}
) {
  const projection = {
    primaryCacheKey: PRIMARY_KEY,
    sourceCacheKey: "5".repeat(64),
    sourceRawJsonSha256: "6".repeat(64),
    primaryRawJsonSha256: "a".repeat(64),
    selectedRawJsonSha256: "7".repeat(64),
    sourceCorpusIdentity: CORPUS_SHA,
    anchorAssertionIds: [7],
    sourceObservationSha256s: ["b".repeat(64)],
    occurrenceCount: 2,
    rawSignalCount: 1,
    draftCount: 1,
    ...overrides
  } as const;
  return {
    semanticSupplementReceiptSha256: RECEIPT_SHA,
    receiptEntrySha256: "d".repeat(64),
    sidecarProjectionSha256:
      computeSourceAssertionSupplementSidecarProjectionSha256(projection),
    ...projection
  } as const;
}

function binding(receipt: ReturnType<typeof batch>) {
  return {
    kind: "longmemeval-source-assertion-semantic-supplement" as const,
    receipt_schema_version: 3 as const,
    mapping_basis: "source-draft-to-current-anchor-v3" as const,
    receipt_sha256: RECEIPT_SHA,
    entry_count: 1,
    assertion_count: 1,
    occurrence_count: 2,
    entry_set_sha256: computeSourceAssertionSupplementEntrySetSha256([{
      primaryCacheKey: receipt.primaryCacheKey,
      receiptEntrySha256: receipt.receiptEntrySha256,
      sidecarProjectionSha256: receipt.sidecarProjectionSha256
    }]),
    primary_manifest_sha256: PRIMARY_MANIFEST_SHA,
    source_manifest_sha256: "9".repeat(64),
    parser_semantics: OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
    grounding_semantics: OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION
  };
}

function observe(
  entries: SemanticSupplementEntries,
  receipt: ReturnType<typeof batch>
): void {
  assertSemanticSupplementRound({
    semantic: [receipt],
    semanticEntries: entries,
    semanticBinding: binding(receipt),
    cacheKeys: [PRIMARY_KEY],
    requests: [request()]
  });
}

function observeWithoutSemantic(
  entries: SemanticSupplementEntries,
  receipt: ReturnType<typeof batch>
): void {
  assertSemanticSupplementRound({
    semantic: [], semanticEntries: entries, semanticBinding: binding(receipt),
    cacheKeys: [PRIMARY_KEY], requests: [request()]
  });
}

function extraction() {
  return {
    manifest_sha256: PRIMARY_MANIFEST_SHA
  } as Parameters<typeof assertSemanticSupplementClosure>[0];
}
