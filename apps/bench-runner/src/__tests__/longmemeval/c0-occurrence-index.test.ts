import { describe, expect, it } from "vitest";
import {
  buildC0OccurrenceIndex,
  hashC0OccurrenceIndex
} from "../../longmemeval/extraction/c0/occurrence-index.js";

const model = "gpt-5.4-mini";
const prompt = "C0 parser formation prompt";

describe("C0 occurrence index", () => {
  it("keeps repeated raw content as separate source-time occurrences", () => {
    const occurrences = buildC0OccurrenceIndex({
      questions: [question("q-1", ["2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z"])],
      model,
      requestProfile: "provider-default-v1",
      systemPrompt: prompt
    });

    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]?.cacheKey).toBe(occurrences[1]?.cacheKey);
    expect(occurrences.map((occurrence) => occurrence.sourceObservedAt)).toEqual([
      "2025-01-01T00:00:00.000Z",
      "2025-02-01T00:00:00.000Z"
    ]);
    expect(occurrences.map((occurrence) => occurrence.evidenceRef)).toEqual([
      "q-1-s0-r0",
      "q-1-s1-r0"
    ]);
  });

  it("has a stable digest independent of question input order", () => {
    const input = {
      model,
      requestProfile: "provider-default-v1" as const,
      systemPrompt: prompt
    };
    const forward = buildC0OccurrenceIndex({
      ...input,
      questions: [question("q-2", ["2025-03-01T00:00:00.000Z"]), question("q-1", ["2025-01-01T00:00:00.000Z"])]
    });
    const reversed = buildC0OccurrenceIndex({
      ...input,
      questions: [question("q-1", ["2025-01-01T00:00:00.000Z"]), question("q-2", ["2025-03-01T00:00:00.000Z"])]
    });

    expect(hashC0OccurrenceIndex(forward)).toBe(hashC0OccurrenceIndex(reversed));
    expect(forward.map((occurrence) => occurrence.id)).toEqual(["q-1-s0-r0", "q-2-s0-r0"]);
  });

  it("refuses an occurrence with no valid source time", () => {
    expect(() => buildC0OccurrenceIndex({
      questions: [question("q-1", ["not-a-time"])],
      model,
      requestProfile: "provider-default-v1",
      systemPrompt: prompt
    })).toThrow(/invalid LongMemEval timestamp/u);
  });
});

function question(questionId: string, dates: readonly string[]) {
  return {
    question_id: questionId,
    question_type: "single-session-user",
    question: "question",
    answer: "answer",
    question_date: dates[0] ?? "2025-01-01T00:00:00.000Z",
    haystack_session_ids: dates.map((_, index) => `s-${index}`),
    haystack_dates: [...dates],
    haystack_sessions: dates.map(() => [
      { role: "user", content: "same source content" },
      { role: "assistant", content: "same assistant content" }
    ]),
    answer_session_ids: []
  };
}
