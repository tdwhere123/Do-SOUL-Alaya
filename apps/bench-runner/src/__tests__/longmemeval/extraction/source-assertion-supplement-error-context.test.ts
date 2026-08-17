import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION,
  buildOfficialApiExtractionRequests,
  buildOfficialApiSourceCorpus
} from "@do-soul/alaya-soul";
import {
  createSourceAssertionSupplementReceipt,
  createSourceAssertionSupplementReader
} from "../../../bench/extraction/cache/semantic-supplement/source-assertion-supplement.js";
import { computeSourceAssertionSupplementReceiptEntrySetSha256 } from
  "../../../bench/extraction/cache/semantic-supplement/source-assertion-supplement-closure.js";

const PRIMARY_CACHE_KEY = "abcdeffedcba".padEnd(64, "5");
const SOURCE_CACHE_KEY = "012345abcdef".padEnd(64, "6");
const SOURCE_MANIFEST_SHA = "2".repeat(64);

describe("source assertion supplement failure context", () => {
  it("identifies a draft-identity failure without exposing cached source material", () => {
    const fixture = createFixture();
    const reader = createSourceAssertionSupplementReader({
      receipt: forgeDraftIdentity(fixture.receipt),
      primaryIdentity: primaryIdentity(),
      sourceManifestSha256: SOURCE_MANIFEST_SHA,
      readSourceRawJson: () => fixture.sourceRawJson
    });

    let thrown: unknown;
    try {
      reader.readBatch({
        request: fixture.request,
        primaryCacheKey: PRIMARY_CACHE_KEY,
        primaryRawJson: fixture.primaryRawJson,
        sourceCorpus: fixture.sourceCorpus
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { readonly cause?: unknown };
    expect({
      hasPrimaryKeyPrefix: error.message.includes(PRIMARY_CACHE_KEY.slice(0, 12)),
      hasSourceKeyPrefix: error.message.includes(SOURCE_CACHE_KEY.slice(0, 12)),
      hasOriginalClassification: error.message.includes("source draft identity drifted"),
      leaksRawJson: error.message.includes(fixture.sourceRawJson),
      leaksRequest: error.message.includes(JSON.stringify(fixture.request)),
      leaksSourceCorpus: error.message.includes(fixture.sourceCorpus),
      leaksRawMarker: error.message.includes("raw-json-secret"),
      leaksCorpusMarker: error.message.includes("source-corpus-secret"),
      causeMessage: error.cause instanceof Error ? error.cause.message : undefined
    }).toEqual({
      hasPrimaryKeyPrefix: true,
      hasSourceKeyPrefix: true,
      hasOriginalClassification: true,
      leaksRawJson: false,
      leaksRequest: false,
      leaksSourceCorpus: false,
      leaksRawMarker: false,
      leaksCorpusMarker: false,
      causeMessage: "source assertion supplement source draft identity drifted"
    });
  });
});

function createFixture() {
  const messages = [{
    role: "user" as const,
    content: "I moved to Berlin. My private marker is source-corpus-secret."
  }];
  const sourceCorpus = buildOfficialApiSourceCorpus("", messages);
  const [request, ...rest] = buildOfficialApiExtractionRequests("", messages);
  if (request === undefined || rest.length > 0) throw new Error("expected one request");
  const primaryRawJson = JSON.stringify({ signals: [signal(1, "I moved to Berlin.")] });
  const sourceRawJson = JSON.stringify({
    signals: [signal(2, "My private marker is source-corpus-secret.")],
    private_raw_marker: "raw-json-secret"
  });
  const receipt = createSourceAssertionSupplementReceipt({
    createdAt: "2026-08-11T00:00:00.000Z",
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

function forgeDraftIdentity(receipt: ReturnType<typeof createFixture>["receipt"]) {
  const entry = receipt.entries[0]!;
  const binding = entry.source_draft_bindings[0]!;
  const entries = [{
    ...entry,
    source_draft_bindings: [{ ...binding, source_draft_sha256: "0".repeat(64) }]
  }];
  const unsigned = {
    ...receipt,
    entry_set_sha256: computeSourceAssertionSupplementReceiptEntrySetSha256(entries),
    entries,
    receipt_sha256: undefined
  };
  const { receipt_sha256: _removed, ...resigned } = unsigned;
  return { ...resigned, receipt_sha256: digest(JSON.stringify(resigned)) };
}

function primaryIdentity() {
  return {
    manifestSha256: "1".repeat(64),
    model: "DeepSeek-V4-Flash",
    modelFamily: "deepseek-v4-flash-nonthinking",
    requestProfile: "deepseek-v4-nonthinking-v1" as const,
    systemPromptSha256: "3".repeat(64),
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
    systemPromptSha256: "4".repeat(64)
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

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
