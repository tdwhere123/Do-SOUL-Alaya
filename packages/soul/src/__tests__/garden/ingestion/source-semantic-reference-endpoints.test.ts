import { expect, it } from "vitest";
import { AlayaError, buildSourceSemanticCorrespondenceEndpointEvidence,
  sourceSemanticInterpretationIdentity, UNKNOWN_UTTERANCE_ATTRIBUTION, encodeSourceSemanticQueryCarrier,
  type SourceSemanticQueryMeaningBody } from "@do-soul/alaya-protocol";
import { buildSourceSemanticCorrespondenceRequest, semanticSha256 }
  from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { proposeQuerySemantics, proposeSourceSemantics }
  from "../../../garden/ingestion/official-api/source-semantic-receive.js";

const SOURCE = "Nora lent me a charger. I took that charger to Ravi.";
const RECIPIENT = "Who did I take the charger that Nora lent me to?";
const LENDER = "Who lent me the charger that I took to Ravi?";

function quote(assertion_id: number, text: string) { return { assertion_id, text }; }

function chargerSource() {
  const speaker = { kind: "entity_ref", key: "speaker" };
  const charger = { kind: "entity_ref", key: "charger" };
  const received = proposeSourceSemantics({ sourceCorpus: SOURCE, assertionIds: [1, 2], sourceScope: "complete-source",
    source_id: "reference-source", source_version: "1", producer_id: "authored-control", producer_version: "1" },
  { rawJson: JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" },
    content: {
      roots: ["lending", "taking"].map(key => ({ act: "assertion", expression: { kind: "content_ref", key } })),
      entities: [
        { form: "entity", key: "speaker", semantic_key: "speaker", mentions: [quote(1, "me"), quote(2, "I")] },
        { form: "entity", key: "charger", semantic_key: "charger", mentions: [quote(1, "a charger"), quote(2, "that charger")] },
        { form: "selection", key: "nora", selection: quote(1, "Nora") },
        { form: "selection", key: "ravi", selection: quote(2, "Ravi") }
      ], nodes: [
      { kind: "statement", key: "lending",
        predicate: { kind: "explicit", reading: "lend", support: quote(1, "lent") },
        arguments: [{ role: "lender", target: { kind: "entity_ref", key: "nora" } },
          { role: "recipient", target: speaker }, { role: "theme", target: charger }], qualifications: [] },
      { kind: "statement", key: "taking",
        predicate: { kind: "explicit", reading: "take", support: quote(2, "took") },
        arguments: [{ role: "agent", target: speaker }, { role: "theme", target: charger },
          { role: "recipient", target: { kind: "entity_ref", key: "ravi" } }], qualifications: [] }
    ], gaps: [] } }) });
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
  { rawJson: JSON.stringify({ contract: "source-semantic-query-response-v8",
    outcome: { status: "interpreted", gaps: [] },
    query: encodeSourceSemanticQueryCarrier({ contract: "source-semantic-query-meaning-v5", gaps: [],
      alternatives: [{ conditions: answer === "recipient" ? [take, lend] : [lend, take] }] } as SourceSemanticQueryMeaningBody) }) });
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

it("presents declared reference uses and source frame context on the same endpoint handles", () => {
  const interpretation = chargerSource();
  const query = chargerQuery(RECIPIENT, "recipient");
  const request = buildSourceSemanticCorrespondenceRequest({ original_query: RECIPIENT,
    admitted_query_semantics: query,
    source_interpretation_descriptors: [{
      source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, semanticSha256), interpretation
    }], producer_id: "authored-control", producer_version: "1" });
  const { catalog, endpoint_evidence: evidence } = request;
  expect(request.contract).toBe("source-semantic-correspondence-request-v6");
  expect(evidence.contract).toBe("source-semantic-correspondence-endpoint-evidence-v1");
  expect(evidence.query_endpoints.map(row => row.handle)).toEqual(catalog.query_endpoints.map(row => row.handle));
  expect(evidence.source_endpoints.map(row => row.handle)).toEqual(catalog.source_endpoints.map(row => row.handle));

  const querySpeakerHandle = catalog.query_endpoints.find(row => row.variable === "speaker")!.handle;
  expect(evidence.query_endpoints.find(row => row.handle === querySpeakerHandle)).toMatchObject({
    kind: "referent", reference: { kind: "query_text", excerpt: "I" },
    attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    uses: [
      { frame: "taking", role_reading: "agent", role_support: { excerpt: "I" },
        context_obligations: [{ kind: "asserted_at_source" }] },
      { frame: "lending", role_reading: "recipient", role_support: { excerpt: "me" },
        context_obligations: [{ kind: "asserted_at_source" }] }
    ]
  });
  const sourceSpeaker = interpretation.referents.find(row => row.mentions.some(id =>
    interpretation.mentions.find(mention => mention.id === id)?.text === "me"))!;
  const sourceSpeakerHandle = catalog.source_endpoints.find(row => row.referent === sourceSpeaker.id)!.handle;
  expect(evidence.source_endpoints.find(row => row.handle === sourceSpeakerHandle)).toMatchObject({
    kind: "referent", source_context: {
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
      assertion_locations: interpretation.source.assertion_locations ?? null
    },
    mentions: [{ text: "me", span_space: "assertion_code_units" },
      { text: "I", span_space: "assertion_code_units" }],
    uses: [
      { role_reading: "recipient", context_owner: { kind: "source_act", source_act: "assertion" },
        target: { kind: "node", id: sourceSpeaker.id } },
      { role_reading: "agent", context_owner: { kind: "source_act", source_act: "assertion" },
        target: { kind: "node", id: sourceSpeaker.id } }
    ]
  });
  const sourceSlotHandle = catalog.source_endpoints.find(row => row.kind === "slot" && row.reading === "recipient")!.handle;
  expect(evidence.source_endpoints.find(row => row.handle === sourceSlotHandle)).toMatchObject({
    kind: "slot", frame_context: { context_owner: { kind: "source_act", source_act: "assertion" } },
    bindings: [{ target: { kind: "node", id: sourceSpeaker.id } }]
  });
});

it("classifies mismatched public projection references as validation errors", () => {
  const interpretation = chargerSource();
  const query = chargerQuery(RECIPIENT, "recipient");
  const descriptor = { source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, semanticSha256),
    interpretation };
  const catalog = buildSourceSemanticCorrespondenceRequest({ original_query: RECIPIENT,
    admitted_query_semantics: query, source_interpretation_descriptors: [descriptor],
    producer_id: "authored-control", producer_version: "1" }).catalog;
  const sourceSlot = catalog.source_endpoints.find(row => row.kind === "slot")!;
  const cases = [
    { catalog: { ...catalog, query_endpoints: catalog.query_endpoints.map(row =>
      row.kind === "referent" && row.variable === "speaker" ? { ...row, variable: "missing" } : row) },
      message: "catalog referent has no declared query reference" },
    { catalog: { ...catalog, source_endpoints: catalog.source_endpoints.map(row =>
      row.handle === sourceSlot.handle ? { ...row, slot: "missing" } : row) },
      message: "catalog slot has no declared source slot" }
  ];
  for (const entry of cases) {
    let failure: unknown;
    try {
      buildSourceSemanticCorrespondenceEndpointEvidence(query,
        [{ source_interpretation_handle: "source1", interpretation }], entry.catalog);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AlayaError);
    expect(failure).toMatchObject({ code: "VALIDATION", message: entry.message });
  }
});
