import { describe, expect, it } from "vitest";
import { buildSourceSemanticRequest, parseSourceSemanticRequest } from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { collectSourceSemanticUnitPacks } from "../../../garden/ingestion/official-api/source-semantic-units.js";
import { completeEmptySourceSemantics, receiveSourceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { prepareSourceSemanticRevision } from "../../../garden/ingestion/official-api/source-semantic-revision.js";
import { buildOfficialApiSourceCorpus } from "../../../garden/triage/grounding/source-locator.js";

const producer = { source_id: "source", source_version: "1", producer_id: "authored-control", producer_version: "1" };
const source = (count: number) => Array.from({ length: count }, (_, i) => `Item ${i} is recorded.`).join(" ");
const inputFor = (count: number) => ({ ...producer, sourceCorpus: source(count),
  assertionIds: Array.from({ length: count }, (_, i) => i + 1), sourceScope: "complete-source" as const });
const emptyDraft = JSON.stringify({ contract: "source-semantic-proposal-v3", outcome: { status: "interpreted" },
  content: { roots: [], gaps: [] } });

describe("bounded complete-source semantic requests", () => {
  it("packs all source units once while preserving historical eight-unit and singleton packing", () => {
    const corpus = source(25);
    const complete = collectSourceSemanticUnitPacks(corpus, "complete-source");
    expect(complete).toHaveLength(1);
    expect(complete[0]).toHaveProperty("source_scope", "complete-source");
    expect(complete[0]!.source_assertions.map(row => row.assertion_id)).toEqual(inputFor(25).assertionIds);
    expect(collectSourceSemanticUnitPacks(corpus).map(row => row.source_assertions.length)).toEqual([8, 8, 8, 1]);
    expect(collectSourceSemanticUnitPacks(corpus, "singleton")).toHaveLength(25);
    expect(collectSourceSemanticUnitPacks(source(65), "complete-source")).toHaveLength(1);
  });

  it("accepts the catalog's 64-unit boundary and rejects excess without truncation", () => {
    const input = inputFor(64), request = buildSourceSemanticRequest(input);
    expect(request.source_request.source_assertions).toHaveLength(64);
    expect(request.source_request.assertion_locations).toHaveLength(64);
    expect(request.source_catalog.assertions).toHaveLength(64);
    expect(() => buildSourceSemanticRequest(inputFor(65))).toThrow();
    expect(() => buildSourceSemanticRequest({ ...inputFor(1), sourceCorpus: "x".repeat(65537) })).toThrow(/bound/u);
  });

  it("rejects omitted, reordered and duplicated unit selections under complete scope", () => {
    const input = inputFor(9);
    for (const assertionIds of [input.assertionIds.slice(1), [...input.assertionIds].reverse(), [...input.assertionIds, 9]]) {
      expect(() => buildSourceSemanticRequest({ ...input, assertionIds })).toThrow(/every source unit in original order/u);
    }
    const selected = buildSourceSemanticRequest({ ...input, assertionIds: [9], sourceScope: undefined });
    const forged = parseSourceSemanticRequest({ ...selected,
      source_request: { ...selected.source_request, source_scope: "complete-source" } });
    expect(() => receiveSourceSemantics(emptyDraft, forged, input)).toThrow(/every source unit in original order/u);
  });

  it("keeps unmarked requests at eight and binds replay to their recorded scope", () => {
    const input = inputFor(9);
    expect(() => buildSourceSemanticRequest({ ...input, sourceScope: undefined })).toThrow(/eight/u);
    const historical = buildSourceSemanticRequest({ ...input, assertionIds: [9], sourceScope: undefined });
    const bytes = JSON.stringify(historical);
    const received = receiveSourceSemantics(emptyDraft, historical, input);
    expect(received.outcome.status).toBe("invalid");
    expect(JSON.stringify(received.request)).toBe(bytes);
    expect(received.request!.source_request.assertion_locations).toEqual(historical.source_request.assertion_locations);
    const current = buildSourceSemanticRequest(input);
    const { source_scope: _scope, ...unmarked } = current.source_request;
    expect(() => parseSourceSemanticRequest({ ...current, source_request: unmarked })).toThrow(/eight/u);
    expect(() => parseSourceSemanticRequest({ ...current, source_request: {
      ...current.source_request, source_unit_contract: undefined
    } })).toThrow(/source unit contract/u);
  });

  it("allows an authored co-reference control to anchor an antecedent and tail pronoun across the former pack boundary", () => {
    const input = { ...inputFor(9), sourceCorpus: buildOfficialApiSourceCorpus("", [
      { role: "user", content: `Mira acquired an atlas. ${source(7)}` },
      { role: "assistant", content: "She opened it." }
    ]) };
    const request = buildSourceSemanticRequest(input);
    expect(request.source_request.source_assertions.map(row => row.source_role)).toEqual([...Array<string>(8).fill("user"), "assistant"]);
    const anchor = (assertion_id: number, text: string) => {
      const id = request.source_catalog.assertions.find(row => row.assertion_id === assertion_id)!.segments.find(row => row.text === text)!.id;
      return { assertion_id, source_ref: { first: id, last: id } };
    };
    const raw = JSON.stringify({ contract: "source-semantic-proposal-v3", outcome: { status: "interpreted" }, content: {
      roots: [{ act: "assertion", expression: { kind: "statement", key: "open", predicate: {
        kind: "explicit", reading: "opened", evidence: [anchor(9, "opened")]
      }, arguments: [{ role: "theme", evidence: [anchor(9, "it")], target: {
        kind: "entity", key: "atlas", referent_kind: "grouped", mentions: [anchor(1, "atlas"), anchor(9, "it")]
      } }] } }], gaps: []
    } });
    const result = receiveSourceSemantics(raw, request, input);
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("interpreted");
    expect(result.interpretation!.mentions.map(row => row.text)).toEqual(expect.arrayContaining(["atlas", "it"]));
    expect(result.interpretation!.source.assertion_locations).toHaveLength(9);
    expect(result.interpretation!.gaps.length).toBeGreaterThan(0);
  });

  it("binds revisions to scope while allowing bounded review feedback for a subset of source units", () => {
    const input = inputFor(9), request = buildSourceSemanticRequest(input);
    const revision = prepareSourceSemanticRevision(request, emptyDraft, [{ assertion_ids: [9], comment: "Review the final source unit." }]);
    expect(buildSourceSemanticRequest({ ...input, revision }).source_request.source_scope).toBe("complete-source");
    expect(() => buildSourceSemanticRequest({ ...input, assertionIds: [9], sourceScope: undefined, revision })).toThrow(/different original source/u);
  });

  it("preserves explicit empty-source and resource-exhausted outcomes", () => {
    const input = inputFor(0), request = buildSourceSemanticRequest(input);
    expect(completeEmptySourceSemantics(request, input).outcome).toEqual({ status: "no_eligible_source", provider_attempts: 0 });
    const bounded = { ...inputFor(9), resource_limits: { work_units: 1, memory_bytes: 1 } };
    expect(receiveSourceSemantics(emptyDraft, buildSourceSemanticRequest(bounded), bounded).outcome).toEqual({ status: "resource_exhausted" });
  });
});
