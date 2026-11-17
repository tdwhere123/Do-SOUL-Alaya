import { describe, expect, it } from "vitest";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID } from "@do-soul/alaya-protocol";
import { bindCallerQueryCoordinates } from "../../../../recall/conditional-field/query/caller-query-coordinates.js";
import { compileConditionalFieldQuery, digestOriginalQuery } from "../../../../recall/conditional-field/query/compile-query.js";
import { defaultBudget, defaultView, INTERPRETATION_CLOCK, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const queryText = "Which coffee shop did Alice visit last week?";

describe("bindCallerQueryCoordinates", () => {
  it("binds original_query_digest and interpretation_clock into the question-time producer proposal", () => {
    const proposal = bindCallerQueryCoordinates({
      queryText,
      interpretationClock: INTERPRETATION_CLOCK,
      coordinates: {
        question_time: { intervals: [{ start: "2026-08-30", end: "2026-09-05" }] },
        evidence_conditions: [{ statement: "Alice visited <shop>.", speaker: "user", anchors: ["Alice"] }],
        evidence_relation: "derived"
      }
    });
    expect(proposal).toMatchObject({
      schema_version: 1,
      producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
      original_query_digest: digestOriginalQuery(queryText),
      question_time: {
        interpretation_clock: INTERPRETATION_CLOCK,
        intervals: [{ start: "2026-08-30", end: "2026-09-05" }]
      },
      evidence_conditions: [{ statement: "Alice visited <shop>.", speaker: "user", anchors: ["Alice"] }],
      evidence_relation: "derived"
    });
    const compiled = compileConditionalFieldQuery({
      source: "ordinary",
      text: queryText,
      interpretation_clock: INTERPRETATION_CLOCK,
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      view: { ...defaultView(), enumeration_policy: "native_query" },
      interpretation_proposal: proposal
    });
    expect(compiled.status).toBe("partial");
    expect(compiled.interpretation_proposal?.evidence_conditions).toHaveLength(1);
    expect(compiled.interpretation_proposal?.question_time?.intervals).toHaveLength(1);
  });

  it("drops only invalid conditions and malformed date intervals while preserving valid coordinates", () => {
    const proposal = bindCallerQueryCoordinates({
      queryText,
      interpretationClock: INTERPRETATION_CLOCK,
      coordinates: {
        question_time: {
          intervals: [
            { start: "2026-02-30", end: "2026-03-01" },
            { start: "2026-09-05", end: "2026-08-30" },
            { start: "2026-08-30", end: "2026-09-05" }
          ]
        },
        evidence_conditions: [
          { statement: "Bob visited <shop>.", speaker: "user", anchors: ["Bob"] },
          { statement: "Alice visited <shop>.", speaker: "user", anchors: [" Alice "] },
          { statement: "Alice ordered espresso.", speaker: "user", anchors: ["Alice"] }
        ],
        evidence_relation: "derived"
      }
    });
    expect(proposal?.question_time?.intervals).toEqual([{ start: "2026-08-30", end: "2026-09-05" }]);
    expect(proposal?.evidence_conditions).toEqual([
      { statement: "Alice ordered espresso.", speaker: "user", anchors: ["Alice"] }
    ]);
    expect(proposal?.evidence_relation).toBe("derived");
  });

  it("drops evidence_relation when zero valid conditions survive and falls back to plain query when nothing survives", () => {
    const timeOnly = bindCallerQueryCoordinates({
      queryText,
      interpretationClock: INTERPRETATION_CLOCK,
      coordinates: {
        question_time: { intervals: [{ start: "2026-08-30", end: "2026-09-05" }] },
        evidence_conditions: [{ statement: "Bad anchor", speaker: "user", anchors: ["nonexistent"] }],
        evidence_relation: "derived"
      }
    });
    expect(timeOnly?.question_time?.intervals).toHaveLength(1);
    expect(timeOnly?.evidence_conditions).toBeUndefined();
    expect(timeOnly?.evidence_relation).toBeUndefined();

    const plainFallback = bindCallerQueryCoordinates({
      queryText,
      interpretationClock: INTERPRETATION_CLOCK,
      coordinates: {
        question_time: { intervals: [{ start: "not-a-date", end: "2026-09-05" }] },
        evidence_conditions: [{ statement: "Bad anchor", speaker: "user", anchors: ["alice"] }],
        evidence_relation: "derived"
      }
    });
    expect(plainFallback).toBeUndefined();
  });
});
