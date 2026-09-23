import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_NORMALIZER_VERSION, type SourceSemanticInterpretation } from "@do-soul/alaya-protocol";
import { buildSourceSemanticRequest } from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { receiveSourceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";

function source(sourceCorpus: string, assertionIds: number[]) {
  const input = { sourceCorpus, assertionIds, source_id: "referent-ranges", source_version: "1",
    producer_id: "authored", producer_version: "1" };
  const request = buildSourceSemanticRequest(input);
  const segment = (text: string, assertion_id = 1) => ({ assertion_id, text });
  const range = (first: string, last: string, assertion_id = 1) => ({ assertion_id, text: `${first} ${last}` });
  const receive = (content: object) => {
    const rawJson = JSON.stringify({ contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" }, content });
    const result = receiveSourceSemantics(rawJson, request, input);
    expect(result.rawJson).toBe(rawJson);
    return result;
  };
  return { request, segment, range, receive };
}

function referentText(interpretation: SourceSemanticInterpretation, id: string) {
  const referent = interpretation.referents.find(row => row.id === id)!;
  return referent.mentions.map(mention => interpretation.mentions.find(row => row.id === mention)!.text);
}

describe("source referent ranges through native receive", () => {
  it("grounds a reporter range and preserves the reported event's scope", () => {
    const fixture = source("Amir Chen reported that Jo left.", [1]);
    const received = fixture.receive({ roots: [{ act: "assertion", expression: {
      kind: "reported", support: fixture.segment("reported"), reporter: fixture.range("Amir", "Chen"),
      content: { kind: "statement", predicate: { kind: "explicit", reading: "leave", support: fixture.segment("left") },
        arguments: [{ role: "actor", target: fixture.segment("Jo") }] }
    } }] });
    expect(received.outcome.status).toBe("interpreted");
    const interpretation = received.interpretation!;
    const report = interpretation.operators.find(row => row.operator === "reported")!;
    expect(report.operator).toBe("reported");
    if (report.operator !== "reported") throw new Error("expected report");
    expect(referentText(interpretation, report.reporter!)).toEqual(["Amir Chen"]);
    expect(interpretation.frames[0]!.context_owner).toEqual({ kind: "operator", operator_handle: report.id });
    expect(interpretation.asserted_at_scope).toEqual([report.id]);
    expect(interpretation.normalizer_version).toBe(SOURCE_SEMANTIC_NORMALIZER_VERSION);
    expect(fixture.request.source_request.normalizer_version).toBe(SOURCE_SEMANTIC_NORMALIZER_VERSION);
  });

  it("grounds member, exclusion and measurement subject ranges through the same referent owner", () => {
    const fixture = source("Amir Chen weighs twelve kilograms. Bo Yu is excluded from the weighed people.", [1, 2]);
    const amir = fixture.range("Amir", "Chen"), bo = fixture.range("Bo", "Yu", 2);
    const received = fixture.receive({ roots: [
      { act: "assertion", expression: { kind: "statement", key: "weighing",
        predicate: { kind: "explicit", reading: "weigh", support: fixture.segment("weighs") },
        arguments: [{ role: "subject", target: amir }] } },
      { act: "assertion", expression: { kind: "statement", key: "exclusion",
        predicate: { kind: "explicit", reading: "exclude", support: fixture.segment("excluded", 2) },
        arguments: [{ role: "subject", target: bo }] } }
    ], domains: [{ key: "people", context: null, support: fixture.range("weighed", "people", 2),
      members: [{ referent: amir, evidence: "weighing", restrictions: [] }],
      exclusions: [{ referent: bo, evidence: "exclusion" }], closure: { kind: "open" } }],
    measurements: [{ key: "mass", subject: amir, owner: "weighing", population: "people",
      metric: "mass", unit: "kilograms", context: "weighing", value: "12", support: fixture.segment("twelve") }] });
    expect(received.outcome.status).toBe("interpreted");
    const interpretation = received.interpretation!;
    const domain = interpretation.domains![0]!, measurement = interpretation.measurements![0]!;
    expect(referentText(interpretation, domain.members[0]!.referent)).toEqual(["Amir Chen"]);
    expect(referentText(interpretation, domain.exclusions[0]!.referent)).toEqual(["Bo Yu"]);
    expect(referentText(interpretation, measurement.subject)).toEqual(["Amir Chen"]);
    expect(measurement.subject).toBe(domain.members[0]!.referent);
    expect(measurement).toMatchObject({ value: "12", unit: "kilograms" });
    expect(domain.closure).toEqual({ kind: "open" });
  });

  it.each([
    { assertion_id: 1, text: "Chen Amir" },
    { assertion_id: 2, text: "Amir" },
    { assertion_id: 1, text: "Am" }
  ])("rejects an invalid reporter range without repairing retained raw: %j", reporter => {
    const fixture = source("Amir Chen reported that Jo left.", [1]);
    const received = fixture.receive({ roots: [{ act: "assertion", expression: {
      kind: "reported", support: fixture.segment("reported"), reporter,
      content: { kind: "statement", predicate: { kind: "explicit", reading: "leave", support: fixture.segment("left") }, arguments: [] }
    } }] });
    expect(received.outcome.status).toBe("invalid");
    expect(received.interpretation).toBeUndefined();
  });
});
