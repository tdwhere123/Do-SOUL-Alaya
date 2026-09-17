import { describe, expect, it } from "vitest";
import {
  SOURCE_INTERPRETATION_CONTRACT
} from "@do-soul/alaya-protocol";
import { buildOfficialApiExtractionRequest } from "../../../garden/ingestion/official-api/extraction-request.js";
import { buildOfficialApiSourceCorpus } from "../../../garden/triage/grounding/source-locator.js";
import {
  OfficialApiInterpretationAdmissionError,
  classifyOfficialApiInterpretationResult,
  receiveOfficialApiSourceInterpretations
} from "../../../garden/ingestion/official-api/source-interpretation-receive.js";

const SOURCE = "Alice uses tools.";
const request = buildOfficialApiExtractionRequest(SOURCE, []);
const corpus = buildOfficialApiSourceCorpus(SOURCE, []);

function interpretationRaw(relations: unknown[], assertionId = 1): string {
  return JSON.stringify({
    interpretations: [{ assertion_id: assertionId, relations }]
  });
}

const usesRelation = {
  predicate: { text: "uses" },
  arguments: [
    { role: "agent", phrase: { text: "Alice" } },
    { role: "object", phrase: { text: "tools" } }
  ],
  qualifiers: []
};

describe("official API source interpretation receive", () => {
  it("locates independently admissible relations without kind or confidence", () => {
    const received = receiveOfficialApiSourceInterpretations(
      interpretationRaw([usesRelation, { predicate: { text: "invented" }, arguments: [], qualifiers: [] }]),
      request,
      { sourceCorpus: corpus, artifactKey: "artifact-1" }
    );
    expect(received.status).toBe("partial");
    expect(received.rejections).toEqual([{ index: 0, assertion_id: 1,
      reason: "candidate_rejected", candidate_index: 1, diagnostic_reason: "absent" }]);
    expect(() => classifyOfficialApiInterpretationResult(
      interpretationRaw([usesRelation, { predicate: { text: "invented" }, arguments: [], qualifiers: [] }]),
      request, corpus
    )).toThrow(/rejected interpretation entries/);
    expect(received.located).toHaveLength(1);
    expect(received.located[0]).toMatchObject({
      contract: SOURCE_INTERPRETATION_CONTRACT,
      outcome: "candidates"
    });
    expect(received.located[0]!.candidates).toHaveLength(1);
    expect(received.located[0]!.diagnostics).toEqual([
      { candidate_index: 1, reason: "absent" }
    ]);
    expect(received.located[0]!.candidates[0]).not.toHaveProperty("confidence");
    expect(received.located[0]!.candidates[0]!.scope_status).toBe("unsupported");
  });

  it("keeps valid empty distinct from malformed and transport failure", () => {
    const empty = classifyOfficialApiInterpretationResult('{"interpretations":[]}', request, corpus);
    expect(empty.status).toBe("completed_empty");
    expect(empty.located[0]?.outcome).toBe("empty");

    const receivedMalformed = receiveOfficialApiSourceInterpretations(
      '{"signals":[]}',
      request,
      { sourceCorpus: corpus, artifactKey: "artifact-1" }
    );
    expect(receivedMalformed.status).toBe("partial");
    expect(receivedMalformed.located[0]?.outcome).toBe("failed");
    expect(receivedMalformed.rejections[0]?.reason).toBe("malformed_response");

    const missing = receiveOfficialApiSourceInterpretations(
      "{}",
      request,
      { sourceCorpus: corpus, artifactKey: "artifact-1", responseKind: "missing_response" }
    );
    expect(missing.rejections[0]?.reason).toBe("missing_response");
    expect(missing.located[0]?.diagnostics).toEqual([
      { candidate_index: null, reason: "missing_response" }
    ]);
  });

  it("does not leak candidates across source or assertion mismatches", () => {
    const mismatch = receiveOfficialApiSourceInterpretations(
      interpretationRaw([usesRelation]),
      request,
      { sourceCorpus: "User: Bob uses apps.", artifactKey: "artifact-1" }
    );
    expect(mismatch.status).toBe("partial");
    expect(mismatch.located).toEqual([]);
    expect(mismatch.rejections.every((item) => item.reason === "source_generation_mismatch")).toBe(true);

    expect(() => classifyOfficialApiInterpretationResult(
      interpretationRaw([usesRelation], 9),
      request,
      corpus
    )).toThrow(/rejected interpretation entries/);

    expect(() => classifyOfficialApiInterpretationResult(
      JSON.stringify({
        interpretations: [
          { assertion_id: 1, relations: [usesRelation] },
          { assertion_id: 9, relations: [usesRelation] }
        ]
      }),
      request,
      corpus
    )).toThrow(/rejected interpretation entries/);

    expect(() => classifyOfficialApiInterpretationResult(
      interpretationRaw([usesRelation]),
      request
    )).toThrow(/requires the source corpus/);
  });

  it("preserves locator reasons and original candidate ordinals through classification", () => {
    const source = "Alice uses tools and Alice uses apps.";
    const packed = buildOfficialApiExtractionRequest(source, []);
    const packedCorpus = buildOfficialApiSourceCorpus(source, []);
    const unique = receiveOfficialApiSourceInterpretations(
      interpretationRaw([{ predicate: { text: "uses", occurrence: 1 }, arguments: [], qualifiers: [] }]),
      packed, { sourceCorpus: packedCorpus, artifactKey: "locator" }
    );
    expect(unique.status).toBe("complete");
    expect(unique.located[0]?.outcome).toBe("candidates");

    const ambiguousRaw = interpretationRaw([
      { predicate: { text: "uses" }, arguments: [], qualifiers: [] }
    ]);
    const ambiguous = receiveOfficialApiSourceInterpretations(
      ambiguousRaw, packed, { sourceCorpus: packedCorpus, artifactKey: "locator" }
    );
    expect(ambiguous.rejections).toEqual([{ index: 0, assertion_id: 1,
      reason: "candidate_rejected", candidate_index: 0, diagnostic_reason: "ambiguous" }]);
    try {
      classifyOfficialApiInterpretationResult(ambiguousRaw, packed, packedCorpus);
      throw new Error("expected classification refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(OfficialApiInterpretationAdmissionError);
      const refusal = error as OfficialApiInterpretationAdmissionError;
      expect(refusal.receive.rejections[0]).toMatchObject({
        assertion_id: 1, candidate_index: 0, diagnostic_reason: "ambiguous"
      });
    }

    const absent = receiveOfficialApiSourceInterpretations(
      interpretationRaw([{ predicate: { text: "missing" }, arguments: [], qualifiers: [] }]),
      packed, { sourceCorpus: packedCorpus, artifactKey: "locator" }
    );
    expect(absent.rejections[0]?.diagnostic_reason).toBe("absent");

    const outOfRange = receiveOfficialApiSourceInterpretations(
      interpretationRaw([{ predicate: { text: "uses", occurrence: 2 }, arguments: [], qualifiers: [] }]),
      packed, { sourceCorpus: packedCorpus, artifactKey: "locator" }
    );
    expect(outOfRange.rejections[0]?.diagnostic_reason).toBe("out_of_range");
  });

  it("keeps a request incomplete when one sibling candidate is rejected", () => {
    const raw = interpretationRaw([
      usesRelation,
      { predicate: { text: "invented" }, arguments: [], qualifiers: [] }
    ]);
    const received = receiveOfficialApiSourceInterpretations(
      raw, request, { sourceCorpus: corpus, artifactKey: "sibling" }
    );
    expect(received.status).toBe("partial");
    expect(received.located[0]?.outcome).toBe("candidates");
    expect(received.located[0]?.candidates).toHaveLength(1);
    expect(received.rejections).toEqual([{ index: 0, assertion_id: 1,
      reason: "candidate_rejected", candidate_index: 1, diagnostic_reason: "absent" }]);
    expect(() => classifyOfficialApiInterpretationResult(raw, request, corpus))
      .toThrow(OfficialApiInterpretationAdmissionError);
  });
});
