import { expect, it } from "vitest";
import { sourceSemanticInterpretationIdentity } from "@do-soul/alaya-protocol";
import { buildSourceSemanticCorrespondenceRequest, semanticSha256 }
  from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { proposeQuerySemantics, proposeSourceSemantics }
  from "../../../garden/ingestion/official-api/source-semantic-receive.js";

const SOURCE = "Nora lent me a charger. I took that charger to Ravi.";
const RECIPIENT = "Who did I take the charger that Nora lent me to?";
const LENDER = "Who lent me the charger that I took to Ravi?";

function quote(assertion_id: number, text: string) { return { assertion_id, text }; }

function chargerSource() {
  const speaker = { kind: "entity", key: "speaker", mentions: [quote(1, "me"), quote(2, "I")] };
  const charger = { kind: "entity", key: "charger", mentions: [quote(1, "a charger"), quote(2, "that charger")] };
  const received = proposeSourceSemantics({ sourceCorpus: SOURCE, assertionIds: [1, 2], sourceScope: "complete-source",
    source_id: "reference-source", source_version: "1", producer_id: "authored-control", producer_version: "1" },
  { rawJson: JSON.stringify({ contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" },
    content: { roots: [
      { act: "assertion", expression: { kind: "statement",
        predicate: { kind: "explicit", reading: "lend", support: quote(1, "lent") },
        arguments: [{ role: "lender", target: quote(1, "Nora") },
          { role: "recipient", target: speaker }, { role: "theme", target: charger }] } },
      { act: "assertion", expression: { kind: "statement",
        predicate: { kind: "explicit", reading: "take", support: quote(2, "took") },
        arguments: [{ role: "agent", target: speaker }, { role: "theme", target: charger },
          { role: "recipient", target: quote(2, "Ravi") }] } }
    ] } }) });
  if (received.interpretation === undefined) throw new Error(`authored H failed: ${JSON.stringify(received.outcome)}`);
  return received.interpretation;
}

function chargerQuery(original_query: string, answer: "recipient" | "lender") {
  const firstPerson = answer === "recipient" ? "I" : "me";
  const chargerExcerpt = answer === "recipient" ? "the charger that Nora lent me" : "the charger that I took to Ravi";
  const target = { kind: "named", key: "charger", excerpt: chargerExcerpt };
  const speaker = { kind: "named", key: "speaker", excerpt: firstPerson };
  const who = { kind: "free", key: "answerPerson", return: true };
  const take = { kind: "statement", key: "taking", predicate: "take", arguments: [
    { role: "agent", target: answer === "recipient" ? speaker : { kind: "reference", key: "speaker" }, excerpt: "I" },
    { role: "theme", target: answer === "recipient" ? target : { kind: "reference", key: "charger" }, excerpt: "charger" },
    { role: "recipient", target: answer === "recipient" ? who : { kind: "named", key: "Ravi", excerpt: "Ravi" },
      excerpt: answer === "recipient" ? "Who" : "Ravi" }
  ] };
  const lend = { kind: "statement", key: "lending", predicate: "lend", arguments: [
    { role: "lender", target: answer === "lender" ? who : { kind: "named", key: "Nora", excerpt: "Nora" },
      excerpt: answer === "lender" ? "Who" : "Nora" },
    { role: "recipient", target: answer === "lender" ? speaker : { kind: "reference", key: "speaker" }, excerpt: "me" },
    { role: "theme", target: answer === "lender" ? target : { kind: "reference", key: "charger" }, excerpt: "charger" }
  ] };
  const received = proposeQuerySemantics({ original_query,
    approved_fixed_context: { context_id: "avery-utterance", notes: "Avery authored unquoted I/me in this question." },
    producer_id: "authored-control", producer_version: "1" },
  { rawJson: JSON.stringify({ contract: "source-semantic-query-response-v7",
    outcome: { status: "interpreted", gaps: [] },
    query: { contract: "source-semantic-query-meaning-v5", gaps: [],
      alternatives: [{ conditions: answer === "recipient" ? [take, lend] : [lend, take] }] } }) });
  if (received.query === undefined) throw new Error(`authored Q failed: ${JSON.stringify(received.outcome)}`);
  return received.query;
}

it("retains shared charger identity and advertises positive versus cross-role C endpoints", () => {
  const interpretation = chargerSource();
  const lenderFrame = interpretation.frames.find(row => row.predicate_support.reading === "lend")!;
  const takingFrame = interpretation.frames.find(row => row.predicate_support.reading === "take")!;
  const sourceTheme = (frame: typeof lenderFrame) => {
    const slot = frame.slots.find(row => row.role_reading === "theme")!;
    const target = frame.bindings.find(row => row.slot_id === slot.id)?.target;
    if (target?.kind !== "node") throw new Error("charger theme must be bound");
    return target.id;
  };
  expect(sourceTheme(lenderFrame)).toBe(sourceTheme(takingFrame));
  const charger = interpretation.referents.find(row => row.id === sourceTheme(lenderFrame))!;
  expect(charger.mentions.map(id => interpretation.mentions.find(row => row.id === id)?.text).sort())
    .toEqual(["a charger", "that charger"]);

  for (const [question, answer] of [[RECIPIENT, "recipient"], [LENDER, "lender"]] as const) {
    const semantics = chargerQuery(question, answer);
    expect(semantics.return_variables).toEqual(["answerPerson"]);
    const descriptor = { source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, semanticSha256),
      interpretation };
    const catalog = buildSourceSemanticCorrespondenceRequest({ original_query: question,
      admitted_query_semantics: semantics, source_interpretation_descriptors: [descriptor],
      producer_id: "authored-control", producer_version: "1" }).catalog;
    const rolePair = (frame: string, role: string, sourceFrame: typeof lenderFrame, sourceRole: string) => {
      const querySlot = semantics.alternatives[0]!.frames.find(row => row.id === frame)!
        .role_requirements.find(row => row.role_reading === role)!;
      const hSlot = sourceFrame.slots.find(row => row.role_reading === sourceRole)!;
      return {
        query: catalog.query_endpoints.find(row => row.kind === "slot" && row.frame === frame && row.slot === querySlot.id)?.handle,
        source: catalog.source_endpoints.find(row => row.kind === "slot" && row.frame === sourceFrame.id && row.slot === hSlot.id)?.handle
      };
    };
    const takeRecipient = rolePair("taking", "recipient", takingFrame, "recipient");
    const lendLender = rolePair("lending", "lender", lenderFrame, "lender");
    const crossTake = rolePair("taking", "recipient", lenderFrame, "lender");
    const crossLend = rolePair("lending", "lender", takingFrame, "recipient");
    expect(takeRecipient.query).toMatch(/^qe[1-9]/u);
    expect(takeRecipient.source).toMatch(/^se[1-9]/u);
    expect(lendLender.query).toMatch(/^qe[1-9]/u);
    expect(lendLender.source).toMatch(/^se[1-9]/u);
    expect(crossTake.source).not.toBe(takeRecipient.source);
    expect(crossLend.source).not.toBe(lendLender.source);
    expect(catalog.source_endpoints.filter(row => row.kind === "frame")).toHaveLength(2);
  }
});
