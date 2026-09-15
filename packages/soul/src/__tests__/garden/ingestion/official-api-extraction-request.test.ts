import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
  OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION,
  OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
  buildOfficialApiExtractionRequest,
  buildOfficialApiExtractionRequests,
  collectOfficialApiExtractionCoverage,
  parseOfficialApiExtractionRequest,
  planOfficialApiExtractionWindow,
  officialApiExtractionRequestTemplatePreimage,
  stringifyOfficialApiExtractionRequest,
  mintOfficialApiAssertionBindings
} from "../../../garden/ingestion/official-api/extraction-request.js";
import { planTurnTransportPacks } from "../../../garden/ingestion/official-api/transport-pack.js";
import {
  OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
  SOURCE_ASSERTION_CATALOG_PAGE_SIZE,
  SOURCE_ASSERTION_CATALOG_PRODUCER,
  pageSourceAssertionCatalog
} from "../../../garden/triage/grounding/source-locator/assertion-catalog.js";
import { buildOfficialApiSourceCorpus } from "../../../garden/triage/grounding/source-locator.js";

describe("official API extraction request", () => {
  it("keeps default request bytes and semantic template stable while singleton retains the full catalog", () => {
    const source = Array.from({ length: 18 }, (_, i) => `I recorded durable detail number ${i + 1}.`).join(" ");
    const defaultRequests = buildOfficialApiExtractionRequests(source, []);
    const explicit = buildOfficialApiExtractionRequests(source, [], "reference-eight");
    expect(explicit.map(stringifyOfficialApiExtractionRequest))
      .toEqual(defaultRequests.map(stringifyOfficialApiExtractionRequest));
    expect(defaultRequests.map((request) => request.source_assertions.length)).toEqual([8, 8, 2]);
    const before = officialApiExtractionRequestTemplatePreimage();
    const singleton = buildOfficialApiExtractionRequests(source, [], "singleton");
    expect(singleton).toHaveLength(18);
    expect(singleton.flatMap((request) => request.source_assertions))
      .toEqual(defaultRequests.flatMap((request) => request.source_assertions));
    expect(singleton.map((request) => [request.batch_index, request.batch_count]))
      .toEqual(Array.from({ length: 18 }, (_, i) => [i, 18]));
    expect(singleton.every((request) => request.source_corpus_identity === defaultRequests[0]!.source_corpus_identity)).toBe(true);
    expect(officialApiExtractionRequestTemplatePreimage()).toBe(before);
  });

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
      source_locator_contract_version: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
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
      source_locator_contract_version: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
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

  it("uses minted keys for open-reference pack members", () => {
    const turn = "My sister visited yesterday. She moved to Berlin.";
    const messages = [{ role: "user" as const, content: turn }];
    const bindings = mintOfficialApiAssertionBindings(turn, messages);
    const requests = buildOfficialApiExtractionRequests(turn, messages);
    expect(bindings.length).toBeGreaterThan(0);
    expect(stringifyOfficialApiExtractionRequest(requests[0]!)).not.toContain(bindings[0]!.semanticKey);
    const again = mintOfficialApiAssertionBindings(turn, messages);
    expect(again.map((item) => item.semanticKey)).toEqual(bindings.map((item) => item.semanticKey));
    const packed = planTurnTransportPacks(
      bindings.map((binding) => ({
        semanticKey: binding.semanticKey,
        assertionId: binding.locator.assertion_id,
        text: requests[0]!.source_assertions.find((assertion) =>
          assertion.assertion_id === binding.locator.assertion_id)!.text
      })),
      { kind: "reference_batch_8" }
    );
    expect(packed.packs[0]?.semantic_keys).toEqual(bindings.map((item) => item.semanticKey));
  });

  it.each([64, 65, 128, 129] as const)(
    "pages %s eligible assertions without silent sampling or a changed denominator",
    (count) => {
      const source = catalogSource(count);
      const corpus = buildOfficialApiSourceCorpus(source, []);
      const first = planOfficialApiExtractionWindow(source, []);
      expect(first.catalog.contract_version).toBe(OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION);
      expect(first.catalog.producer).toBe(SOURCE_ASSERTION_CATALOG_PRODUCER);
      expect(first.catalog.inventory_count).toBe(count);
      expect(first.catalog.window.map((assertion) => assertion.assertion_id))
        .toEqual(Array.from({ length: Math.min(count, SOURCE_ASSERTION_CATALOG_PAGE_SIZE) }, (_, i) => i + 1));
      expect(first.catalog.coverage).toBe(
        count <= SOURCE_ASSERTION_CATALOG_PAGE_SIZE ? "source_range_complete" : "budget_complete"
      );
      expect(first.catalog.residual).toHaveLength(Math.max(0, count - SOURCE_ASSERTION_CATALOG_PAGE_SIZE));
      expect(first.requests.flatMap((request) => request.source_assertions.map(({ assertion_id }) => assertion_id)))
        .toEqual(first.catalog.window.map((assertion) => assertion.assertion_id));

      const reached: number[] = [];
      let cursor = first.catalog.next_cursor;
      reached.push(...first.catalog.window.map((assertion) => assertion.assertion_id));
      while (cursor !== null) {
        const next = pageSourceAssertionCatalog(corpus, cursor);
        expect(next.inventory_count).toBe(count);
        expect(next.window.map((assertion) => assertion.assertion_id))
          .toEqual(next.window.map((assertion) => assertion.assertion_id).sort((left, right) => left - right));
        reached.push(...next.window.map((assertion) => assertion.assertion_id));
        cursor = next.next_cursor;
        if (cursor === null) expect(next.coverage).toBe("source_range_complete");
      }
      expect(reached).toEqual(Array.from({ length: count }, (_, i) => i + 1));
      expect(new Set(reached).size).toBe(count);

      const coverage = collectOfficialApiExtractionCoverage(source, []);
      expect(coverage.catalog.coverage).toBe("source_range_complete");
      expect(coverage.catalog.residual).toHaveLength(0);
      expect(coverage.catalog.inventory_count).toBe(count);
      expect(coverage.catalog.window.map((assertion) => assertion.assertion_id))
        .toEqual(Array.from({ length: count }, (_, i) => i + 1));
      expect(coverage.requests.flatMap((request) => request.source_assertions.map(({ assertion_id }) => assertion_id)))
        .toEqual(Array.from({ length: count }, (_, i) => i + 1));
    }
  );

  it("keeps a mid-cancel residual and isolates reordered windows from the canonical cache bytes", () => {
    const source = catalogSource(65);
    const first = planOfficialApiExtractionWindow(source, []);
    expect(first.catalog.coverage).toBe("budget_complete");
    expect(first.catalog.residual).toEqual([
      expect.objectContaining({ assertion_id: 65 })
    ]);
    const cancelled = first.catalog.residual;
    expect(cancelled).toHaveLength(1);
    const continued = planOfficialApiExtractionWindow(source, [], "reference-eight", first.catalog.next_cursor);
    expect(continued.catalog.window.map((assertion) => assertion.assertion_id)).toEqual([65]);
    expect(continued.catalog.coverage).toBe("source_range_complete");
    expect(stringifyOfficialApiExtractionRequest(first.requests[0]!))
      .not.toBe(stringifyOfficialApiExtractionRequest(continued.requests[0]!));
    const reordered = {
      ...first.requests[0]!,
      source_assertions: [...first.requests[0]!.source_assertions].reverse()
    };
    expect(stringifyOfficialApiExtractionRequest(first.requests[0]!))
      .not.toBe(JSON.stringify(reordered));
  });
});

function catalogSource(count: number): string {
  return Array.from({ length: count }, (_, i) => `I recorded durable detail number ${i + 1}.`).join(" ");
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
