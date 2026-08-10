import { describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION,
  parseOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  createSourceAssertionSupplementReceipt,
  createSourceAssertionSupplementReader,
  parseSourceAssertionSupplementReceipt,
  sourceAssertionSupplementBinding
} from "../../../longmemeval/extraction/cache/semantic-supplement/source-assertion-supplement.js";
import { resolveSourceAssertionSupplementOptions } from
  "../../../longmemeval/extraction/cache/semantic-supplement/source-assertion-supplement-runtime.js";

const PRIMARY_MANIFEST_SHA = "1".repeat(64);
const SOURCE_MANIFEST_SHA = "2".repeat(64);
const PRIMARY_PROMPT_SHA = "3".repeat(64);
const SOURCE_PROMPT_SHA = "4".repeat(64);
const PRIMARY_CACHE_KEY = "5".repeat(64);
const SOURCE_CACHE_KEY = "6".repeat(64);
const CORPUS_ID = "7".repeat(64);

describe("source assertion semantic supplement", () => {
  it("selects only receipt-bound primary-gap assertions in the current batch", () => {
    const fixture = createFixture();
    const reader = createSourceAssertionSupplementReader({
      receipt: fixture.receipt,
      primaryIdentity: primaryIdentity(),
      sourceManifestSha256: SOURCE_MANIFEST_SHA,
      readSourceRawJson: (cacheKey) => {
        expect(cacheKey).toBe(SOURCE_CACHE_KEY);
        return fixture.sourceRawJson;
      }
    });

    const selected = reader.readBatch({
      request: fixture.request,
      primaryCacheKey: PRIMARY_CACHE_KEY,
      primaryRawJson: JSON.stringify({ signals: [signal(1, "primary")] })
    });

    expect(JSON.parse(selected.rawJson)).toEqual({
      signals: [expect.objectContaining({
        matched_text: "supplement",
        source_locator: expect.objectContaining({ assertion_id: 2 })
      })]
    });
    expect(selected.receipt).toMatchObject({
      primaryCacheKey: PRIMARY_CACHE_KEY,
      sourceCacheKey: SOURCE_CACHE_KEY,
      assertionIds: [2],
      rawSignalCount: 1,
      draftCount: 1
    });
  });

  it("fails closed when source bytes, primary coverage, or receipt identity drift", () => {
    const fixture = createFixture();
    const reader = createSourceAssertionSupplementReader({
      receipt: fixture.receipt,
      primaryIdentity: primaryIdentity(),
      sourceManifestSha256: SOURCE_MANIFEST_SHA,
      readSourceRawJson: () => fixture.sourceRawJson
    });

    expect(() => reader.readBatch({
      request: fixture.request,
      primaryCacheKey: PRIMARY_CACHE_KEY,
      primaryRawJson: JSON.stringify({ signals: [signal(2, "now-primary")] })
    })).toThrow(/primary-gap/u);

    const tamperedSource = createSourceAssertionSupplementReader({
      receipt: fixture.receipt,
      primaryIdentity: primaryIdentity(),
      sourceManifestSha256: SOURCE_MANIFEST_SHA,
      readSourceRawJson: () => JSON.stringify({ signals: [] })
    });
    expect(() => tamperedSource.readBatch({
      request: fixture.request,
      primaryCacheKey: PRIMARY_CACHE_KEY,
      primaryRawJson: JSON.stringify({ signals: [] })
    })).toThrow(/source raw/u);

    expect(() => createSourceAssertionSupplementReader({
      receipt: fixture.receipt,
      primaryIdentity: { ...primaryIdentity(), parserSemantics: "drifted" },
      sourceManifestSha256: SOURCE_MANIFEST_SHA,
      readSourceRawJson: () => fixture.sourceRawJson
    })).toThrow(/identity/u);
  });

  it("self-hashes the exact sorted batch mapping and rejects tampering", () => {
    const { receipt } = createFixture();
    expect(receipt.receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(parseSourceAssertionSupplementReceipt(receipt, "fixture")).toEqual(receipt);
    expect(() => parseSourceAssertionSupplementReceipt({
      ...receipt,
      assertion_count: receipt.assertion_count + 1
    }, "tampered")).toThrow(/invalid/u);
    expect(sourceAssertionSupplementBinding(receipt)).toEqual({
      kind: receipt.kind,
      receipt_sha256: receipt.receipt_sha256,
      entry_count: 1,
      assertion_count: 1,
      occurrence_count: 1,
      entry_set_sha256: receipt.entry_set_sha256,
      primary_manifest_sha256: PRIMARY_MANIFEST_SHA,
      source_manifest_sha256: SOURCE_MANIFEST_SHA,
      parser_semantics: OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
      grounding_semantics: OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION
    });
  });

  it("requires one logical model identity across physical raw authorities", () => {
    const { receipt } = createFixture();
    expect(() => parseSourceAssertionSupplementReceipt({
      ...receipt,
      source_identity: { ...receipt.source_identity, model: "different-model" }
    }, "model drift")).toThrow(/invalid/u);
  });

  it("requires an explicit receipt and source root as one runtime pair", () => {
    expect(resolveSourceAssertionSupplementOptions({}, "/repo")).toBeUndefined();
    expect(resolveSourceAssertionSupplementOptions({
      ALAYA_BENCH_SOURCE_ASSERTION_SUPPLEMENT_RECEIPT: "receipt.json",
      ALAYA_BENCH_SOURCE_ASSERTION_SUPPLEMENT_CACHE_ROOT: "old-cache"
    }, "/repo")).toEqual({
      receiptPath: "/repo/receipt.json",
      sourceCacheRoot: "/repo/old-cache"
    });
    expect(() => resolveSourceAssertionSupplementOptions({
      ALAYA_BENCH_SOURCE_ASSERTION_SUPPLEMENT_RECEIPT: "receipt.json"
    }, "/repo")).toThrow(/both/u);
  });
});

function createFixture() {
  const request = parseOfficialApiExtractionRequest({
    schema_version: 2,
    source_locator_contract_version: 2,
    batch_contract_version: 1,
    source_corpus_identity: CORPUS_ID,
    batch_index: 0,
    batch_count: 1,
    source_assertions: [
      { assertion_id: 1, text: "User: primary" },
      { assertion_id: 2, text: "User: supplement" }
    ]
  });
  const sourceRawJson = JSON.stringify({
    signals: [signal(1, "historical-primary"), signal(2, "supplement")]
  });
  const receipt = createSourceAssertionSupplementReceipt({
    createdAt: "2026-08-10T00:00:00.000Z",
    primaryIdentity: primaryIdentity(),
    sourceIdentity: {
      manifestSha256: SOURCE_MANIFEST_SHA,
      model: "DeepSeek-V4-Flash",
      modelFamily: "deepseek-v4-flash-nonthinking",
      requestProfile: "deepseek-v4-nonthinking-v1",
      systemPromptSha256: SOURCE_PROMPT_SHA
    },
    coverageAuditSha256: "8".repeat(64),
    groundingAuditSha256: "9".repeat(64),
    entries: [{
      primaryCacheKey: PRIMARY_CACHE_KEY,
      request,
      sourceCacheKey: SOURCE_CACHE_KEY,
      sourceRawJson,
      assertionIds: [2],
      occurrenceCount: 1
    }]
  });
  return { request, sourceRawJson, receipt };
}

function primaryIdentity() {
  return {
    manifestSha256: PRIMARY_MANIFEST_SHA,
    model: "DeepSeek-V4-Flash",
    modelFamily: "deepseek-v4-flash-nonthinking",
    requestProfile: "deepseek-v4-nonthinking-v1" as const,
    systemPromptSha256: PRIMARY_PROMPT_SHA,
    parserSemantics: OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
    groundingSemantics: OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION
  };
}

function signal(assertionId: number, matchedText: string) {
  return {
    signal_kind: "potential_claim",
    object_kind: "fact",
    confidence: 0.9,
    matched_text: matchedText,
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: assertionId
    }
  };
}
