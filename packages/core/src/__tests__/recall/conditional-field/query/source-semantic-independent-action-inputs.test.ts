import { describe, expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  SourceSemanticResourceLedger, encodeSourceSemanticQueryCarrier, sourceSemanticQueryBranchViews, projectSourceSemanticQuerySupport,
  type SourceSemanticCorrespondence, type SourceSemanticQueryMeaningBody
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, proposeQuerySemantics
} from "@do-soul/alaya-soul";
import { admitSourceSemanticQuery } from "../../../../recall/conditional-field/query/source-semantic-query-admission.js";
import { SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID } from "../../../../recall/conditional-field/query/source-semantic-query-producer-registry.js";
import { planSourceSemanticBranches } from "../../../../recall/runtime/source-semantic-branch-plan.js";
import {
  CLASS_SOURCE, NONCLASS_SOURCE, admitNominalClassCorrespondence, actionFrameIds, classSourceTexts,
  lastQuarterGaps, receiveNominalClassInterpretation, reasonNominalClass
} from "./source-semantic-nominal-class-support-fixture.js";

const ORIGINAL = "How many widgets did I buy or sell last quarter?";
const PRODUCER = { original_query: ORIGINAL, producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID, producer_version: "1" };

function action(key: string, predicate: string) {
  return {
    kind: "statement" as const, key, predicate,
    arguments: [
      { role: "agent", target: { kind: "reference" as const, key: "speaker" }, excerpt: "I" },
      { role: "theme", target: { kind: "reference" as const, key: "object" }, excerpt: "widgets" }
    ]
  };
}

function objectKind(key: string) {
  return {
    kind: "statement" as const, key, predicate: "is a widget",
    arguments: [{ role: "theme", target: { kind: "reference" as const, key: "object" }, excerpt: "widgets" }]
  };
}

const temporalGap = {
  kind: "unsupported_meaning" as const, affected_ids: ["buy", "sell"],
  support: [{ kind: "query_text" as const, excerpt: "last quarter" }],
  description: "The temporal restriction is not encoded by the retained predicates; no cutoff is invented."
};
const countGap = {
  kind: "aggregate" as const, affected_ids: [] as string[],
  support: [{ kind: "query_text" as const, excerpt: "How many" }],
  description: "The requested count remains an unexecuted operation."
};

function independentMeaning(): SourceSemanticQueryMeaningBody {
  return {
    contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    requested_operation: {
      reading: "Count widgets across independently contributed buy or sell events.",
      support: { kind: "query_text", excerpt: "How many" }
    },
    entities: [
      { kind: "named", key: "speaker", excerpt: "I" },
      { kind: "free", key: "object", excerpt: "widgets", return: true }
    ],
    alternatives: [{
      conditions: [],
      evidence_inputs: [
        { conditions: [action("buy", "buy"), objectKind("buy_kind")] },
        { conditions: [action("sell", "sell"), objectKind("sell_kind")] }
      ]
    }],
    gaps: [temporalGap, countGap]
  };
}

function receive(query: unknown) {
  return proposeQuerySemantics(PRODUCER, {
    rawJson: JSON.stringify({
      contract: "source-semantic-query-response-v8",
      outcome: { status: "interpreted" },
      query
    })
  });
}

function emptyCorrespondence(): SourceSemanticCorrespondence {
  return {
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
    source_interpretation_id: `sha256:${"0".repeat(64)}`,
    query_semantics_id: `sha256:${"0".repeat(64)}`,
    producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID,
    producer_version: "1",
    contract_version: SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
    correspondences: []
  };
}

describe("independent action inputs through query receive and branch planning", () => {
  it("admits semantic-key gap targets, rejects carrier node tokens, and keeps action inputs independent", () => {
    expect(SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT).toContain("serialization tokens are not gap targets");
    expect(SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT).toContain("Separate alternative input actions instead of joining all actions into the answer");

    const wire = encodeSourceSemanticQueryCarrier(independentMeaning());
    const received = receive(wire);
    expect(received.outcome.status).toBe("interpreted");
    expect(received.query).toBeDefined();

    const nodeTokens = wire.nodes.map(node => node.node);
    expect(nodeTokens.some(token => token === "buy" || token === "sell")).toBe(false);
    const rejected = receive({
      ...wire,
      gaps: [{ ...temporalGap, affected_ids: nodeTokens.slice(0, 2) }]
    });
    expect(rejected.outcome.status).toBe("invalid");
    expect(rejected.query).toBeUndefined();
    expect(JSON.stringify(rejected.outcome)).toMatch(/unknown query gap target/u);

    const admission = admitSourceSemanticQuery(received.query, ORIGINAL);
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") return;
    expect(admission.producer.producer_id).toBe(SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID);
    const query = admission.query;
    expect(query.gaps).toEqual([temporalGap, countGap]);
    expect(query.return_variables).toEqual(["object"]);
    expect(query.variables.find(row => row.id === "speaker")?.reference?.excerpt).toBe("I");
    expect(query.variables.find(row => row.id === "object")?.reference).toBeUndefined();

    const alternative = query.alternatives[0]!;
    expect(alternative.answer_frames).toEqual([]);
    expect(alternative.evidence_inputs).toEqual([
      { frames: ["buy", "buy_kind"] }, { frames: ["sell", "sell_kind"] }
    ]);
    expect(query.alternatives[0]!.frames.find(frame => frame.id === "buy_kind")).toMatchObject({
      predicate_reading: "is a widget",
      role_requirements: [{ role_reading: "theme", target_variable: "object" }]
    });
    expect(query.alternatives[0]!.frames.find(frame => frame.id === "sell_kind")).toMatchObject({
      predicate_reading: "is a widget",
      role_requirements: [{ role_reading: "theme", target_variable: "object" }]
    });

    const views = sourceSemanticQueryBranchViews(alternative);
    expect(views.map(view => [view.target, view.alternative.frames.map(frame => frame.id)])).toEqual([
      [{ kind: "answer" }, []],
      [{ kind: "evidence", input: 0 }, ["buy", "buy_kind"]],
      [{ kind: "evidence", input: 1 }, ["sell", "sell_kind"]]
    ]);

    const plans = planSourceSemanticBranches(query, emptyCorrespondence(), new SourceSemanticResourceLedger({
      work_units: 200000, memory_bytes: 20000000
    }));
    expect(plans.map(plan => [plan.target, plan.view.frames.map(frame => frame.id), [...plan.returnedVariables]])).toEqual([
      [{ kind: "evidence", input: 0 }, ["buy", "buy_kind"], ["object"]],
      [{ kind: "evidence", input: 1 }, ["sell", "sell_kind"], ["object"]]
    ]);

    const support = projectSourceSemanticQuerySupport(query, []);
    expect(support.answer).toBe("unrepresented");
    expect(support.evidence_inputs).toEqual([
      { alternative: 0, input: 0, status: "open" },
      { alternative: 0, input: 1, status: "open" }
    ]);
    expect(support.operation).toBe("not_executed");
    expect(query.gaps.map(gap => gap.kind)).toEqual(["unsupported_meaning", "aggregate"]);

    const conjunction = receive(encodeSourceSemanticQueryCarrier({
      ...independentMeaning(),
      alternatives: [{ conditions: [action("buy", "buy"), action("sell", "sell")] }]
    }));
    expect(conjunction.outcome.status).toBe("interpreted");
    const joined = conjunction.query!.alternatives[0]!;
    expect(joined.evidence_inputs).toBeUndefined();
    expect(sourceSemanticQueryBranchViews(joined).map(view => view.alternative.frames.map(frame => frame.id)))
      .toEqual([["buy", "sell"]]);
  });
});

function admittedIndependentQuery(meaning = independentMeaning()) {
  const received = receive(encodeSourceSemanticQueryCarrier(meaning));
  expect(received.outcome.status).toBe("interpreted");
  const admission = admitSourceSemanticQuery(received.query, ORIGINAL);
  expect(admission.kind).toBe("admitted");
  if (admission.kind !== "admitted") throw new Error("independent query must admit");
  return admission.query;
}

function evidenceBindings(result: ReturnType<typeof reasonNominalClass>) {
  return (result.binding_results ?? []).filter(row => row.kind === "evidence");
}

describe("independent action class evidence through native Q/H/C and Field", () => {
  it("binds each action branch when implicit class H has same-object C and retains class source support", () => {
    const query = admittedIndependentQuery();
    expect(query.variables.find(row => row.id === "speaker")?.reference?.excerpt).toBe("I");
    expect(query.variables.find(row => row.id === "object")?.reference).toBeUndefined();
    const interpretation = receiveNominalClassInterpretation({ source: CLASS_SOURCE });
    const classFrames = interpretation.frames.filter(row => row.predicate_support.reading === "is a widget");
    expect(classFrames).toHaveLength(2);
    expect(classFrames.every(row => row.predicate_support.kind === "implicit")).toBe(true);
    expect(JSON.stringify(interpretation.frames.map(row => row.predicate_support))).not.toMatch(/this is a (?:tool|widget)/u);
    const timeGaps = lastQuarterGaps(interpretation);
    expect(timeGaps).toHaveLength(1);
    expect(timeGaps[0]!.affected_ids).toEqual(expect.arrayContaining([...actionFrameIds(interpretation)]));
    expect(timeGaps[0]!.affected_ids).toEqual(expect.not.arrayContaining(classFrames.map(row => row.id)));

    const { correspondence, admission } = admitNominalClassCorrespondence({
      interpretation, semantics: query, originalQuery: ORIGINAL
    });
    expect(admission.kind).toBe("admitted");
    const result = reasonNominalClass(interpretation, query, correspondence, ORIGINAL);
    expect(result.outcome.status).toBe("interpreted");
    const evidence = evidenceBindings(result);
    expect(evidence.map(row => row.input).sort()).toEqual([0, 1]);
    for (const binding of evidence) {
      const classVariable = binding.input === 0 ? "buy_kind" : "sell_kind";
      expect(classSourceTexts(interpretation, binding.bindings[classVariable]?.node_id)).toEqual(["widgets"]);
      expect(binding.returned.object?.node_id).toBeDefined();
      expect(binding.query_complete).toBe(false);
    }
    const support = projectSourceSemanticQuerySupport(query, result.binding_results ?? []);
    expect(support.operation).toBe("not_executed");
    expect(support.evidence_inputs).toEqual([
      { alternative: 0, input: 0, status: "supported" },
      { alternative: 0, input: 1, status: "supported" }
    ]);
    expect(query.gaps.map(gap => gap.kind)).toEqual(["unsupported_meaning", "aggregate"]);
    // Located H time gaps do not block evidence-input supported; that is not original-question proof.
    expect(timeGaps).not.toEqual([]);
  });

  it("does not qualify a binding when class correspondence is omitted", () => {
    const query = admittedIndependentQuery();
    const interpretation = receiveNominalClassInterpretation();
    const { correspondence, admission } = admitNominalClassCorrespondence({
      interpretation, semantics: query, originalQuery: ORIGINAL, includeClass: false
    });
    expect(admission.kind).toBe("admitted");
    const result = reasonNominalClass(interpretation, query, correspondence, ORIGINAL);
    expect(result.outcome.status).toBe("interpreted");
    expect(evidenceBindings(result)).toEqual([]);
    expect(projectSourceSemanticQuerySupport(query, result.binding_results ?? [])).toMatchObject({
      operation: "not_executed",
      evidence_inputs: [
        { alternative: 0, input: 0, status: "open" },
        { alternative: 0, input: 1, status: "open" }
      ]
    });
  });

  it("does not qualify a binding when class H is attached to a different object", () => {
    const query = admittedIndependentQuery();
    const interpretation = receiveNominalClassInterpretation({ classOnSameObject: false });
    const { correspondence, admission } = admitNominalClassCorrespondence({
      interpretation, semantics: query, originalQuery: ORIGINAL, classOnSameObject: false
    });
    expect(admission.kind).toBe("admitted");
    const result = reasonNominalClass(interpretation, query, correspondence, ORIGINAL);
    expect(result.outcome.status).toBe("interpreted");
    expect(evidenceBindings(result)).toEqual([]);
  });

  it("does not treat hammer and mallet mentions as widget-class evidence", () => {
    const query = admittedIndependentQuery();
    const interpretation = receiveNominalClassInterpretation({ source: NONCLASS_SOURCE, includeClass: false });
    expect(interpretation.frames.some(row => row.predicate_support.reading === "is a widget")).toBe(false);
    expect(interpretation.mentions.some(row => row.text === "hammer" || row.text === "mallet")).toBe(true);
    expect(interpretation.mentions.some(row => row.text === "widgets")).toBe(false);
    expect(lastQuarterGaps(interpretation)[0]!.affected_ids).toEqual(expect.arrayContaining([...actionFrameIds(interpretation)]));
    const { correspondence, admission } = admitNominalClassCorrespondence({
      interpretation, semantics: query, originalQuery: ORIGINAL, includeClass: false
    });
    expect(admission.kind).toBe("admitted");
    const result = reasonNominalClass(interpretation, query, correspondence, ORIGINAL);
    expect(result.outcome.status).toBe("interpreted");
    expect(evidenceBindings(result)).toEqual([]);
  });

  it("leaves directional entailment correspondence unusable instead of forging a taxonomy", () => {
    const query = admittedIndependentQuery();
    const interpretation = receiveNominalClassInterpretation();
    const { correspondence } = admitNominalClassCorrespondence({
      interpretation, semantics: query, originalQuery: ORIGINAL
    });
    const { admission } = admitNominalClassCorrespondence({
      interpretation, semantics: query, originalQuery: ORIGINAL,
      correspondence: {
        ...correspondence,
        correspondences: correspondence.correspondences.map(row => ({ ...row, relation: "entailment" }))
      } as unknown as SourceSemanticCorrespondence
    });
    expect(admission.kind).toBe("invalid");
  });

  it("does not treat a free-variable key or excerpt as a class restriction", () => {
    const query = admittedIndependentQuery({
      ...independentMeaning(),
      alternatives: [{ conditions: [], evidence_inputs: [
        { conditions: [action("buy", "buy")] },
        { conditions: [action("sell", "sell")] }
      ] }]
    });
    expect(query.alternatives[0]!.frames.some(frame => frame.predicate_reading === "is a widget")).toBe(false);
    expect(query.alternatives[0]!.frames.find(frame => frame.id === "buy")?.role_requirements)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role_reading: "theme", target_variable: "object", support: { kind: "query_text", excerpt: "widgets" } })
      ]));
    expect(query.variables.find(row => row.id === "speaker")?.reference?.excerpt).toBe("I");
    expect(query.variables.find(row => row.id === "object")?.reference).toBeUndefined();
    expect(query.gaps.map(gap => gap.kind)).toEqual(["unsupported_meaning", "aggregate"]);
  });
});
