import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
  OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION,
  OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
  buildOfficialApiExtractionRequest,
  buildOfficialApiExtractionRequests,
  parseOfficialApiExtractionRequest,
  officialApiExtractionRequestTemplatePreimage,
  stringifyOfficialApiExtractionRequest,
  mintOfficialApiAssertionBindings
} from "../../../garden/ingestion/official-api/extraction-request.js";

describe("official API extraction request", () => {
  it("carries only canonical User assertions", () => {
    const request = buildOfficialApiExtractionRequest(
      "I moved to Berlin.",
      [
        { role: "user", content: "I moved to Berlin." },
        { role: "assistant", content: "That sounds exciting." }
      ]
    );

    expect(request).toEqual({
      schema_version: OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
      source_locator_contract_version: 2,
      batch_contract_version: OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION,
      source_corpus_identity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      batch_index: 0,
      batch_count: 1,
      source_assertions: [{ assertion_id: 1, text: "User: I moved to Berlin." }]
    });
    expect(stringifyOfficialApiExtractionRequest(request)).not.toContain("Assistant");
  });

  it("has one strict parser and rejects retired request fields", () => {
    expect(() => parseOfficialApiExtractionRequest({
      schema_version: OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
      source_locator_contract_version: 2,
      source_assertions: [],
      turn_content: "retired"
    })).toThrow(/invalid official API extraction request/u);
  });

  it("partitions a large catalog without dropping or renumbering assertions", () => {
    const source = Array.from(
      { length: OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH * 2 + 1 },
      (_, index) => `I recorded durable detail number ${index + 1}.`
    ).join(" ");

    const requests = buildOfficialApiExtractionRequests(source, []);

    expect(requests.map((request) => request.source_assertions.length)).toEqual([
      OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
      OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
      1
    ]);
    expect(requests.flatMap((request) => request.source_assertions.map(
      ({ assertion_id }) => assertion_id
    ))).toEqual(Array.from({ length: 17 }, (_, index) => index + 1));
    expect(requests.every((request) =>
      request.batch_contract_version === OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION
    )).toBe(true);
    expect(requests.map(({ batch_index, batch_count }) => [batch_index, batch_count])).toEqual([
      [0, 3], [1, 3], [2, 3]
    ]);
    expect(new Set(requests.map(({ source_corpus_identity }) =>
      source_corpus_identity
    ))).toHaveLength(1);
  });

  it("binds the assertion wire shape and batching parameters in the template preimage", () => {
    const preimage = JSON.parse(officialApiExtractionRequestTemplatePreimage()) as {
      serialized_request: string;
      assertions_per_batch: number;
      batch_contract_version: number;
    };
    const request = JSON.parse(preimage.serialized_request) as Record<string, unknown>;

    expect(request.source_assertions).toEqual([{
      assertion_id: 1,
      text: "User: I recorded the source-bound semantic factor request template."
    }]);
    expect(preimage.assertions_per_batch).toBe(OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH);
    expect(preimage.batch_contract_version)
      .toBe(OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION);
    expect(hash(preimage)).not.toBe(hash({
      ...preimage,
      assertions_per_batch: preimage.assertions_per_batch + 1
    }));
    expect(hash(preimage)).not.toBe(hash({
      ...preimage,
      serialized_request: preimage.serialized_request.replace("assertion_id", "id")
    }));
  });

  it("mints semantic keys outside the request JSON", () => {
    const messages = [{ role: "user" as const, content: "I moved to Berlin." }];
    const request = buildOfficialApiExtractionRequest("I moved to Berlin.", messages);
    const bindings = mintOfficialApiAssertionBindings("I moved to Berlin.", messages);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.semanticKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(stringifyOfficialApiExtractionRequest(request)).not.toContain(bindings[0]!.semanticKey);
  });
});

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
