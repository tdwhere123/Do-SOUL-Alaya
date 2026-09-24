import { describe, expect, it } from "vitest";
import { sourceSemanticEvidenceClosure, SourceSemanticResourceLedger,
  type SourceSemanticInterpretation } from "@do-soul/alaya-protocol";
import { buildSourceSemanticRequest } from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { receiveSourceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";

const select = (text: string, assertion_id = 1) => ({ assertion_id, text });
const statement = (reading: string, text: string, assertion_id: number, arguments_: object[], key?: string) => ({
  kind: "statement", ...(key === undefined ? {} : { key }),
  predicate: { kind: "explicit", reading, support: select(text, assertion_id) }, arguments: arguments_
});
const root = (expression: object) => ({ act: "assertion", expression });

function interpret(texts: string[], roots: object[], gaps: object[] = []): SourceSemanticInterpretation {
  const input = { sourceCorpus: `User: ${texts.join(" ")}`, assertionIds: texts.map((_, index) => index + 1),
    sourceScope: "complete-source" as const, source_id: "authored-source", source_version: "1",
    producer_id: "authored-control", producer_version: "1" };
  const request = buildSourceSemanticRequest(input);
  expect(request.source_request.source_assertions.map((row) => row.text)).toEqual(texts.map((text, index) =>
    index === 0 ? `User: ${text}` : text));
  const received = receiveSourceSemantics(JSON.stringify({ contract: "source-semantic-proposal-v7",
    outcome: { status: "interpreted" }, content: { roots, ...(gaps.length === 0 ? {} : { gaps }) } }), request, input);
  expect(received.outcome, JSON.stringify(received.outcome)).toMatchObject({ status: "interpreted" });
  return received.interpretation!;
}

function closureTexts(interpretation: SourceSemanticInterpretation, occurrence: string): string[] {
  const closure = sourceSemanticEvidenceClosure(interpretation, [occurrence],
    new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 }));
  return interpretation.mentions.filter((row) => closure.has(row.id)).map((row) => row.text);
}

describe("source meaning controls through receive and evidence closure", () => {
  it("keeps denial inside a quoted report distinct from denial of the report", () => {
    const speaker = { kind: "entity", key: "lena", mentions: [select("Lena")] };
    const quotedSelf = { kind: "entity", key: "lena", mentions: [select("I")] };
    const release = (verb: string) => statement("release", verb, 1, [
      { role: "actor", target: quotedSelf }, { role: "item", target: select("the amber crate") }
    ]);
    const said = interpret(["Lena said, 'I did not release the amber crate'."], [root(statement("say", "said", 1, [
      { role: "speaker", target: speaker },
      { role: "quoted content", support: select("did not release"), target: {
        kind: "not", support: select("not"), content: release("release")
      } }
    ]))]);
    const didNotSay = interpret(["Lena did not say, 'I released the amber crate'."], [root({
      kind: "not", support: select("did not"), content: statement("say", "say", 1, [
        { role: "speaker", target: speaker },
        { role: "quoted content", support: select("released"), target: release("released") }
      ])
    })]);
    const sayFrame = said.frames.find((row) => row.predicate_support.reading === "say")!;
    const deniedRelease = said.frames.find((row) => row.predicate_support.reading === "release")!;
    const innerNot = said.operators.find((row) => row.operator === "not")!;
    expect(said.asserted_at_scope).toEqual([sayFrame.id]);
    expect(innerNot.context_owner).toEqual({ kind: "embedding", parent_frame: sayFrame.id,
      content_argument: innerNot.id });
    expect(deniedRelease.context_owner).toEqual({ kind: "operator", operator_handle: innerNot.id });
    expect(closureTexts(said, deniedRelease.id)).toEqual(expect.arrayContaining(["said", "not", "release", "Lena", "I"]));
    const speakerSlot = sayFrame.slots.find((row) => row.role_reading === "speaker")!;
    const speakerTarget = sayFrame.bindings.find((row) => row.slot_id === speakerSlot.id)!.target;
    expect(speakerTarget.kind).toBe("node");
    if (speakerTarget.kind === "node") {
      const referent = said.referents.find((row) => row.id === speakerTarget.id)!;
      expect(referent.mentions.map((id) => said.mentions.find((row) => row.id === id)!.text))
        .toEqual(expect.arrayContaining(["Lena", "I"]));
    }
    expect(said.mentions.map((row) => row.text)).not.toContain("User");
    const sayUnderNot = didNotSay.frames.find((row) => row.predicate_support.reading === "say")!;
    const reportedRelease = didNotSay.frames.find((row) => row.predicate_support.reading === "release")!;
    const outerNot = didNotSay.operators.find((row) => row.operator === "not")!;
    expect(didNotSay.asserted_at_scope).toEqual([outerNot.id]);
    expect(sayUnderNot.context_owner).toEqual({ kind: "operator", operator_handle: outerNot.id });
    expect(reportedRelease.context_owner).toEqual({ kind: "embedding", parent_frame: sayUnderNot.id,
      content_argument: reportedRelease.id });
    expect(closureTexts(didNotSay, reportedRelease.id)).toEqual(expect.arrayContaining(["did not", "say", "released"]));
  });

  it("keeps a supplied proposition under unknown truth distinct from unresolved content", () => {
    const text = "The inspector does not know whether gate R-6 is open.";
    const proposition = statement("open", "open", 1, [{ role: "subject", target: select("gate R-6") }]);
    const knowledge = (target: object) => root({ kind: "not", support: select("does not"),
      content: statement("know whether", "know whether", 1, [
        { role: "knower", target: select("The inspector") },
        { role: "content", support: select("whether"), target }
      ], "knowledge") });
    const knownContent = interpret([text], [knowledge(proposition)]);
    const missingContent = interpret([text], [knowledge({ kind: "unresolved" })], [
      { kind: "missing_binding", support: select("gate R-6 is open"), affected: ["knowledge"] }
    ]);
    const open = knownContent.frames.find((row) => row.predicate_support.reading === "open")!;
    const know = knownContent.frames.find((row) => row.predicate_support.reading === "know whether")!;
    expect(open.context_owner).toEqual({ kind: "embedding", parent_frame: know.id, content_argument: open.id });
    expect(knownContent.asserted_at_scope).not.toContain(open.id);
    expect(closureTexts(knownContent, open.id)).toEqual(expect.arrayContaining(["gate R-6", "open", "know whether", "does not"]));
    expect(missingContent.frames.some((row) => row.predicate_support.reading === "open")).toBe(false);
    const incompleteKnowledge = missingContent.frames.find((row) => row.predicate_support.reading === "know whether")!;
    expect(missingContent.gaps.some((gap) => gap.kind === "missing_binding"
      && gap.affected_ids.includes(incompleteKnowledge.id))).toBe(true);
  });

  it("locates qualification on its event or a gap on that event, not on another frame", () => {
    const texts = ["The badge admits guests on Friday only.",
      "The supervisor does not know whether it admits guests on Sunday."];
    const first = (qualified: boolean) => root(statement("admit", "admits", 1, [
      { role: "subject", target: { kind: "entity", key: "badge", mentions: [select("badge")] } },
      { role: "visitor", target: select("guests") },
      { role: qualified ? "exclusive applicability day" : "day", target: select("Friday"),
        support: select(qualified ? "Friday only" : "Friday") }
    ], "fridayAdmission"));
    const second = root({ kind: "not", support: select("does not", 2), content:
      statement("know whether", "know whether", 2, [
        { role: "knower", target: select("The supervisor", 2) },
        { role: "content", support: select("whether", 2), target: statement("admit", "admits", 2, [
          { role: "subject", target: { kind: "entity", key: "badge", mentions: [select("it", 2)] } },
          { role: "visitor", target: select("guests", 2) },
          { role: "day", target: select("Sunday", 2) }
        ]) }
      ], "knowledge") });
    const qualified = interpret(texts, [first(true), second]);
    const localGap = interpret(texts, [first(false), second], [
      { kind: "unsupported_meaning", support: select("only"), affected: ["fridayAdmission"] }
    ]);
    const otherGap = interpret(texts, [first(false), second], [
      { kind: "unsupported_meaning", support: select("only"), affected: ["knowledge"] }
    ]);
    const firstFrame = (h: SourceSemanticInterpretation) => h.frames.find((row) =>
      row.predicate_support.reading === "admit" && row.context_owner.kind === "source_act")!;
    expect(firstFrame(qualified).slots.map((row) => row.role_reading)).toContain("exclusive applicability day");
    expect(closureTexts(qualified, firstFrame(qualified).id)).toContain("Friday only");
    expect(closureTexts(localGap, firstFrame(localGap).id)).toContain("only");
    expect(firstFrame(otherGap).slots.map((row) => row.role_reading)).not.toContain("exclusive applicability day");
    expect(closureTexts(otherGap, firstFrame(otherGap).id)).not.toContain("only");
    const otherAffected = otherGap.gaps.find((gap) => gap.kind === "unsupported_meaning")!.affected_ids;
    expect(otherAffected).toContain(otherGap.frames.find((row) => row.predicate_support.reading === "know whether")!.id);
    expect(otherAffected).not.toContain(firstFrame(otherGap).id);
  });
});
