import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { locateSourceInterpretation, type LocateSourceInterpretationInput } from "../../garden/locate-source-interpretation.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
function input(text = "Alice uses tools."): LocateSourceInterpretationInput {
  return { source: `User: ${text}`, artifactKey: "artifact-1", sha256,
    assertion: { assertion_id: 1, text, source_span: [6, 6 + text.length] },
    response: { kind: "received", value: { interpretations: [{ assertion_id: 1,
      relations: [{ predicate: { text: "uses" }, arguments: [
        { role: "agent", phrase: { text: "Alice" } },
        { role: "object", phrase: { text: "tools" } }
      ], qualifiers: [] }] }] } } };
}
function response(relations: unknown[]): LocateSourceInterpretationInput["response"] {
  return { kind: "received", value: { interpretations: [{ assertion_id: 1, relations }] } };
}
const relation = (text: string, occurrence?: number): unknown => ({
  predicate: { text, ...(occurrence === undefined ? {} : { occurrence }) }, arguments: [], qualifiers: []
});

describe("source interpretation location", () => {
  it("retains complete context and role proposals without certifying scope", () => {
    const result = locateSourceInterpretation(input());
    expect(result.assertion_binding.text).toBe("Alice uses tools.");
    expect(result.candidates[0]).toMatchObject({ predicate: { text: "uses", source_span: [12, 16] },
      arguments: [{ role: "agent", phrase: { source_span: [6, 11], lookup_key: "alice" } },
        { role: "object", phrase: { source_span: [17, 22] } }], scope_status: "unsupported" });
    expect(result).not.toHaveProperty("source_target");
  });

  it("rejects an ambiguous relation while preserving another candidate and its ordinal identity", () => {
    const base = input("Alice uses tools and Alice uses apps.");
    const result = locateSourceInterpretation({ ...base, response: response([
      relation("uses"), relation("uses", 1), relation("missing"), relation("uses", 2)
    ]) });
    expect(result.outcome).toBe("candidates");
    expect(result.diagnostics).toEqual([
      { candidate_index: 0, reason: "ambiguous" }, { candidate_index: 2, reason: "absent" },
      { candidate_index: 3, reason: "out_of_range" }
    ]);
    expect(result.candidates[0]!.predicate.source_span).toEqual([33, 37]);
    expect(result.candidates[0]!.candidate_id).toBe(sha256(JSON.stringify([
      "source-interpretation-v1", "artifact-1", result.assertion_binding.context_id, 1
    ])));
  });

  it("uses catalog UTF-16 coordinates for astral characters and preserves opaque adjuncts", () => {
    const base = input("😀 Alice uses tools if ready.");
    const result = locateSourceInterpretation({ ...base, response: response([{
      predicate: { text: "uses" }, arguments: [],
      qualifiers: [{ role: "condition", phrase: { text: "if ready" } }]
    }]) });
    expect(result.candidates[0]!.predicate.source_span).toEqual([15, 19]);
    expect(result.candidates[0]!.qualifiers[0]!.phrase.source_span).toEqual([26, 34]);
    expect(result.assertion_binding.text).toBe(base.assertion.text);
  });

  it("distinguishes valid empty from missing, malformed and unreceived responses", () => {
    expect(locateSourceInterpretation({ ...input(), response: response([]) }).outcome).toBe("empty");
    for (const interpretations of [[], [{ assertion_id: 2, relations: [] }]]) {
      expect(locateSourceInterpretation({ ...input(), response: {
        kind: "received", value: { interpretations }
      } })).toMatchObject({ outcome: "empty", candidates: [], diagnostics: [] });
    }
    for (const [value, reason] of [
      [{ kind: "unavailable", reason: "missing_response" }, "missing_response"],
      [{ kind: "received", value: {} }, "malformed_response"],
      [{ kind: "unavailable", reason: "transport_unknown" }, "transport_unknown"]
    ] as const) {
      expect(locateSourceInterpretation({ ...input(), response: value })).toMatchObject({
        outcome: "failed", candidates: [], diagnostics: [{ candidate_index: null, reason }]
      });
    }
    expect(locateSourceInterpretation({ ...input(), response: response([relation("invented")]) }).outcome).toBe("failed");
  });

  it("isolates malformed and empty-normalized proposals while retaining original candidate ordinals", () => {
    const base = input("Alice\tuses tools.");
    const result = locateSourceInterpretation({ ...base, response: response([
      null, relation("\t"), relation("uses"), { ...relation("uses") as object, confidence: 1 }
    ]) });
    expect(result.outcome).toBe("candidates");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.predicate.text).toBe("uses");
    expect(result.candidates[0]!.candidate_id).toBe(sha256(JSON.stringify([
      "source-interpretation-v1", "artifact-1", result.assertion_binding.context_id, 2
    ])));
    expect(result.diagnostics).toEqual([0, 1, 3].map((candidate_index) => ({ candidate_index, reason: "invalid_candidate" })));
  });

  it("enforces envelope bounds before admitting candidate rows", () => {
    expect(locateSourceInterpretation({ ...input(), response: response(Array.from({ length: 33 }, () => relation("uses"))) }))
      .toMatchObject({ outcome: "failed", candidates: [], diagnostics: [{ reason: "malformed_response" }] });
  });

  it("rejects invalid trusted spans instead of turning binding failure into valid empty", () => {
    expect(() => locateSourceInterpretation({ ...input(), assertion: {
      assertion_id: 1, text: "Alice uses tools.", source_span: [0, 17]
    } })).toThrow("Trusted assertion binding");
  });

  it("has stable replay identities separated by corpus, artifact and assertion occurrence", () => {
    const original = locateSourceInterpretation(input());
    expect(locateSourceInterpretation(input())).toEqual(original);
    expect(locateSourceInterpretation({ ...input(), artifactKey: "artifact-2" }).assertion_binding.context_id)
      .not.toBe(original.assertion_binding.context_id);
    expect(locateSourceInterpretation({ ...input(), source: input().source + " More." }).assertion_binding.context_id)
      .not.toBe(original.assertion_binding.context_id);
    const doubled = "Alice uses tools. Alice uses tools.";
    const second = locateSourceInterpretation({ ...input(), source: doubled,
      assertion: { assertion_id: 1, text: "Alice uses tools.", source_span: [18, 35] } });
    expect(second.candidates[0]!.predicate.source_span).toEqual([24, 28]);
    expect(second.assertion_binding.context_id).not.toBe(original.assertion_binding.context_id);
  });
});
