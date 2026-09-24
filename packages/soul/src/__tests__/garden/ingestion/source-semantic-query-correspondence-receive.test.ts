import { describe, expect, it } from "vitest";
import {
  SourceSemanticQuerySchema, sourceSemanticInterpretationIdentity, sourceSemanticQueryIdentity,
  sourceSemanticQueryBranchViews, UNKNOWN_UTTERANCE_ATTRIBUTION, encodeSourceSemanticQueryCarrier,
  expandSourceSemanticQueryCarrier,
  type SourceSemanticQueryMeaningBody
} from "@do-soul/alaya-protocol";
import { buildOfficialApiSourceCorpus, indexOfficialApiSourceAssertions } from "../../../garden/triage/grounding/source-locator.js";
import {
  semanticSha256, SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import {
  proposeCorrespondenceSemantics, proposeQuerySemantics as receiveQuerySemantics, proposeSourceSemantics
} from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { sourceSemanticQueryExamples } from "../../../garden/ingestion/official-api/source-semantic-query-examples.js";

const TEXT = "The archivist accessioned folio F into bay B.";
const EXISTENTIAL = "which folio was accessioned into bay B?";

type NestedFixtureExpression = Record<string, unknown>;
type NestedFixtureBody = Record<string, unknown> & { alternatives?: readonly {
  conditions?: readonly NestedFixtureExpression[];
  evidence_inputs?: readonly { conditions?: readonly NestedFixtureExpression[] }[]
}[] };

function fixtureWire(query: unknown): unknown {
  try { return encodeSourceSemanticQueryCarrier(query as SourceSemanticQueryMeaningBody); }
  catch {
    // Malformed fixture bodies must still reach the receiver as malformed wire.
    const body = query as NestedFixtureBody;
    const nodes: Record<string, unknown>[] = [];
    const put = (expression: NestedFixtureExpression): string => {
      const node = `n${nodes.length + 1}`;
      const row: Record<string, unknown> = { ...expression, node };
      nodes.push(row);
      for (const field of ["content", "antecedent", "consequent"]) {
        if (row[field] !== undefined && typeof row[field] === "object") row[field] = put(row[field] as NestedFixtureExpression);
      }
      if (Array.isArray(row.operands)) row.operands = (row.operands as NestedFixtureExpression[]).map(put);
      return node;
    };
    return { ...body, alternatives: body.alternatives?.map(alternative => ({ ...alternative,
      conditions: alternative.conditions?.map(put),
      ...(alternative.evidence_inputs === undefined ? {} : { evidence_inputs: alternative.evidence_inputs.map(input => ({
        ...input, conditions: input.conditions?.map(put)
      })) })
    })), nodes };
  }
}

function proposeQuerySemantics(...args: Parameters<typeof receiveQuerySemantics>): ReturnType<typeof receiveQuerySemantics> {
  const [input, injected, parseQuery] = args;
  if (injected === undefined) return receiveQuerySemantics(input, injected, parseQuery);
  const response = JSON.parse(injected.rawJson);
  if (response.query !== undefined && response.query.nodes === undefined && response.query.alternatives !== undefined) {
    response.query = fixtureWire(response.query);
  }
  return receiveQuerySemantics(input, { rawJson: JSON.stringify(response) }, parseQuery);
}

type EditableWireNode = { node: string; arguments: { excerpt?: string; target: { excerpt?: string } }[] };
function inputNode(response: unknown, inputIndex: number, conditionIndex: number): EditableWireNode {
  const query = (response as { query: {
    nodes: EditableWireNode[];
    alternatives: { evidence_inputs: { conditions: string[] }[] }[]
  } }).query;
  const token = query.alternatives[0]!.evidence_inputs[inputIndex]!.conditions[conditionIndex]!;
  const node = query.nodes.find(row => row.node === token);
  if (node === undefined) throw new Error(`fixture node ${token} missing`);
  return node;
}

function sourceInput(text = TEXT) {
  const sourceCorpus = buildOfficialApiSourceCorpus(text, [{ role: "user", content: text }]);
  const assertion = indexOfficialApiSourceAssertions(sourceCorpus).find((row) => row.text.includes(text))!;
  return {
    sourceCorpus, assertionIds: [assertion.assertion_id],
    source_id: "src", source_version: "1", producer_id: "authored-producer", producer_version: "p1"
  };
}

function interpretation(producerVersion = "p1") {
  const input = { ...sourceInput(), producer_version: producerVersion };
  const quote = (text: string) => ({ assertion_id: input.assertionIds[0]!, text });
  const received = proposeSourceSemantics(input, { rawJson: JSON.stringify({
    contract: "source-semantic-proposal-v8",
    outcome: { status: "interpreted" },
    content: {
      roots: [{ act: "assertion", expression: { kind: "content_ref", key: "accession" } }],
      entities: [
        { form: "entity", key: "archivist", semantic_key: "archivist", mentions: [quote("archivist")] },
        { form: "entity", key: "folio", semantic_key: "folio", mentions: [quote("folio F")] },
        { form: "entity", key: "bay", semantic_key: "bay", mentions: [quote("bay B")] }
      ],
      nodes: [{ kind: "statement", key: "accession",
        predicate: { kind: "explicit", reading: "accession", support: quote("accessioned") },
      arguments: [
        { role: "agent", target: { kind: "entity_ref", key: "archivist" } },
        { role: "object", target: { kind: "entity_ref", key: "folio" } },
        { role: "bay", target: { kind: "entity_ref", key: "bay" } }
      ], qualifications: [] }], gaps: [] }
  }) });
  if (received.interpretation === undefined) throw new Error(`current source fixture failed: ${JSON.stringify(received.outcome)}`);
  return received.interpretation;
}

const role = (id: string, variable: string, excerpt: string) => ({
  id, role_reading: id, target_variable: variable, support: { kind: "query_text" as const, excerpt }
});

function existentialBody() {
  return {
    variables: [
      { id: "folio", sort: "entity" as const }, { id: "bay", sort: "entity" as const },
      { id: "fAccession", sort: "proposition" as const }
    ],
    alternatives: [{
      frames: [{
        id: "qAccession", variable: "fAccession", predicate_reading: "accession",
        role_requirements: [
          role("object", "folio", "folio"),
          role("bay", "bay", "bay B")
        ]
      }],
      context_obligations: [{ frame: "qAccession", kind: "asserted_at_source" as const }]
    }],
    return_variables: ["folio"],
    gaps: [] as const
  };
}

function canonicalQuery(original: string, body: object) {
  return SourceSemanticQuerySchema.parse({
    contract: "source-semantic-query-v4",
    original_query_digest: `sha256:${semanticSha256(original)}`,
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: "query-producer", producer_version: "1", contract_version: "source-semantic-query-v4",
    ...body
  });
}

describe("query meaning receive and semantic_correspondence selection", () => {
  it("keeps the retired recursive response outside current query admission", () => {
    const example = sourceSemanticQueryExamples[0]!;
    const old = { ...example.response, contract: "source-semantic-query-response-v7",
      query: expandSourceSemanticQueryCarrier(example.response.query) };
    const received = receiveQuerySemantics({ original_query: example.original_query,
      producer_id: "query-producer", producer_version: "1" }, { rawJson: JSON.stringify(old) });
    expect(received.outcome.status).toBe("invalid");
    expect(received.query).toBeUndefined();
  });

  it.each(["free", "named"] as const)("rejects contradictory entity kinds in %s-first order without replacing a free answer", first => {
    const input = { original_query: "Who told Mira that Lee might leave?",
      producer_id: "alaya.source.semantic.query.soul.v1", producer_version: "1" };
    const response = (recipient: string) => {
      const args = [
        { role: "teller", target: { kind: "free", key: "teller", excerpt: "Who", return: true } },
        { role: "recipient", target: { kind: "named", key: recipient, excerpt: "Mira" } }
      ];
      return { contract: "source-semantic-query-response-v8", outcome: { status: "interpreted" },
        query: { contract: "source-semantic-query-meaning-v5", gaps: [],
          alternatives: [{ conditions: [{ kind: "statement", key: "tell", predicate: "tell",
            arguments: first === "named" ? args.reverse() : args,
            content: { kind: "possible", key: "possibility", content: { kind: "statement", key: "leave", predicate: "leave",
              arguments: [{ role: "agent", target: { kind: "named", key: "lee", excerpt: "Lee" } }] } }
          }] }] } };
    };
    const rejected = proposeQuerySemantics(input, { rawJson: JSON.stringify(response("teller")) });
    expect(rejected.outcome).toMatchObject({ status: "invalid", reason: "malformed_response",
      diagnostics: [{ message: "entity declaration kind conflicts with an earlier declaration" }] });
    expect(rejected.query).toBeUndefined();
    const faithful = proposeQuerySemantics(input, { rawJson: JSON.stringify(response("mira")) });
    expect(faithful.outcome).toEqual({ status: "interpreted", gaps: [] });
    expect(faithful.query?.return_variables).toEqual(["teller"]);
    expect(faithful.query?.variables.find(variable => variable.id === "teller")).toEqual({ id: "teller", sort: "entity" });
    expect(faithful.query?.variables.find(variable => variable.id === "mira")?.reference?.excerpt).toBe("Mira");
    expect(faithful.query?.alternatives[0]?.context_obligations).toEqual([
      { frame: "tell", kind: "asserted_at_source" },
      { frame: "possibility", kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "tell", role: "content" } },
      { frame: "leave", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "possibility", role: "content" } }
    ]);
  });

  it.each(["person", "Who", "speaker", "local73"])("receives a supported free reporter with arbitrary handle %s", key => {
    const received = proposeQuerySemantics({ original_query: "Who reported that Lee left?", producer_id: "query-producer", producer_version: "1" }, {
      rawJson: JSON.stringify({ contract: "source-semantic-query-response-v8", outcome: { status: "interpreted" },
        query: { contract: "source-semantic-query-meaning-v5", gaps: [], entities: [{ kind: "free", key, excerpt: "Who", return: true }],
          alternatives: [{ conditions: [{ kind: "reported", key: "report", reporter: { kind: "reference", key },
            content: { kind: "statement", key: "leave", predicate: "left", arguments: [
              { role: "agent", target: { kind: "named", key: "lee", excerpt: "Lee" } }
            ] } }] }] } })
    });
    expect(received.request.contract).toBe("source-semantic-query-request-v9");
    expect(received.outcome.status).toBe("interpreted");
    expect(received.query?.alternatives[0]?.frames[0]?.role_requirements).toEqual([
      { id: "reporter", role_reading: "reporter", target_variable: key, support: { kind: "query_text", excerpt: "Who" } }
    ]);
    expect(SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT).toContain("Local keys are arbitrary identifiers, never text evidence");
  });

  it("retains an unresolved speaker expression without assigning a speaker identity", () => {
    const original_query = "What degree did I graduate with?";
    const body = (target: object, gaps: object[]) => ({
      contract: "source-semantic-query-response-v8", outcome: { status: "interpreted" },
      query: { contract: "source-semantic-query-meaning-v5", gaps,
        alternatives: [{ conditions: [{ kind: "statement", predicate: "graduate", arguments: [
          { role: "agent", target },
          { role: "degree", target: { kind: "free", key: "degree", excerpt: "What degree", return: true } }
        ] }] }] }
    });
    const input = { original_query, producer_id: "query-producer", producer_version: "1" };
    const gap = { kind: "unresolved_referent", affected_ids: ["subject"],
      support: [{ kind: "query_text", excerpt: "I" }], description: "The approved query context does not identify the speaker." };
    const constrained = proposeQuerySemantics(input, { rawJson: JSON.stringify(body(
      { kind: "named", key: "subject", excerpt: "I" }, [gap]
    )) });
    expect(constrained.outcome).toEqual({ status: "interpreted", gaps: [gap] });
    expect(constrained.query?.variables.find(row => row.id === "subject")?.reference).toEqual({ kind: "query_text", excerpt: "I" });
    expect(constrained.query?.variables.find(row => row.id === "degree")?.reference).toBeUndefined();
    expect(constrained.query?.return_variables).toEqual(["degree"]);
    const structurallyValidButUnfaithful = proposeQuerySemantics(input, { rawJson: JSON.stringify(body(
      { kind: "free", key: "subject", excerpt: "I" }, []
    )) });
    expect(structurallyValidButUnfaithful.outcome.status).toBe("interpreted");
    expect(structurallyValidButUnfaithful.query?.variables.find(row => row.id === "subject")?.reference).toBeUndefined();
    expect(sourceSemanticQueryIdentity(constrained.query!, semanticSha256)).not.toBe(
      sourceSemanticQueryIdentity(structurallyValidButUnfaithful.query!, semanticSha256));
  });

  it("materializes complete producer examples without asserting embedded actions or returning universal witnesses", () => {
    const results = sourceSemanticQueryExamples.map((example) => proposeQuerySemantics({
      original_query: example.original_query, producer_id: "query-producer", producer_version: "1"
    }, { rawJson: JSON.stringify(example.response) }));
    expect(results.map((result) => result.outcome.status)).toEqual(sourceSemanticQueryExamples.map(() => "interpreted"));
    const nested = results[0]!.query!;
    expect(nested.return_variables).toEqual(["person"]);
    expect(nested.alternatives[0]!.context_obligations).toEqual([
      { frame: "request", kind: "asserted_at_source" },
      { frame: "action", kind: "explicit_embedded_structure",
        incidence: { kind: "embedding", other_frame: "request", role: "content" } }
    ]);
    const universal = results[1]!.query!;
    expect(universal.domains).toEqual([{ id: "sensors", support: { kind: "query_text", excerpt: "every registered sensor" } }]);
    expect(universal.evaluation).toEqual({ kind: "forall", domain: "sensors", binder: "sensor", local_variables: ["sensor", "calibration"] });
    expect(universal.return_variables).toEqual([]);
    expect(universal.alternatives[0]!.frames[0]!.role_requirements[0]!.target_variable).toBe("sensor");
    expect(results[2]!.query!.gaps).toEqual(sourceSemanticQueryExamples[2]!.response.query.gaps);
    expect(results[2]!.outcome).toEqual({ status: "interpreted", gaps: sourceSemanticQueryExamples[2]!.response.query.gaps });
    const operation = results[3]!.query!;
    const alternative = operation.alternatives[0]!;
    expect(operation.requested_operation).toEqual(sourceSemanticQueryExamples[3]!.response.query.requested_operation);
    expect(operation.return_variables).toEqual([]);
    expect(operation.evaluation).toBeUndefined();
    expect(alternative.answer_frames).toEqual([alternative.frames[0]!.id]);
    expect(alternative.evidence_inputs).toEqual([
      { frames: [alternative.frames[1]!.id] }, { frames: [alternative.frames[2]!.id] }
    ]);
    expect(alternative.frames.map((frame) => frame.role_requirements.map((role) => role.target_variable)))
      .toEqual([["amber", "blue", "tray"], ["amber", "tray", "amber_count"], ["blue", "tray", "blue_count"]]);
    const occurrence = results[4]!.query!;
    expect(occurrence.variables.map(row => row.sort)).toEqual(["proposition", "proposition", "proposition"]);
    expect(occurrence.alternatives[0]!.context_obligations).toEqual([
      { frame: "before", kind: "asserted_at_source" }, { frame: "ring", kind: "asserted_at_source" },
      { frame: "flash", kind: "asserted_at_source" }
    ]);
    expect(occurrence.alternatives[0]!.frames[0]!.role_requirements.map(row => row.target_variable)).toEqual(["ring", "flash"]);
    expect(results[5]!.query!.alternatives[0]!.frames[0]!.source_act).toBe("question");
    expect(results[6]!.query!.alternatives[0]!.frames[0]!.source_act).toBe("directive");
    expect(occurrence.alternatives[0]!.frames.every(row => row.source_act === undefined)).toBe(true);
    const constrained = results[7]!.query!;
    expect(constrained.variables.find(row => row.id === "steward")?.reference).toEqual({
      kind: "query_text", excerpt: "the workshop steward"
    });
    expect(constrained.variables.find(row => row.id === "tool")?.reference).toBeUndefined();
    expect(constrained.return_variables).toEqual(["tool"]);
    expect(constrained.gaps).toMatchObject([{ kind: "unsupported_meaning", affected_ids: ["use_event"] }]);
    const unresolved = results[8]!.query!;
    expect(unresolved.variables.find(row => row.id === "technician")?.reference?.excerpt).toBe("that technician");
    expect(unresolved.gaps).toMatchObject([
      { kind: "unresolved_referent", affected_ids: ["technician"] },
      { kind: "unsupported_meaning", affected_ids: ["use_event"] }
    ]);
    expect(results[8]!.outcome.status).toBe("interpreted");
    const existential = results[9]!.query!;
    expect(existential.variables.find(row => row.id === "person")?.reference).toBeUndefined();
    expect(existential.return_variables).toEqual(["tool"]);
    expect(existential.gaps).toMatchObject([{ kind: "unsupported_meaning", affected_ids: ["use_event"] }]);
    expect(SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT).toContain("A named target preserves a referentially constrained expression");
  });

  it("keeps the two qualified event inputs distinct from the requested elapsed-hours answer", () => {
    const example = sourceSemanticQueryExamples[10]!;
    const received = proposeQuerySemantics({ original_query: example.original_query,
      producer_id: "query-producer", producer_version: "1"
    }, { rawJson: JSON.stringify(example.response) });
    expect(received.outcome).toEqual({ status: "interpreted", gaps: [] });
    const query = received.query!;
    const views = sourceSemanticQueryBranchViews(query.alternatives[0]!);
    // Expected from the original question: both events have Tara, crate C and their own stated day;
    // the hours answer and each event-time input have different jobs.
    expect(views.map(view => view.alternative.frames.map(frame => frame.id))).toEqual([
      ["elapsed", "sealing", "opening"], ["sealing", "seal_time"], ["opening", "open_time"]
    ]);
    expect(views[1]!.alternative.frames[0]!.role_requirements.map(role => [role.role_reading, role.support.excerpt]))
      .toEqual([["agent", "Tara"], ["theme", "crate C"], ["date", "3 March 2024"]]);
    expect(views[2]!.alternative.frames[0]!.role_requirements.map(role => [role.role_reading, role.support.excerpt]))
      .toEqual([["agent", "Tara"], ["theme", "crate C"], ["date", "4 March 2024"]]);
    expect(query.return_variables).toEqual(["elapsed_hours"]);
    expect(views.slice(1).flatMap(view => view.alternative.frames).map(frame => frame.id)).not.toContain("elapsed");
    expect(query.requested_operation?.reading).toBe("Calculate elapsed hours from the sealing time to the opening time.");

    const withoutRoleSupport = structuredClone(example.response);
    Object.assign(inputNode(withoutRoleSupport, 0, 1).arguments[0]!, { excerpt: undefined });
    expect(proposeQuerySemantics({ original_query: example.original_query, producer_id: "query-producer", producer_version: "1" },
      { rawJson: JSON.stringify(withoutRoleSupport) }).outcome.status).toBe("invalid");
    const forgedRoleSupport = structuredClone(example.response);
    Object.assign(inputNode(forgedRoleSupport, 0, 1).arguments[0]!, { excerpt: "invented event" });
    expect(proposeQuerySemantics({ original_query: example.original_query, producer_id: "query-producer", producer_version: "1" },
      { rawJson: JSON.stringify(forgedRoleSupport) }).outcome.status).toBe("invalid");
    const withoutFreeInputSupport = structuredClone(example.response);
    Object.assign(inputNode(withoutFreeInputSupport, 1, 1).arguments[1]!.target,
      { excerpt: undefined });
    expect(proposeQuerySemantics({ original_query: example.original_query, producer_id: "query-producer", producer_version: "1" },
      { rawJson: JSON.stringify(withoutFreeInputSupport) }).outcome.status).toBe("invalid");
  });

  it("locates past restrictions on every affected neutral example while leaving nonpast questions unqualified", () => {
    const past = [
      [0, "was asked", "request"], [4, "Did ringing precede flashing", "before"],
      [5, "question asked whether the lens was polished", "polish"],
      [6, "directive required polishing", "polish"],
      [7, "did the workshop steward use", "use_event"],
      [8, "did that technician use", "use_event"], [9, "did someone use", "use_event"]
    ] as const;
    for (const [index, phrase, affected] of past) {
      const example = sourceSemanticQueryExamples[index]!;
      const received = proposeQuerySemantics({ original_query: example.original_query,
        producer_id: "query-producer", producer_version: "1"
      }, { rawJson: JSON.stringify(example.response) });
      expect(received.query?.gaps.some(gap => gap.kind === "unsupported_meaning"
        && gap.affected_ids.includes(affected) && gap.support.some(row => row.excerpt === phrase)), example.original_query).toBe(true);
    }
    for (const index of [1, 3, 10] as const) {
      const example = sourceSemanticQueryExamples[index]!;
      const received = proposeQuerySemantics({ original_query: example.original_query,
        producer_id: "query-producer", producer_version: "1"
      }, { rawJson: JSON.stringify(example.response) });
      expect(received.query?.gaps, example.original_query).toEqual([]);
    }
  });

  it("binds required evidence act support to the current original query and rejects replaced producer syntax", () => {
    const example = sourceSemanticQueryExamples[5]!;
    const received = (query: object, original_query: string = example.original_query, contract = "source-semantic-query-response-v8") =>
      proposeQuerySemantics({ original_query, producer_id: "query-producer", producer_version: "1" }, {
        rawJson: JSON.stringify({ contract, outcome: { status: "interpreted" }, query })
      });
    const body = (constraint: object) => ({ ...expandSourceSemanticQueryCarrier(example.response.query),
      alternatives: [{ conditions: [{ kind: "statement", key: "polish", predicate: "polish", arguments: [], ...constraint }] }] });
    const invalidBodies = [
      { ...example.response.query, contract: "source-semantic-query-meaning-v4" },
      body({ source_act: "question" }),
      body({ required_evidence_act: { act: "question" } }),
      body({ required_evidence_act: { act: "question", excerpt: "" } }),
      body({ required_evidence_act: { act: "question", excerpt: "invented" } })
    ];
    for (const query of invalidBodies) {
      const result = received(query);
      expect(result.outcome.status).toBe("invalid");
      expect(result.query).toBeUndefined();
    }
    expect(received(example.response.query, "Was the lens polished?").outcome.status).toBe("invalid");
    expect(received(example.response.query, example.original_query, "source-semantic-query-response-v6").outcome.status).toBe("invalid");
    expect(received(example.response.query).outcome.status).toBe("interpreted");
  });

  it("rejects legacy source-interpretation mention support instead of claiming that it locates a query gap", () => {
    const example = sourceSemanticQueryExamples[2]!;
    const query = { ...example.response.query, gaps: [{ kind: "unsupported_meaning", affected_ids: ["arrival"],
      support: [{ kind: "lexical", mentions: ["arrival"] }] }] };
    const result = proposeQuerySemantics({ original_query: example.original_query, producer_id: "query-producer", producer_version: "1" },
      { rawJson: JSON.stringify({ ...example.response, query }) });
    expect(result.outcome.status).toBe("invalid");
    expect(result.query).toBeUndefined();
  });

  it("materializes nested meaning with host-owned occurrence structure", () => {
    const meaning = proposeQuerySemantics({
      original_query: "Who sent the sample to Mira?", producer_id: "query-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-query-response-v8",
        outcome: { status: "interpreted" },
        query: {
          contract: "source-semantic-query-meaning-v5",
          alternatives: [{ conditions: [{
            kind: "statement", key: "send", predicate: "send",
            arguments: [
              { role: "sender", target: { kind: "free", key: "sender", return: true }, excerpt: "Who" },
              { role: "theme", target: { kind: "named", key: "sample", excerpt: "sample" }, excerpt: "sample" },
              { role: "recipient", target: { kind: "named", key: "mira", excerpt: "Mira" }, excerpt: "Mira" }
            ]
          }] }],
          gaps: []
        }
      })
    });
    expect(meaning.outcome.status).toBe("interpreted");
    expect(meaning.query?.variables.find((row) => row.id === "sender")?.reference).toBeUndefined();
    expect(meaning.query?.variables.find((row) => row.id === "mira")?.reference?.excerpt).toBe("Mira");
    expect(meaning.query?.alternatives[0]?.frames[0]?.source_act).toBeUndefined();
    expect(meaning.system_prompt).toContain("source-semantic-query-meaning-v5");
    expect(SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT).toContain("required_evidence_act");

  });

  it("materializes catalog selections", () => {
    const sourceInterpretation = interpretation();
    expect(sourceInterpretation.normalizer_version).toBe("source-semantic-normalizer-v5");
    const sourceInterpretationId = sourceSemanticInterpretationIdentity(sourceInterpretation, semanticSha256);
    const admitted = canonicalQuery(EXISTENTIAL, existentialBody());
    const selected = proposeCorrespondenceSemantics({ original_query: EXISTENTIAL,
      admitted_query_semantics: admitted, source_interpretation_descriptors: [{ source_interpretation_id: sourceInterpretationId, interpretation: sourceInterpretation }],
      producer_id: "correspondence-producer", producer_version: "1"
    });
    const predicate = selected.request.catalog?.query_endpoints.find((row) => row.kind === "predicate");
    const frame = selected.request.catalog?.source_endpoints.find((row) => row.kind === "frame");
    const sourceFrame = sourceInterpretation.frames.find((row) => row.predicate_support.reading === "accession");
    const predicateMention = sourceFrame?.predicate_support.kind === "explicit"
      ? sourceFrame.predicate_support.mentions[0] : undefined;
    expect(predicate).toBeDefined();
    expect(frame).toBeDefined();
    expect(predicateMention).toBeDefined();
    const received = proposeCorrespondenceSemantics({ original_query: EXISTENTIAL,
      admitted_query_semantics: admitted, source_interpretation_descriptors: [{ source_interpretation_id: sourceInterpretationId, interpretation: sourceInterpretation }],
      producer_id: "correspondence-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-correspondence-response-v3",
        outcome: { status: "interpreted", gaps: [] },
        semantic_correspondence: {
          contract: "source-semantic-correspondence-selection-v2", source_interpretation_handle: "source1",
          selections: [{
            query: predicate!.handle, source: frame!.handle, query_excerpt: "accessioned",
            source_semantic_support: [{ kind: "lexical", mentions: [predicateMention] }]
          }]
        }
      })
    });
    expect(received.outcome.status).toBe("interpreted");
    expect(received.semantic_correspondence?.correspondences[0]?.query_endpoint).toEqual({
      kind: "predicate", alternative: 0, frame: "qAccession"
    });
    expect(received.semantic_correspondence?.correspondences[0]?.source_endpoint).toEqual({
      kind: "frame", frame: sourceFrame!.id
    });
    expect(received.semantic_correspondence?.correspondences[0]?.source_semantic_support).toEqual([
      { kind: "lexical", mentions: [predicateMention] }
    ]);

  });

  it("rejects a graph producer envelope on the default meaning request", () => {
    const query = proposeQuerySemantics({
      original_query: EXISTENTIAL, producer_id: "query-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-query-response-v2", outcome: { status: "interpreted", gaps: [] },
        query: existentialBody()
      })
    });
    expect(query.request.contract).toBe("source-semantic-query-request-v9");
    expect(query.outcome.status).toBe("invalid");
    expect(query.query).toBeUndefined();

    const sourceInterpretation = interpretation();
    const semantic_correspondence = proposeCorrespondenceSemantics({ original_query: EXISTENTIAL,
      admitted_query_semantics: canonicalQuery(EXISTENTIAL, existentialBody()),
      source_interpretation_descriptors: [{ source_interpretation_id: sourceSemanticInterpretationIdentity(sourceInterpretation, semanticSha256), interpretation: sourceInterpretation }],
      producer_id: "correspondence-producer", producer_version: "1"
    }, {
      rawJson: JSON.stringify({
        contract: "source-semantic-correspondence-response-v2", outcome: { status: "interpreted", gaps: [] },
        semantic_correspondence: { correspondences: [] }
      })
    });
    expect(semantic_correspondence.request.contract).toBe("source-semantic-correspondence-request-v6");
    expect(semantic_correspondence.outcome.status).toBe("invalid");
    expect(semantic_correspondence.semantic_correspondence).toBeUndefined();
  });
});
