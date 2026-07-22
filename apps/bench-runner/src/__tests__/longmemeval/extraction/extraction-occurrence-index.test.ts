import { describe, expect, it } from "vitest";
import {
  buildExtractionOccurrenceIndex,
  hashExtractionOccurrenceIndex
} from "../../../longmemeval/extraction/cache-audit/occurrence-index.js";
import { computeTrustedRoleCorpusDigest } from
  "../../../longmemeval/extraction/turn-contents.js";
import { inspectTurnContentKeySpace } from
  "../../../longmemeval/extraction/turn-contents.js";

const model = "gpt-5.4-mini";
const prompt = "Extraction cache parser formation prompt";

describe("extraction occurrence index", () => {
  it("keeps repeated raw content as separate source-time occurrences", () => {
    const occurrences = buildExtractionOccurrenceIndex({
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
    expect(occurrences[0]?.turnMessages.map(({ role, content }) => [role, content])).toEqual([
      ["user", "same source content"],
      ["assistant", "same assistant content"]
    ]);
  });

  it("has a stable digest independent of question input order", () => {
    const input = {
      model,
      requestProfile: "provider-default-v1" as const,
      systemPrompt: prompt
    };
    const forward = buildExtractionOccurrenceIndex({
      ...input,
      questions: [question("q-2", ["2025-03-01T00:00:00.000Z"]), question("q-1", ["2025-01-01T00:00:00.000Z"])]
    });
    const reversed = buildExtractionOccurrenceIndex({
      ...input,
      questions: [question("q-1", ["2025-01-01T00:00:00.000Z"]), question("q-2", ["2025-03-01T00:00:00.000Z"])]
    });

    expect(hashExtractionOccurrenceIndex(forward)).toBe(hashExtractionOccurrenceIndex(reversed));
    expect(forward.map((occurrence) => occurrence.id)).toEqual(["q-1-s0-r0", "q-2-s0-r0"]);
  });

  it("binds cache and occurrence identity to the versioned trusted role corpus", () => {
    const [occurrence] = buildExtractionOccurrenceIndex({
      questions: [question("q-1", ["2025-01-01T00:00:00.000Z"])],
      model,
      requestProfile: "provider-default-v1",
      systemPrompt: prompt
    });
    const changedMessages = occurrence!.turnMessages.map((message) => ({
      ...message,
      role: message.role === "user" ? "assistant" as const : "user" as const
    }));
    const changed = {
      ...occurrence!,
      trustedRoleCorpusDigest: computeTrustedRoleCorpusDigest(changedMessages)
    };

    expect(occurrence?.trustedRoleCorpusDigest).toBe(
      computeTrustedRoleCorpusDigest(occurrence!.turnMessages)
    );
    expect(hashExtractionOccurrenceIndex([occurrence!]))
      .not.toBe(hashExtractionOccurrenceIndex([changed]));
  });

  it("keeps identical rendered turns distinct when their trusted roles differ", () => {
    const base = question("q-1", ["2025-01-01T00:00:00.000Z"]);
    const collision = {
      ...base,
      question_id: "q-2",
      haystack_session_ids: ["s-collision"],
      haystack_sessions: [[{
        role: "user",
        content: "same source content\nAssistant: same assistant content"
      }]]
    };

    const keySpace = inspectTurnContentKeySpace([base, collision]);

    expect(keySpace.distinctExtractionTurns).toHaveLength(2);
    expect(new Set(keySpace.distinctTurnContents)).toHaveLength(1);
    expect(new Set(keySpace.distinctExtractionTurns.map((turn) =>
      computeTrustedRoleCorpusDigest(turn.turnMessages)
    ))).toHaveLength(2);
  });

  it("refuses an occurrence with no valid source time", () => {
    expect(() => buildExtractionOccurrenceIndex({
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
