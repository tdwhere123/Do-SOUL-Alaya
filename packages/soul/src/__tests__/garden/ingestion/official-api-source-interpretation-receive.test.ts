import { describe, expect, it } from "vitest";
import {
  SOURCE_INTERPRETATION_CONTRACT
} from "@do-soul/alaya-protocol";
import { buildOfficialApiExtractionRequest } from "../../../garden/ingestion/official-api/extraction-request.js";
import { buildOfficialApiSourceCorpus } from "../../../garden/triage/grounding/source-locator.js";
import {
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
    expect(received.status).toBe("complete");
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
});
