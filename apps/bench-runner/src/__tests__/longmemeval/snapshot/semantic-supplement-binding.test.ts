import { describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION,
  parseOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  assertSemanticSupplementClosure,
  assertSemanticSupplementRound,
  type SemanticSupplementEntries
} from "../../../longmemeval/snapshot/seed-ledger/semantic-supplement-binding.js";

const PRIMARY_KEY = "1".repeat(64);
const RECEIPT_SHA = "2".repeat(64);
const PRIMARY_MANIFEST_SHA = "3".repeat(64);
const CORPUS_SHA = "4".repeat(64);

describe("snapshot semantic supplement binding", () => {
  it("closes exact receipt counts over unique bounded batches", () => {
    const entries: SemanticSupplementEntries = new Map();
    assertSemanticSupplementRound({
      semantic: [batch()],
      semanticEntries: entries,
      semanticBinding: binding(),
      cacheKeys: [PRIMARY_KEY],
      requests: [request()]
    });
    assertSemanticSupplementClosure(extraction(), entries, binding());
    expect(entries.size).toBe(1);
  });

  it("fails closed on unbound or request-drifted supplemental batches", () => {
    expect(() => assertSemanticSupplementRound({
      semantic: [batch()],
      semanticEntries: new Map(),
      semanticBinding: undefined,
      cacheKeys: [PRIMARY_KEY],
      requests: [request()]
    })).toThrow(/authority/u);
    expect(() => assertSemanticSupplementRound({
      semantic: [batch()],
      semanticEntries: new Map(),
      semanticBinding: binding(),
      cacheKeys: [PRIMARY_KEY],
      requests: []
    })).toThrow(/request plan cardinality/u);
    expect(() => assertSemanticSupplementRound({
      semantic: [{ ...batch(), sourceCorpusIdentity: "9".repeat(64) }],
      semanticEntries: new Map(),
      semanticBinding: binding(),
      cacheKeys: [PRIMARY_KEY],
      requests: [request()]
    })).toThrow(/identity/u);
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

function batch() {
  return {
    semanticSupplementReceiptSha256: RECEIPT_SHA,
    primaryCacheKey: PRIMARY_KEY,
    sourceCacheKey: "5".repeat(64),
    sourceRawJsonSha256: "6".repeat(64),
    selectedRawJsonSha256: "7".repeat(64),
    sourceCorpusIdentity: CORPUS_SHA,
    assertionIds: [7],
    occurrenceCount: 2,
    rawSignalCount: 1,
    draftCount: 1
  } as const;
}

function binding() {
  return {
    kind: "longmemeval-source-assertion-semantic-supplement" as const,
    receipt_sha256: RECEIPT_SHA,
    entry_count: 1,
    assertion_count: 1,
    occurrence_count: 2,
    entry_set_sha256: "8".repeat(64),
    primary_manifest_sha256: PRIMARY_MANIFEST_SHA,
    source_manifest_sha256: "9".repeat(64),
    parser_semantics: OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
    grounding_semantics: OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION
  };
}

function extraction() {
  return {
    manifest_sha256: PRIMARY_MANIFEST_SHA
  } as Parameters<typeof assertSemanticSupplementClosure>[0];
}
