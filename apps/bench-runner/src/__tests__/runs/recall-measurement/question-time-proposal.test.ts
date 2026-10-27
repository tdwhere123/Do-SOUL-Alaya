import { describe, expect, it } from "vitest";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID } from "@do-soul/alaya-protocol";
import { questionTimeProposalFromCoordinates } from "../../../runs/recall-measurement/ordinary/question-time-proposal.js";
import { buildOrdinaryRecallRequest } from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";

const query = "What happened last week?", clock = "2026-09-07T00:00:00.000Z";
const window = { status: "formed", coordinates: { time: { kind: "window", alternatives: [
  { start: "2026-08-31", end: "2026-09-06", reading: "preceding calendar week" },
  { start: "2026-08-30", end: "2026-09-05", reading: "alternative calendar week" }
] }, asked_speaker: "user", relation: { predicate: "not a production coordinate" } } };

describe("frozen question-time adapter", () => {
  it("admits only calendar coordinates and retains their union without annotations", () => {
    const proposal = questionTimeProposalFromCoordinates(query, clock, window)!;
    expect(proposal.producer_id).toBe(QUESTION_TIME_PROPOSAL_PRODUCER_ID);
    expect(proposal.question_time).toEqual({ interpretation_clock: clock, intervals: [
      { start: "2026-08-31", end: "2026-09-06" }, { start: "2026-08-30", end: "2026-09-05" }
    ] });
    expect(Object.keys(proposal).sort()).toEqual(["original_query_digest", "producer_id", "producer_version", "question_time", "schema_version"]);
    const request = buildOrdinaryRecallRequest({ query, source_observed_at: clock, scope_class: "project", interpretation_proposal: proposal });
    expect(request.interpretation_proposal).toEqual(proposal);
    expect(request.since).toBeUndefined();
    expect(request.until).toBeUndefined();
  });
  it("leaves unformed and absent coordinates out of the public request", () => {
    for (const frozen of [{ status: "failed" }, { status: "formed", coordinates: { time: { kind: "absent", alternatives: [] } } }]) {
      expect(questionTimeProposalFromCoordinates(query, clock, frozen)).toBeUndefined();
    }
    expect(buildOrdinaryRecallRequest({ query, source_observed_at: clock, scope_class: "project" }))
      .not.toHaveProperty("interpretation_proposal");
  });
  it("rejects malformed formed coordinates rather than pretending they are absent", () => {
    for (const alternatives of [[{ start: "2026-02-30", end: "2026-03-01" }],
      [{ start: "2026-09-07", end: "2026-09-06" }], [{ start: "2026-09-01" }]]) {
      expect(() => questionTimeProposalFromCoordinates(query, clock, { status: "formed",
        coordinates: { time: { kind: "window", alternatives } } })).toThrow();
    }
    expect(() => questionTimeProposalFromCoordinates(query, clock, { status: "formed" })).toThrow();
  });
});
