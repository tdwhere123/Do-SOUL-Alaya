import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuration, fixture, type Fixture
} from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import {
  AXIS_ROOTS, admitScope, digest, expectBounded, publishIndex, query, queryInput
} from "./source-index-acquisition-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});
function setup() {
  const environment = fixture();
  environments.push(environment);
  return environment;
}

describe("supplied vector validation against real SQLite index states", () => {
  it("validates a supplied vector even when the selected native generation is valid empty", () => {
    const environment = setup();
    publishIndex(environment, []);
    const input = queryInput();
    if (input.vector.status !== "available") throw new Error("expected supplied query vector");
    const result = query(environment, input, admitScope);
    expectBounded(result, input);
    expect(result.vector).toMatchObject({ completion: "complete", reason: null, state: { status: "valid_empty" },
      validation: "validated", inspected_windows: 0, invalid_windows: 0, input: { status: "available",
        profile_id: input.vector.profile_id, input_digest: input.vector.input_digest } });
    expect(result.completion).toBe("complete");
    expect(result.nominations).toEqual([]);
    expect(result.accounting).toEqual({ attempted: 0, admitted: 0, duplicate: 0, rejected: 0, scope_denied: 0,
      native_unknown: 0, resource_refused: 0, stale: 0, nomination_limit: 0 });
    expect(result.resource_refusals).toEqual([]);
    expect(result.limitations).toContain("nominations_are_not_source_absence");
  });

  it("keeps genuinely unavailable preparation unavailable and not applicable without running vector reads", () => {
    const environment = setup();
    const { documents } = publishIndex(environment, [AXIS_ROOTS[0]!]);
    const scan = vi.spyOn(environment.index, "readVectorCandidates");
    const input = queryInput(configuration(), { vector: { status: "unavailable", reason: "query_unavailable" } });
    const result = query(environment, input, admitScope);
    expectBounded(result, input);
    expect(result.vector).toMatchObject({ completion: "unavailable", reason: "query_unavailable", state: null,
      validation: "not_applicable", inspected_windows: 0, invalid_windows: 0,
      input: { status: "unavailable", reason: "query_unavailable" } });
    expect(result.nominations.map(nomination => nomination.source)).toEqual([documents[0]!.source]);
    expect(result.nominations[0]!.vector).toBeNull();
    expect(result.completion).toBe("partial");
    expect(result.accounting).toEqual({ attempted: 1, admitted: 1, duplicate: 0, rejected: 0, scope_denied: 0,
      native_unknown: 0, resource_refused: 0, stale: 0, nomination_limit: 0 });
    expect(result.resource_refusals).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
  });
});

describe("explicit injected reader/transport outcomes, not native error-boundary evidence", () => {
  it.each(["lexical", "vector", "both", "none"] as const)(
    "reports unavailable lanes with %s retained nominations without discarding admitted results", retained => {
      const environment = setup();
      const { documents } = publishIndex(environment, [AXIS_ROOTS[0]!]);
      const lexical = environment.index.readLexicalCandidates.bind(environment.index);
      const vector = environment.index.readVectorCandidates.bind(environment.index);
      const keepLexical = retained === "lexical" || retained === "both";
      const keepVector = retained === "vector" || retained === "both";
      // Real rows/resources are retained selectively; only the reader's final error outcome is injected.
      vi.spyOn(environment.index, "readLexicalCandidates").mockImplementation((...args) => {
        const page = lexical(...args);
        return { ...page, candidates: keepLexical ? page.candidates : [], completion: "unavailable", reason: "native_query_failed" };
      });
      vi.spyOn(environment.index, "readVectorCandidates").mockImplementation((...args) => {
        const page = vector(...args);
        return { ...page, candidates: keepVector ? page.candidates : [], completion: "unavailable", reason: "native_query_failed" };
      });
      const input = queryInput();
      const result = query(environment, input, admitScope);
      expectBounded(result, input);
      expect(result.lexical).toMatchObject({ completion: "unavailable", reason: "native_query_failed" });
      expect(result.vector).toMatchObject({ completion: "unavailable", reason: "native_query_failed", validation: "validated",
        inspected_windows: 1, state: { status: "ready" } });
      expect(result.completion).toBe(retained === "none" ? "unavailable" : "partial");
      expect(result.accounting).toEqual({ attempted: Number(keepLexical) + Number(keepVector),
        admitted: retained === "none" ? 0 : 1, duplicate: retained === "both" ? 1 : 0, rejected: 0,
        scope_denied: 0, native_unknown: 0, resource_refused: 0, stale: 0, nomination_limit: 0 });
      expect(result.resource_refusals).toEqual([]);
      expect(result.nominations.map(nomination => nomination.source)).toEqual(retained === "none" ? [] : [documents[0]!.source]);
      if (retained === "none") return;
      expect(result.nominations[0]!.lexical).toEqual(keepLexical
        ? [{ rank: 1, lane: "unicode61", lane_rank: 1, bm25: expect.any(Number) }] : []);
      if (keepVector) {
        expect(result.nominations[0]!.vector?.rank).toBe(1);
        expect(result.nominations[0]!.vector?.cosine).toBeCloseTo(0.6, 12);
        expect(result.nominations[0]!.vector?.window).toEqual({ window_id: documents[0]!.windows[0]!.window_id,
          start_byte: 0, end_byte: 8, content_digest: digest("needle a") });
      } else expect(result.nominations[0]!.vector).toBeNull();
    });
});
