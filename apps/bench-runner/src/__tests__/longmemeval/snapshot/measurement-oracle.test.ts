import { describe, expect, it } from "vitest";
import type { LongMemEvalQuestion } from
  "../../../longmemeval/ingestion/dataset.js";
import { buildSnapshotMeasurementOracle } from
  "../../../longmemeval/snapshot/measurement-oracle.js";

describe("snapshot measurement oracle", () => {
  it("matches live scoring when a canonical question repeats a session id", () => {
    const question = buildQuestion();
    const oracle = buildSnapshotMeasurementOracle([question], {
      schema_version: 2,
      variant: "longmemeval_s",
      questions: [{
        questionId: question.question_id,
        question: question.question,
        questionDate: question.question_date,
        answerSessionIds: [],
        sidecar: [],
        workspaceId: "workspace",
        runId: "run",
        answerSeedDropReasons: { candidate_absent: 2, materialization_drop: 1 }
      }]
    })(question.question_id);

    expect(oracle?.sourceDatesBySession).toEqual(new Map([
      ["repeated", "last-date"],
      ["unique", "unique-date"]
    ]));
    expect(oracle?.seedDropReasons).toEqual({
      candidate_absent: 2,
      materialization_drop: 1
    });
  });

  it("rejects a date/session count mismatch", () => {
    const question = { ...buildQuestion(), haystack_dates: ["first-date"] };

    expect(() => buildSnapshotMeasurementOracle([question], {
      schema_version: 2,
      variant: "longmemeval_s",
      questions: [{
        questionId: question.question_id,
        question: question.question,
        questionDate: question.question_date,
        answerSessionIds: [],
        sidecar: [],
        workspaceId: "workspace",
        runId: "run"
      }]
    })).toThrow(/source date\/session count mismatch/u);
  });
});

function buildQuestion(): LongMemEvalQuestion {
  return {
    question_id: "q-repeated-session",
    question_type: "single-session-user",
    question: "What happened?",
    answer: "The answer",
    question_date: "2023/05/30 (Tue) 22:53",
    answer_session_ids: [],
    haystack_session_ids: ["repeated", "unique", "repeated"],
    haystack_dates: ["first-date", "unique-date", "last-date"],
    haystack_sessions: [[], [], []]
  };
}
