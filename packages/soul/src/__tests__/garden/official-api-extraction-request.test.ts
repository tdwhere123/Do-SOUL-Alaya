import { describe, expect, it } from "vitest";
import {
  OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
  OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION,
  OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
  buildOfficialApiExtractionRequest,
  buildOfficialApiExtractionRequests,
  parseOfficialApiExtractionRequest,
  stringifyOfficialApiExtractionRequest
} from "../../garden/official-api/extraction-request.js";

describe("official API extraction request", () => {
  it("carries only canonical User assertions", () => {
    const request = buildOfficialApiExtractionRequest(
      "I moved to Berlin.",
      [
        { message_id: "user-1", role: "user", content: "I moved to Berlin." },
        { message_id: "assistant-1", role: "assistant", content: "That sounds exciting." }
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
});
