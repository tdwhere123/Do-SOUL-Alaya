import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION,
  buildOfficialApiExtractionRequests,
  buildOfficialApiSourceCorpus,
  computeOfficialApiSourceCorpusIdentity,
  parseOfficialApiExtractionRequest,
  parseOfficialApiSignals
} from "@do-soul/alaya-soul";
import {
  createSourceAssertionSupplementReceipt,
  createSourceAssertionSupplementReader,
  parseSourceAssertionSupplementReceipt,
  sourceAssertionSupplementBinding
} from "../../../runs/extraction/cache/semantic-supplement/source-assertion-supplement.js";
import { resolveSourceAssertionSupplementOptions } from
  "../../../runs/extraction/cache/semantic-supplement/source-assertion-supplement-runtime.js";
import { computeSourceAssertionSupplementReceiptEntrySetSha256 } from
  "../../../runs/extraction/cache/semantic-supplement/source-assertion-supplement-closure.js";

const PRIMARY_MANIFEST_SHA = "1".repeat(64);
const SOURCE_MANIFEST_SHA = "2".repeat(64);
const PRIMARY_PROMPT_SHA = "3".repeat(64);
const SOURCE_PROMPT_SHA = "4".repeat(64);
const PRIMARY_CACHE_KEY = "5".repeat(64);
const SOURCE_CACHE_KEY = "6".repeat(64);

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
      primaryRawJson: fixture.primaryRawJson,
      sourceCorpus: fixture.sourceCorpus
    });

    expect(JSON.parse(selected.rawJson)).toEqual({
      signals: [expect.objectContaining({
        matched_text: "I work remotely.",
        source_locator: expect.objectContaining({ assertion_id: 2 })
      })]
    });
    expect(selected.receipt).toMatchObject({
      primaryCacheKey: PRIMARY_CACHE_KEY,
      sourceCacheKey: SOURCE_CACHE_KEY,
      anchorAssertionIds: [2],
      rawSignalCount: 1,
      draftCount: 1
    });
  });

  it("rebinds historical locators to the current assertion catalog by matched text", () => {
    const { request, sourceCorpus } = requestFixture(
      "I attended University of Melbourne. We had dinner."
    );
    const primaryRawJson = JSON.stringify({ signals: [signal(2, "We had dinner.")] });
    const sourceRawJson = JSON.stringify({
      signals: [
        signal(3, "I attended University of Melbourne."),
        signal(4, "We had dinner.")
      ]
    });
    const receipt = createSourceAssertionSupplementReceipt({
      createdAt: "2026-08-10T00:00:00.000Z",
      primaryIdentity: primaryIdentity(),
      sourceIdentity: sourceIdentity(),
      coverageAuditSha256: "8".repeat(64),
      groundingAuditSha256: "9".repeat(64),
      entries: [{
        primaryCacheKey: PRIMARY_CACHE_KEY,
        request,
        sourceCacheKey: SOURCE_CACHE_KEY,
        sourceRawJson,
        primaryRawJson,
        sourceCorpus,
        anchorAssertionIds: [1],
        occurrenceCount: 1
      }]
    });
    const reader = createSourceAssertionSupplementReader({
      receipt,
      primaryIdentity: primaryIdentity(),
      sourceManifestSha256: SOURCE_MANIFEST_SHA,
      readSourceRawJson: () => sourceRawJson
    });

    const selected = reader.readBatch({
      request,
      primaryCacheKey: PRIMARY_CACHE_KEY,
      primaryRawJson,
      sourceCorpus
    });

    expect(JSON.parse(selected.rawJson)).toEqual({
      signals: [expect.objectContaining({
        matched_text: "I attended University of Melbourne.",
        source_locator: expect.objectContaining({ assertion_id: 1 })
      })]
    });
    expect(selected.receipt?.anchorAssertionIds).toEqual([1]);
  });

  it("fails closed when matched text maps to multiple current assertions", () => {
    const sourceCorpus = "User: University of Melbourne\nAssistant: University of Melbourne";
    const request = parseOfficialApiExtractionRequest({
      schema_version: 2,
      source_locator_contract_version: 2,
      batch_contract_version: 1,
      source_corpus_identity: computeOfficialApiSourceCorpusIdentity(sourceCorpus),
      batch_index: 0,
      batch_count: 1,
      source_assertions: [
        { assertion_id: 1, text: "User: University of Melbourne" },
        { assertion_id: 2, text: "Assistant: University of Melbourne" }
      ]
    });
    const sourceRawJson = JSON.stringify({
      signals: [signal(2, "University of Melbourne")]
    });

    expect(() => createSourceAssertionSupplementReceipt({
      createdAt: "2026-08-10T00:00:00.000Z",
      primaryIdentity: primaryIdentity(),
      sourceIdentity: sourceIdentity(),
      coverageAuditSha256: "8".repeat(64),
      groundingAuditSha256: "9".repeat(64),
      entries: [{
        primaryCacheKey: PRIMARY_CACHE_KEY,
        request,
        sourceCacheKey: SOURCE_CACHE_KEY,
        sourceRawJson,
        primaryRawJson: '{"signals":[]}',
        sourceCorpus,
        anchorAssertionIds: [2],
        occurrenceCount: 1
      }]
    })).toThrow(/ambiguous/u);
  });

  it("uses a receipt-bound source draft identity when the exact quote is not cataloged", () => {
    const fixture = createStrictCatalogAnchorFixture();
    const receipt = createStrictCatalogAnchorReceipt(fixture, [fixture.binding]);
    const selected = readStrictCatalogReceipt(receipt, fixture);

    expect(JSON.parse(selected.rawJson)).toEqual({
      signals: [expect.objectContaining({
        matched_text: fixture.universityQuote,
        source_locator: expect.objectContaining({ assertion_id: 1 })
      })]
    });
  });

  it("fails closed for invalid source draft anchor bindings", () => {
    const fixture = createStrictCatalogAnchorFixture();
    expect.soft(() => createStrictCatalogAnchorReceipt(fixture, [{
      ...fixture.binding,
      sourceDraftSha256: "0".repeat(64)
    }])).toThrow(/source draft identity/u);
    expect.soft(() => createStrictCatalogAnchorReceipt(fixture, [{
      ...fixture.binding,
      currentAssertionId: 99
    }])).toThrow(/current request anchor/u);
    expect.soft(() => createStrictCatalogAnchorReceipt(fixture, [
      fixture.binding,
      fixture.binding
    ])).toThrow(/duplicate source draft identity/u);
  });

  it.each([
    ["current anchor", "current_anchor_assertion_sha256", false, /anchor binding/u],
    ["grounded assertion", "grounded_source_assertion_sha256", true,
      /grounded source assertion/u]
  ] as const)("revalidates a forged %s digest while reading", (
    _label, field, replaceObservation, expected
  ) => {
    const fixture = createStrictCatalogAnchorFixture();
    const receipt = createStrictCatalogAnchorReceipt(fixture, [fixture.binding]);
    const forged = resignReceiptBinding(receipt, field, replaceObservation);
    expect(parseSourceAssertionSupplementReceipt(forged, "forged receipt")).toEqual(forged);
    expect(() => readStrictCatalogReceipt(forged, fixture)).toThrow(expected);
  });

  it.each([
    ["Assistant block", [userMessage(STRICT_CATALOG_ROAD),
      assistantMessage(STRICT_CATALOG_QUOTE)]],
    ["another User block", [userMessage(STRICT_CATALOG_ROAD),
      assistantMessage("That sounds memorable."), userMessage(STRICT_CATALOG_QUOTE)]],
    ["a repeated quote", [userMessage(
      `${STRICT_CATALOG_ROAD} ${STRICT_CATALOG_QUOTE} ${STRICT_CATALOG_QUOTE}`
    )]]
  ])("rejects an explicit anchor quote from %s", (_label, messages) => {
    expect(() => createExplicitAnchorReceipt(messages)).toThrow(/source quote is not grounded/u);
  });

  it("rejects a legacy v2 receipt", () => {
    const { receipt } = createFixture();
    expect(() => parseSourceAssertionSupplementReceipt({
      ...receipt,
      schema_version: 2,
      mapping_basis: "source-exact-current-assertion-rebind-v2"
    }, "legacy v2 receipt")).toThrow(/invalid/u);
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
      primaryRawJson: JSON.stringify({ signals: [signal(2, "I work remotely.")] }),
      sourceCorpus: fixture.sourceCorpus
    })).toThrow(/primary raw/u);

    const tamperedSource = createSourceAssertionSupplementReader({
      receipt: fixture.receipt,
      primaryIdentity: primaryIdentity(),
      sourceManifestSha256: SOURCE_MANIFEST_SHA,
      readSourceRawJson: () => JSON.stringify({ signals: [] })
    });
    expect(() => tamperedSource.readBatch({
      request: fixture.request,
      primaryCacheKey: PRIMARY_CACHE_KEY,
      primaryRawJson: fixture.primaryRawJson,
      sourceCorpus: fixture.sourceCorpus
    })).toThrow(/source raw/u);

    expect(() => createSourceAssertionSupplementReader({
      receipt: fixture.receipt,
      primaryIdentity: { ...primaryIdentity(), parserSemantics: "drifted" },
      sourceManifestSha256: SOURCE_MANIFEST_SHA,
      readSourceRawJson: () => fixture.sourceRawJson
    })).toThrow(/identity/u);
  });

  it("suppresses only a canonically grounded primary duplicate", () => {
    const fixture = createFixture();
    expect(() => createSourceAssertionSupplementReceipt({
      createdAt: "2026-08-10T00:00:00.000Z",
      primaryIdentity: primaryIdentity(),
      sourceIdentity: sourceIdentity(),
      coverageAuditSha256: "8".repeat(64),
      groundingAuditSha256: "9".repeat(64),
      entries: [{
        primaryCacheKey: PRIMARY_CACHE_KEY,
        request: fixture.request,
        sourceCacheKey: SOURCE_CACHE_KEY,
        sourceRawJson: fixture.sourceRawJson,
        primaryRawJson: JSON.stringify({ signals: [signal(2, "I work remotely.")] }),
        sourceCorpus: fixture.sourceCorpus,
        anchorAssertionIds: [2],
        occurrenceCount: 1
      }]
    })).toThrow(/primary-gap/u);
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
      receipt_schema_version: 3,
      mapping_basis: "source-draft-to-current-anchor-v3",
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
  const { request, sourceCorpus } = requestFixture("I moved to Berlin. I work remotely.");
  const primaryRawJson = JSON.stringify({ signals: [signal(1, "I moved to Berlin.")] });
  const sourceRawJson = JSON.stringify({
    signals: [signal(1, "I moved to Berlin."), signal(2, "I work remotely.")]
  });
  const receipt = createSourceAssertionSupplementReceipt({
    createdAt: "2026-08-10T00:00:00.000Z",
    primaryIdentity: primaryIdentity(),
    sourceIdentity: sourceIdentity(),
    coverageAuditSha256: "8".repeat(64),
    groundingAuditSha256: "9".repeat(64),
    entries: [{
      primaryCacheKey: PRIMARY_CACHE_KEY,
      request,
      sourceCacheKey: SOURCE_CACHE_KEY,
      sourceRawJson,
      primaryRawJson,
      sourceCorpus,
      anchorAssertionIds: [2],
      occurrenceCount: 1
    }]
  });
  return { request, sourceCorpus, primaryRawJson, sourceRawJson, receipt };
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

function sourceIdentity() {
  return {
    manifestSha256: SOURCE_MANIFEST_SHA,
    model: "DeepSeek-V4-Flash",
    modelFamily: "deepseek-v4-flash-nonthinking",
    requestProfile: "deepseek-v4-nonthinking-v1" as const,
    systemPromptSha256: SOURCE_PROMPT_SHA
  };
}

const STRICT_CATALOG_QUOTE =
  "I actually went there with some friends during my study abroad program at the University of Melbourne.";
const STRICT_CATALOG_ROAD = "I've been to the Great Ocean Road.";
function createStrictCatalogAnchorFixture() {
  const universityQuote = STRICT_CATALOG_QUOTE;
  const { request, sourceCorpus } = requestFixture([
    "I've been to the Great Ocean Road, and it was beautiful.",
    universityQuote,
    "We had a blast exploring the coast."
  ].join(" "));
  const primaryRawJson = JSON.stringify({ signals: [
    signal(1, "I've been to the Great Ocean Road, and it was beautiful.")
  ] });
  const sourceRawJson = JSON.stringify({ signals: [signal(3, universityQuote)] });
  const [sourceDraft] = parseOfficialApiSignals(sourceRawJson);
  if (sourceDraft === undefined) throw new Error("expected source draft fixture");
  return {
    request,
    sourceCorpus,
    primaryRawJson,
    sourceRawJson,
    universityQuote,
    binding: {
      sourceDraftIndex: 0,
      sourceDraftSha256: digest(JSON.stringify(sourceDraft)),
      currentAssertionId: 1
    }
  };
}
function createStrictCatalogAnchorReceipt(
  fixture: Pick<ReturnType<typeof createStrictCatalogAnchorFixture>,
    "request" | "sourceRawJson" | "primaryRawJson" | "sourceCorpus">,
  sourceDraftBindings: readonly Readonly<{
    sourceDraftIndex: number; sourceDraftSha256: string; currentAssertionId: number;
  }>[]
) {
  return createSourceAssertionSupplementReceipt({
    createdAt: "2026-08-10T00:00:00.000Z",
    primaryIdentity: primaryIdentity(),
    sourceIdentity: sourceIdentity(),
    coverageAuditSha256: "8".repeat(64),
    groundingAuditSha256: "9".repeat(64),
    entries: [{
      primaryCacheKey: PRIMARY_CACHE_KEY,
      request: fixture.request,
      sourceCacheKey: SOURCE_CACHE_KEY,
      sourceRawJson: fixture.sourceRawJson,
      primaryRawJson: fixture.primaryRawJson,
      sourceCorpus: fixture.sourceCorpus,
      anchorAssertionIds: [1],
      sourceDraftBindings,
      occurrenceCount: 1
    }]
  });
}
function resignReceiptBinding(
  receipt: ReturnType<typeof createStrictCatalogAnchorReceipt>,
  field: "current_anchor_assertion_sha256" | "grounded_source_assertion_sha256",
  replaceObservation: boolean
) {
  const forgedSha256 = "0".repeat(64);
  const entry = receipt.entries[0]!;
  const binding = entry.source_draft_bindings[0]!;
  const entries = [{
    ...entry,
    source_observation_sha256s: replaceObservation ? [forgedSha256]
      : entry.source_observation_sha256s,
    source_draft_bindings: [{ ...binding, [field]: forgedSha256 }]
  }];
  const resigned = { ...receipt,
    entry_set_sha256: computeSourceAssertionSupplementReceiptEntrySetSha256(entries), entries };
  const { receipt_sha256: _receiptSha256, ...unsigned } = resigned;
  return { ...unsigned, receipt_sha256: digest(JSON.stringify(unsigned)) };
}
function createExplicitAnchorReceipt(
  messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[]
) {
  const sourceCorpus = buildOfficialApiSourceCorpus("", messages);
  const [request] = buildOfficialApiExtractionRequests("", messages);
  if (request === undefined) throw new Error("expected explicit anchor request");
  const sourceRawJson = JSON.stringify({ signals: [signal(3, STRICT_CATALOG_QUOTE)] });
  const [sourceDraft] = parseOfficialApiSignals(sourceRawJson);
  if (sourceDraft === undefined) throw new Error("expected explicit anchor draft");
  const binding = {
    sourceDraftIndex: 0,
    sourceDraftSha256: digest(JSON.stringify(sourceDraft)),
    currentAssertionId: 1
  };
  return createStrictCatalogAnchorReceipt({
    request, sourceCorpus, sourceRawJson, primaryRawJson: '{"signals":[]}'
  }, [binding]);
}
function userMessage(content: string) { return { role: "user" as const, content }; }
function assistantMessage(content: string) { return { role: "assistant" as const, content }; }
function readStrictCatalogReceipt(
  receipt: ReturnType<typeof createStrictCatalogAnchorReceipt>,
  fixture: ReturnType<typeof createStrictCatalogAnchorFixture>
) {
  return createSourceAssertionSupplementReader({
    receipt, primaryIdentity: primaryIdentity(), sourceManifestSha256: SOURCE_MANIFEST_SHA,
    readSourceRawJson: () => fixture.sourceRawJson
  }).readBatch({ request: fixture.request, primaryCacheKey: PRIMARY_CACHE_KEY,
    primaryRawJson: fixture.primaryRawJson, sourceCorpus: fixture.sourceCorpus });
}
function requestFixture(userContent: string) {
  const messages = [{ role: "user" as const, content: userContent }];
  const sourceCorpus = buildOfficialApiSourceCorpus("", messages);
  const [request, ...rest] = buildOfficialApiExtractionRequests("", messages);
  if (request === undefined || rest.length > 0) {
    throw new Error("expected one extraction request fixture");
  }
  return { request, sourceCorpus };
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
