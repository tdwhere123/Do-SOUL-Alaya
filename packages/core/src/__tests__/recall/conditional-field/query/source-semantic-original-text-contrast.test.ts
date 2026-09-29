import { describe, expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, encodeSourceSemanticQueryCarrier,
  type SourceSemanticQuery, type SourceSemanticQueryMeaningBody
} from "@do-soul/alaya-protocol";
import { buildSourceSemanticRequest, proposeQuerySemantics, receiveSourceSemantics } from "@do-soul/alaya-soul";
import { admitSourceSemanticQuery } from "../../../../recall/conditional-field/query/source-semantic-query-admission.js";
import { SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID } from "../../../../recall/conditional-field/query/source-semantic-query-producer-registry.js";
import { projectSourceSemanticQuerySupport } from "../../../../recall/runtime/source-semantic-query-support.js";
import {
  NONCLASS_SOURCE, admitNominalClassCorrespondence, lastQuarterGaps,
  receiveNominalClassInterpretation, reasonNominalClass
} from "./source-semantic-nominal-class-support-fixture.js";

const WIDGET_QUERY = "How many widgets did I buy or sell last quarter?";
const THINGS_QUERY = "How many things did I buy or sell last quarter?";
const OTHER_SPEAKER_SOURCE = "Bob bought widgets and sold widgets last quarter.";
const ONLY_SOURCE = "I only bought widgets last quarter.";
const DENIED_SOURCE = "I did not buy widgets last quarter.";

/** Independent original-text facts; not derived from Q/H/C compiler output. */
const ONLY_FACTS = {
  sourceContainsOnly: ONLY_SOURCE.includes("only"),
  sourceMentionsSell: ONLY_SOURCE.includes("sold") || ONLY_SOURCE.includes(" sell "),
  unrestrictedBuyOrSellLicensed: false
} as const;
const DENIED_FACTS = {
  sourceContainsNegation: DENIED_SOURCE.includes("did not"),
  sourceAssertsBuy: false
} as const;

const temporalGap = (ids: readonly string[]) => ({
  kind: "unsupported_meaning" as const, affected_ids: [...ids],
  support: [{ kind: "query_text" as const, excerpt: "last quarter" }],
  description: "The temporal restriction is not encoded by the retained predicates; no cutoff is invented."
});
const countGap = {
  kind: "aggregate" as const, affected_ids: [] as string[],
  support: [{ kind: "query_text" as const, excerpt: "How many" }],
  description: "The requested count remains an unexecuted operation."
};

function action(key: string, predicate: string, objectExcerpt: string) {
  return {
    kind: "statement" as const, key, predicate,
    arguments: [
      { role: "agent", target: { kind: "reference" as const, key: "speaker" }, excerpt: "I" },
      { role: "theme", target: { kind: "reference" as const, key: "object" }, excerpt: objectExcerpt }
    ]
  };
}

function objectKind(key: string, excerpt: string) {
  return {
    kind: "statement" as const, key, predicate: "is a widget",
    arguments: [{ role: "theme", target: { kind: "reference" as const, key: "object" }, excerpt }]
  };
}

function independentMeaning(objectExcerpt: string, includeClass: boolean): SourceSemanticQueryMeaningBody {
  const buy = action("buy", "buy", objectExcerpt);
  const sell = action("sell", "sell", objectExcerpt);
  return {
    contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    requested_operation: {
      reading: "Count independently contributed buy or sell events.",
      support: { kind: "query_text", excerpt: "How many" }
    },
    entities: [
      { kind: "named", key: "speaker", excerpt: "I" },
      { kind: "free", key: "object", excerpt: objectExcerpt, return: true }
    ],
    alternatives: [{
      conditions: [],
      evidence_inputs: includeClass
        ? [{ conditions: [buy, objectKind("buy_kind", objectExcerpt)] }, { conditions: [sell, objectKind("sell_kind", objectExcerpt)] }]
        : [{ conditions: [buy] }, { conditions: [sell] }]
    }],
    gaps: [temporalGap(["buy", "sell"]), countGap]
  };
}

function sameObjectAndMeaning(): SourceSemanticQueryMeaningBody {
  return {
    ...independentMeaning("widgets", true),
    alternatives: [{
      conditions: [action("buy", "buy", "widgets"), action("sell", "sell", "widgets"), objectKind("kind", "widgets")]
    }]
  };
}

function admittedQuery(original: string, meaning: SourceSemanticQueryMeaningBody) {
  const received = proposeQuerySemantics({
    original_query: original, producer_id: SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID, producer_version: "1"
  }, {
    rawJson: JSON.stringify({
      contract: "source-semantic-query-response-v8",
      outcome: { status: "interpreted" },
      query: encodeSourceSemanticQueryCarrier(meaning)
    })
  });
  expect(received.outcome.status).toBe("interpreted");
  const admission = admitSourceSemanticQuery(received.query, original);
  expect(admission.kind).toBe("admitted");
  if (admission.kind !== "admitted") throw new Error("query must admit");
  return admission.query;
}

function evidenceInputs(query: SourceSemanticQuery, result: ReturnType<typeof reasonNominalClass>) {
  return projectSourceSemanticQuerySupport(query, result.binding_results ?? []);
}

function fieldSupport(original: string, meaning: SourceSemanticQueryMeaningBody, interpretation: ReturnType<typeof receiveNominalClassInterpretation>) {
  const query = admittedQuery(original, meaning);
  const { correspondence, admission } = admitNominalClassCorrespondence({
    interpretation, semantics: query, originalQuery: original
  });
  expect(admission.kind).toBe("admitted");
  const result = reasonNominalClass(interpretation, query, correspondence, original);
  expect(result.outcome.status).toBe("interpreted");
  return { query, result, support: evidenceInputs(query, result) };
}

const atom = (text: string) => ({ assertion_id: 1, text });
const entity = (key: string) => ({ kind: "entity_ref" as const, key });
const content = (key: string) => ({ kind: "content_ref" as const, key });

function receiveAuthored(source: string, contentBody: object) {
  const input = {
    sourceCorpus: source, assertionIds: [1], sourceScope: "complete-source" as const,
    source_id: "original-text-contrast", source_version: "1",
    producer_id: "authored-control", producer_version: "1"
  };
  const received = receiveSourceSemantics(
    JSON.stringify({ contract: "source-semantic-proposal-v8", outcome: { status: "interpreted" }, content: contentBody }),
    buildSourceSemanticRequest(input), input
  );
  expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
  expect(received.interpretation).toBeDefined();
  return received.interpretation!;
}

function buyClassContent(buySupport: string, wrapBuyInNot = false) {
  const buyRoot = wrapBuyInNot ? content("denied") : content("buy");
  return {
    roots: [
      { act: "assertion" as const, expression: buyRoot },
      { act: "assertion" as const, expression: content("boughtKind") }
    ],
    entities: [
      { form: "entity" as const, key: "speaker", mentions: [atom("I")] },
      { form: "entity" as const, key: "bought", mentions: [atom("widgets")] }
    ],
    nodes: [
      ...(wrapBuyInNot
        ? [{ kind: "not" as const, key: "denied", support: atom("did not"), content: content("buy") }]
        : []),
      { kind: "statement" as const, key: "buy",
        predicate: { kind: "explicit" as const, reading: "buy", support: atom(buySupport) },
        arguments: [
          { role: "agent", target: entity("speaker") },
          { role: "theme", target: entity("bought") }
        ], qualifications: [] },
      { kind: "statement" as const, key: "boughtKind",
        predicate: { kind: "implicit" as const, reading: "is a widget", support: atom("widgets") },
        arguments: [{ role: "theme", target: entity("bought") }], qualifications: [] }
    ],
    gaps: [{
      affected: [{ kind: "occurrence_ref" as const, key: "buy" }],
      kind: "unsupported_meaning" as const,
      support: atom("last quarter"),
      description: "The source time window is not encoded as an executable event cutoff."
    }]
  };
}

describe("original-text contrasts through current Q/H/C receive, admission and Field", () => {
  it("binds widget-class evidence on the I/widgets source as a positive control", () => {
    const { query, result, support } = fieldSupport(
      WIDGET_QUERY, independentMeaning("widgets", true), receiveNominalClassInterpretation()
    );
    expect((result.binding_results ?? []).filter(row => row.kind === "evidence").map(row => row.input).sort()).toEqual([0, 1]);
    expect(support.evidence_inputs).toEqual([
      { alternative: 0, input: 0, status: "supported" },
      { alternative: 0, input: 1, status: "supported" }
    ]);
    expect(support.operation).toBe("not_executed");
    expect(query.gaps.map(gap => gap.kind)).toEqual(["unsupported_meaning", "aggregate"]);
    expect(result.binding_results?.every(row => row.query_complete === false)).toBe(true);
  });

  it("does not treat hammer and mallet as widgets, and still binds them as things without a class premise", () => {
    const nonclass = receiveNominalClassInterpretation({ source: NONCLASS_SOURCE, includeClass: false });
    expect(nonclass.mentions.some(row => row.text === "widgets")).toBe(false);
    const widget = fieldSupport(WIDGET_QUERY, independentMeaning("widgets", true), nonclass);
    expect(widget.support.evidence_inputs).toEqual([
      { alternative: 0, input: 0, status: "open" },
      { alternative: 0, input: 1, status: "open" }
    ]);
    const things = fieldSupport(THINGS_QUERY, independentMeaning("things", false), nonclass);
    expect(things.support.evidence_inputs).toEqual([
      { alternative: 0, input: 0, status: "supported" },
      { alternative: 0, input: 1, status: "supported" }
    ]);
    expect(things.support.operation).toBe("not_executed");
  });

  it("binds named I on the I source and does not bind Bob without equating the participants", () => {
    const self = fieldSupport(WIDGET_QUERY, independentMeaning("widgets", true), receiveNominalClassInterpretation());
    expect(self.support.evidence_inputs.map(row => row.status)).toEqual(["supported", "supported"]);
    const other = receiveNominalClassInterpretation({ source: OTHER_SPEAKER_SOURCE, speakerText: "Bob" });
    expect(other.mentions.some(row => row.text === "I")).toBe(false);
    expect(other.mentions.some(row => row.text === "Bob")).toBe(true);
    const mismatched = fieldSupport(WIDGET_QUERY, independentMeaning("widgets", true), other);
    expect(mismatched.support.evidence_inputs.map(row => row.status)).toEqual(["open", "open"]);
  });

  it("lets independent buy or sell contribute separately and requires the same object for AND", () => {
    const interpretation = receiveNominalClassInterpretation();
    const independent = fieldSupport(WIDGET_QUERY, independentMeaning("widgets", true), interpretation);
    expect(independent.support.evidence_inputs.map(row => row.status)).toEqual(["supported", "supported"]);
    const joined = fieldSupport(WIDGET_QUERY, sameObjectAndMeaning(), interpretation);
    expect(joined.result.binding_results ?? []).toEqual([]);
    expect(joined.support.answer).toBe("open");
    expect(joined.support.operation).toBe("not_executed");
  });

  it("keeps independent supports when the time gap is attached and when an unrelated residual gap is added", () => {
    const attachedH = receiveNominalClassInterpretation();
    expect(lastQuarterGaps(attachedH)).toHaveLength(1);
    const attached = fieldSupport(WIDGET_QUERY, independentMeaning("widgets", true), attachedH);
    expect(attached.support.evidence_inputs.map(row => row.status)).toEqual(["supported", "supported"]);
    const residual = receiveNominalClassInterpretation({
      extraGaps: [{
        affectedKeys: [],
        supportText: "and",
        description: "Connective text is unused residual, not an event qualification."
      }]
    });
    expect(lastQuarterGaps(residual)).toHaveLength(1);
    expect(residual.gaps.length).toBeGreaterThan(1);
    const unrelated = fieldSupport(WIDGET_QUERY, independentMeaning("widgets", true), residual);
    expect(unrelated.support.evidence_inputs.map(row => row.status)).toEqual(["supported", "supported"]);
    expect(unrelated.support.operation).toBe("not_executed");
  });

  it("admits a buy reading that dropped same-sentence only without treating that as original-text fidelity", () => {
    expect(ONLY_FACTS.sourceContainsOnly).toBe(true);
    expect(ONLY_FACTS.sourceMentionsSell).toBe(false);
    expect(ONLY_FACTS.unrestrictedBuyOrSellLicensed).toBe(false);
    const interpretation = receiveAuthored(ONLY_SOURCE, buyClassContent("bought"));
    expect(interpretation.mentions.some(row => row.text === "only")).toBe(false);
    expect(interpretation.gaps.some(row => JSON.stringify(row).includes("only"))).toBe(false);
    expect(lastQuarterGaps(interpretation)).toHaveLength(1);
    const { query, result, support } = fieldSupport(WIDGET_QUERY, independentMeaning("widgets", true), interpretation);
    expect(support.evidence_inputs).toEqual([
      { alternative: 0, input: 0, status: "supported" },
      { alternative: 0, input: 1, status: "open" }
    ]);
    expect(support.operation).toBe("not_executed");
    expect(query.gaps.map(gap => gap.kind)).toEqual(["unsupported_meaning", "aggregate"]);
    expect(result.binding_results?.every(row => row.query_complete === false)).toBe(true);
    // Known limit: located H time gaps do not block the admitted buy support, and that support is not original-question proof.
    expect(ONLY_FACTS.unrestrictedBuyOrSellLicensed).toBe(false);
  });

  it("distinguishes a faithful denial from a dropped-not assertion against original-text facts", () => {
    expect(DENIED_FACTS.sourceContainsNegation).toBe(true);
    expect(DENIED_FACTS.sourceAssertsBuy).toBe(false);
    const faithful = receiveAuthored(DENIED_SOURCE, buyClassContent("buy", true));
    expect(faithful.operators.some(row => row.operator === "not")).toBe(true);
    expect(faithful.asserted_at_scope).not.toEqual(expect.arrayContaining(
      faithful.frames.filter(row => row.predicate_support.reading === "buy").map(row => row.id)
    ));
    const faithfulField = fieldSupport(WIDGET_QUERY, independentMeaning("widgets", true), faithful);
    expect(faithfulField.support.evidence_inputs.map(row => row.status)).toEqual(["open", "open"]);

    const faulty = receiveAuthored(DENIED_SOURCE, buyClassContent("buy"));
    expect(faulty.operators).toEqual([]);
    expect(faulty.mentions.some(row => row.text === "did not" || row.text === "not")).toBe(false);
    const faultyField = fieldSupport(WIDGET_QUERY, independentMeaning("widgets", true), faulty);
    expect(faultyField.support.evidence_inputs).toEqual([
      { alternative: 0, input: 0, status: "supported" },
      { alternative: 0, input: 1, status: "open" }
    ]);
    expect(faultyField.support.operation).toBe("not_executed");
    expect(DENIED_FACTS.sourceAssertsBuy).toBe(false);
  });
});
