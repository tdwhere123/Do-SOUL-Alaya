import { describe, expect, it } from "vitest";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, SOURCE_TASK_OBSERVATION_PRODUCER_ID, SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID,
  QueryInterpretationProposalSchema } from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery, digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { defaultBudget, defaultView, SNAPSHOT_ID, INTERPRETATION_CLOCK } from "../reference/deployment.fixture.js";

const text = "Which game did I beat last weekend?";
const statements = ["I finally beat <game> last weekend."];
const proposal = QueryInterpretationProposalSchema.parse({ schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  original_query_digest: digestOriginalQuery(text), evidence_statements: statements });
const request = { source: "ordinary" as const, text, interpretation_clock: INTERPRETATION_CLOCK,
  snapshot_id: SNAPSHOT_ID, budget: defaultBudget(), view: { ...defaultView(), enumeration_policy: "native_query" as const } };
const compile = (interpretation_proposal = proposal) => compileConditionalFieldQuery({ ...request, interpretation_proposal });

describe("evidence statement proposal authority", () => {
  it("bounds statement count and length at the public schema", () => {
    const parse = (evidence_statements: unknown) => QueryInterpretationProposalSchema.safeParse({ ...proposal, evidence_statements }).success;
    expect(parse(Array(4).fill("x".repeat(512)))).toBe(true);
    for (const invalid of [[], Array(5).fill("x"), ["x".repeat(513)], [""]]) expect(parse(invalid)).toBe(false);
  });

  it("admits statements from question-formed producers only and binds them into query identity", () => {
    const admitted = compile();
    expect(admitted.status).toBe("partial");
    expect(admitted.interpretation_proposal?.evidence_statements).toEqual(statements);
    expect(compile({ ...proposal, producer_id: SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID }).status).toBe("partial");
    expect(compile({ ...proposal, evidence_statements: ["I beat <game> last month."] }).query_id).not.toBe(admitted.query_id);
    expect(compile({ ...proposal, producer_id: SOURCE_TASK_OBSERVATION_PRODUCER_ID }).status).toBe("unsupported");
    expect(compile({ ...proposal, original_query_digest: digestOriginalQuery("different query") }).status).toBe("malformed");
  });

  it("keeps absent statements out of existing producer identity material", () => {
    const { evidence_statements: _statements, ...absent } = proposal;
    expect(compile(absent).query_id).toBe(compile({ ...absent, evidence_statements: undefined }).query_id);
    expect(compile(absent).interpretation_proposal).not.toHaveProperty("evidence_statements");
  });
});
