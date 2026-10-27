import { describe, expect, it } from "vitest";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, QueryInterpretationProposalSchema } from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery, digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { QueryProposalProducerRegistry, queryProposalProducerRecord } from "../../../../recall/conditional-field/query/query-proposal-producer-registry.js";
import { defaultBudget, defaultView, SNAPSHOT_ID, INTERPRETATION_CLOCK } from "../reference/deployment.fixture.js";
import { decodeSourceFilters } from "../../../../recall/conditional-field/query/ordinary-language.js";

const text = "Which event did I attend last week?";
const proposal = QueryInterpretationProposalSchema.parse({ schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  original_query_digest: digestOriginalQuery(text), question_time: { interpretation_clock: INTERPRETATION_CLOCK,
    intervals: [{ start: "2026-08-30", end: "2026-09-05" }] } });
const request = { source: "ordinary" as const, text, interpretation_clock: INTERPRETATION_CLOCK,
  snapshot_id: SNAPSHOT_ID, budget: defaultBudget(), view: { ...defaultView(), enumeration_policy: "native_query" as const } };

describe("question-time proposal admission", () => {
  it("retains a soft hypothesis independently of hard public source filters", () => {
    const interpreted = compileConditionalFieldQuery({ ...request, interpretation_proposal: proposal,
      since: "2026-01-01T00:00:00.000Z", until: "2026-12-31T23:59:59.999Z" });
    expect(interpreted.status).toBe("partial");
    expect(interpreted.program.kind).toBe("epsilon");
    expect(interpreted.interpretation_proposal?.question_time).toEqual(proposal.question_time);
    expect(decodeSourceFilters(interpreted.source_guard?.predicate_name)).toEqual({
      since: "2026-01-01T00:00:00.000Z", until: "2026-12-31T23:59:59.999Z"
    });
    const soft = compileConditionalFieldQuery({ ...request, interpretation_proposal: proposal });
    expect(soft.source_guard).toBeUndefined();
    expect(soft.time_window).toBeUndefined();
    expect(soft.query_id).not.toBe(compileConditionalFieldQuery(request).query_id);
  });
  it("rejects stale clocks and wrong original-query binding", () => {
    expect(compileConditionalFieldQuery({ ...request, interpretation_proposal: proposal,
      interpretation_clock: "2026-09-07T00:00:00.000Z" }).status).toBe("malformed");
    expect(compileConditionalFieldQuery({ ...request, text: "another query", interpretation_proposal: proposal }).status).toBe("malformed");
  });
  it("does not grant the time producer unrelated grammar or guards", () => {
    for (const extra of [{ program: { schema_version: 1 as const, kind: "epsilon" as const } },
      { conditions: [{ schema_version: 1 as const, kind: "query_predicate" as const }] }]) {
      expect(compileConditionalFieldQuery({ ...request, interpretation_proposal: { ...proposal, ...extra } }).status).toBe("unsupported");
    }
    const registry = new QueryProposalProducerRegistry([queryProposalProducerRecord(QUESTION_TIME_PROPOSAL_PRODUCER_ID,
      { capabilities: ["program"], allowed_grammar: ["epsilon"] })]);
    expect(compileConditionalFieldQuery({ ...request, interpretation_proposal: proposal, proposal_registry: registry }).status).toBe("unsupported");
  });
});
