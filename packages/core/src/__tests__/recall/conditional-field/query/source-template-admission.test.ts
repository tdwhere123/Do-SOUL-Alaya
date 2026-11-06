import { describe, expect, it } from "vitest";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID,
  QueryInterpretationProposalSchema } from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery, digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { defaultBudget, defaultView, SNAPSHOT_ID, INTERPRETATION_CLOCK } from "../reference/deployment.fixture.js";

const text = "Which game did I beat last weekend?";
const proposal = QueryInterpretationProposalSchema.parse({ schema_version: 1, producer_id: SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID,
  original_query_digest: digestOriginalQuery(text), source_template: { interpretation_clock: INTERPRETATION_CLOCK,
    asked_speaker: "user", evidence_statements: ["I finally beat <game> last weekend."] } });
const request = { source: "ordinary" as const, text, interpretation_clock: INTERPRETATION_CLOCK,
  snapshot_id: SNAPSHOT_ID, budget: defaultBudget(), view: { ...defaultView(), enumeration_policy: "native_query" as const } };
const compile = (interpretation_proposal = proposal) => compileConditionalFieldQuery({ ...request, interpretation_proposal });

describe("source-template proposal authority", () => {
  it("admits only explicit producer capability and binds template material into identity", () => {
    const admitted = compile();
    expect(admitted.status).toBe("partial");
    expect(admitted.interpretation_proposal?.source_template).toEqual(proposal.source_template);
    for (const source_template of [ { ...proposal.source_template!, asked_speaker: "assistant" as const },
      { ...proposal.source_template!, evidence_statements: ["I finally beat <game> last month."] } ]) {
      expect(compile({ ...proposal, source_template }).query_id).not.toBe(admitted.query_id);
    }
    const rejected = compile({ ...proposal, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID });
    expect(rejected.status).toBe("unsupported");
    expect(rejected.interpretation_proposal?.source_template).toEqual(proposal.source_template);
    expect(compile({ ...proposal, program: { schema_version: 1, kind: "epsilon" } }).status).toBe("unsupported");
  });
  it("rejects wrong query and clock bindings while preserving ordinary eligibility", () => {
    expect(compile({ ...proposal, original_query_digest: digestOriginalQuery("different query") }).status).toBe("malformed");
    expect(compile({ ...proposal, source_template: { ...proposal.source_template!,
      interpretation_clock: "2020-01-01T00:00:00.000Z" } }).status).toBe("malformed");
    expect(compile().source_guard).toBeUndefined();
  });
  it("keeps an absent template out of existing producer identity material", () => {
    const { source_template: _template, ...absent } = proposal;
    expect(compile(absent).query_id).toBe(compile({ ...absent, source_template: undefined }).query_id);
    expect(compile(absent).interpretation_proposal).not.toHaveProperty("source_template");
  });
});
