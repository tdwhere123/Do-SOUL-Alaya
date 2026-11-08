import { describe, expect, it } from "vitest";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, SOURCE_TASK_OBSERVATION_PRODUCER_ID, SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID,
  QueryInterpretationProposalSchema, type EvidenceCondition } from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery, digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { defaultBudget, defaultView, SNAPSHOT_ID, INTERPRETATION_CLOCK } from "../reference/deployment.fixture.js";

const text = "Which game did I beat with Rachel last weekend?";
const conditions: EvidenceCondition[] = [{ statement: "I finally beat <game> with Rachel last weekend.", speaker: "user", anchors: ["Rachel"] }];
const proposal = QueryInterpretationProposalSchema.parse({ schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  original_query_digest: digestOriginalQuery(text), evidence_conditions: conditions });
const request = { source: "ordinary" as const, text, interpretation_clock: INTERPRETATION_CLOCK,
  snapshot_id: SNAPSHOT_ID, budget: defaultBudget(), view: { ...defaultView(), enumeration_policy: "native_query" as const } };
const compile = (interpretation_proposal = proposal) => compileConditionalFieldQuery({ ...request, interpretation_proposal });
const condition = (statement = "x", speaker = "user", anchors: unknown = []) => ({ statement, speaker, anchors });

describe("evidence condition proposal authority", () => {
  it("bounds condition count, statement length, speaker and anchors at the public schema", () => {
    const parse = (evidence_conditions: unknown) => QueryInterpretationProposalSchema.safeParse({ ...proposal, evidence_conditions }).success;
    expect(parse(Array(4).fill(condition("x".repeat(512), "assistant", Array(8).fill("a".repeat(256)))))).toBe(true);
    for (const invalid of [[], Array(5).fill(condition()), [condition("x".repeat(513))], [condition("")],
      [condition("x", "either")], [condition("x", "user", Array(9).fill("a"))], [condition("x", "user", [""])],
      [condition("x", "user", [" Rachel"])], [condition("x", "user", ["a".repeat(257)])], [{ ...condition(), value_type: "item" }]]) {
      expect(parse(invalid)).toBe(false);
    }
  });

  it("admits conditions from question-formed producers only and binds them into query identity", () => {
    const admitted = compile();
    expect(admitted.status).toBe("partial");
    expect(admitted.interpretation_proposal?.evidence_conditions).toEqual(conditions);
    expect(compile({ ...proposal, producer_id: SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID }).status).toBe("partial");
    for (const changed of [{ ...conditions[0]!, statement: "I beat <game> with Rachel last month." },
      { ...conditions[0]!, speaker: "assistant" as const }, { ...conditions[0]!, anchors: [] }]) {
      expect(compile({ ...proposal, evidence_conditions: [changed] }).query_id).not.toBe(admitted.query_id);
    }
    expect(compile({ ...proposal, producer_id: SOURCE_TASK_OBSERVATION_PRODUCER_ID }).status).toBe("unsupported");
    expect(compile({ ...proposal, original_query_digest: digestOriginalQuery("different query") }).status).toBe("malformed");
  });

  it("rejects an anchor that is not copied verbatim from the question", () => {
    for (const anchors of [["rachel"], ["Rachel's"], ["Monica"]]) {
      expect(compile({ ...proposal, evidence_conditions: [{ ...conditions[0]!, anchors }] }).status).toBe("malformed");
    }
  });

  it("keeps absent conditions out of existing producer identity material", () => {
    const { evidence_conditions: _conditions, ...absent } = proposal;
    expect(compile(absent).query_id).toBe(compile({ ...absent, evidence_conditions: undefined }).query_id);
    expect(compile(absent).interpretation_proposal).not.toHaveProperty("evidence_conditions");
  });
});
