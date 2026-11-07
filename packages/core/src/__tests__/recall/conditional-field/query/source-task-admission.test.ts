import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import { SOURCE_TASK_OBSERVATION_PRODUCER_ID, QUESTION_TIME_PROPOSAL_PRODUCER_ID } from "@do-soul/alaya-protocol";
import { compileConditionalFieldQuery, digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { defaultBudget, defaultView, SNAPSHOT_ID, INTERPRETATION_CLOCK } from "../reference/deployment.fixture.js";

const text = "What did I repair last Thursday?";
const request = { source: "ordinary" as const, text, interpretation_clock: INTERPRETATION_CLOCK,
  snapshot_id: SNAPSHOT_ID, budget: defaultBudget(), view: { ...defaultView(), enumeration_policy: "native_query" as const } };
const proposal = { schema_version: 1 as const, producer_id: SOURCE_TASK_OBSERVATION_PRODUCER_ID,
  original_query_digest: digestOriginalQuery(text), question_time: { interpretation_clock: INTERPRETATION_CLOCK, intervals: [] },
  source_task_observation: { status: "ready", interpretation_clock: INTERPRETATION_CLOCK, observations: [] } };

it("records an optional binding failure and retains raw eligibility without rebinding the question-time hypothesis", () => {
  for (const [bad, reason] of [
    [{ ...proposal, original_query_digest: digestOriginalQuery("different") }, "original_query_mismatch"],
    [{ ...proposal, question_time: { ...proposal.question_time, interpretation_clock: "2020-01-01T00:00:00.000Z" } },
      "question_time_clock_mismatch"]
  ] as const) {
    const result = compileConditionalFieldQuery({ ...request, interpretation_proposal: bad });
    expect(result.status).toBe("partial");
    expect(result.interpretation_proposal?.question_time).toBeUndefined();
    expect(result.interpretation_proposal?.original_query_digest).toBe(digestOriginalQuery(text));
    expect(result.interpretation_proposal?.source_task_observation).toEqual({ status: "failed", reason });
    expect(result.program.kind).toBe("epsilon");
  }
});

it("never drops an explicit program or reinterprets another producer's invalid question binding", () => {
  const badDigest = digestOriginalQuery("different");
  expect(compileConditionalFieldQuery({ ...request, interpretation_proposal: { ...proposal,
    original_query_digest: badDigest, program: { schema_version: 1, kind: "epsilon" } } }).status).toBe("malformed");
  expect(compileConditionalFieldQuery({ ...request, interpretation_proposal: { ...proposal,
    producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID, original_query_digest: badDigest,
    source_task_observation: undefined } }).status).toBe("malformed");
});
