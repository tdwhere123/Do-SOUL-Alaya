import { describe, expect, it } from "vitest";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID } from "@do-soul/alaya-protocol";
import { queryProposalFromCoordinates } from "../../../runs/recall-measurement/ordinary/query-coordinate-proposal.js";
import { buildOrdinaryRecallRequest } from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";

const query = "What happened last week?", clock = "2026-09-07T00:00:00.000Z";
const window = { status: "formed", coordinates: { time: { kind: "window", alternatives: [
  { start: "2026-08-31", end: "2026-09-06", reading: "preceding calendar week" },
  { start: "2026-08-30", end: "2026-09-05", reading: "alternative calendar week" }
] }, asked_speaker: "user", relation: { predicate: "not a production coordinate" } } };

describe("frozen query-coordinate adapter", () => {
  it("routes known-speaker evidence statements through the bound ordinary proposal without relation annotations", () => {
    const statements = ["I attended <event> last week."], result = queryProposalFromCoordinates(query, clock, {
      ...window, coordinates: { ...window.coordinates, evidence_statements: statements }
    })!;
    expect(result.producer_id).toBe(SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID);
    expect(result.source_template).toEqual({ interpretation_clock: clock, asked_speaker: "user", evidence_statements: statements });
    expect(result).not.toHaveProperty("relation");
    expect(buildOrdinaryRecallRequest({ query, source_observed_at: clock, scope_class: "project", interpretation_proposal: result })
      .interpretation_proposal).toEqual(result);
    expect(queryProposalFromCoordinates(query, clock, { ...window, coordinates: {
      ...window.coordinates, asked_speaker: "either", evidence_statements: statements
    } })?.source_template).toBeUndefined();
  });
  it("passes evidence conditions through unchanged, even without a time window or known speaker", () => {
    const conditions = [{ statement: "I attended <event> on <date>.", speaker: "user", anchors: [] },
      { statement: "You recommended <place>.", speaker: "assistant", anchors: ["week"] }];
    const proposal = queryProposalFromCoordinates(query, clock, { ...window, coordinates: { ...window.coordinates,
      evidence_statements: ["Template only."], evidence_conditions: conditions } })!;
    expect(proposal.evidence_conditions).toEqual(conditions);
    // Qv2 evidence statements stay template input, never conditions.
    expect(proposal).not.toHaveProperty("evidence_statements");
    const only = queryProposalFromCoordinates(query, clock, { status: "formed", coordinates: { time: { kind: "absent" },
      asked_speaker: "either", evidence_statements: ["Not a condition."], evidence_conditions: conditions } })!;
    expect(only.producer_id).toBe(QUESTION_TIME_PROPOSAL_PRODUCER_ID);
    expect(Object.keys(only).sort()).toEqual(["evidence_conditions", "original_query_digest", "producer_id", "producer_version", "schema_version"]);
    expect(queryProposalFromCoordinates(query, clock, { status: "formed", coordinates: { time: { kind: "absent" },
      evidence_statements: ["Not a condition."], evidence_conditions: [] } })).toBeUndefined();
    for (const invalid of [Array(5).fill(conditions[0]), [{ ...conditions[0], speaker: "either" }], [{ ...conditions[0], role: "stated" }]]) {
      expect(() => queryProposalFromCoordinates(query, clock, { status: "formed", coordinates: { time: { kind: "absent" },
        evidence_conditions: invalid } })).toThrow();
    }
  });
  it("admits only calendar coordinates and retains their union without annotations", () => {
    const proposal = queryProposalFromCoordinates(query, clock, window)!;
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
      expect(queryProposalFromCoordinates(query, clock, frozen)).toBeUndefined();
    }
    expect(buildOrdinaryRecallRequest({ query, source_observed_at: clock, scope_class: "project" }))
      .not.toHaveProperty("interpretation_proposal");
  });
  it("rejects malformed formed coordinates rather than pretending they are absent", () => {
    for (const alternatives of [[{ start: "2026-02-30", end: "2026-03-01" }],
      [{ start: "2026-09-07", end: "2026-09-06" }], [{ start: "2026-09-01" }]]) {
      expect(() => queryProposalFromCoordinates(query, clock, { status: "formed",
        coordinates: { time: { kind: "window", alternatives } } })).toThrow();
    }
    expect(() => queryProposalFromCoordinates(query, clock, { status: "formed" })).toThrow();
  });
});
