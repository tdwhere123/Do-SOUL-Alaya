import { describe, expect, it } from "vitest";
import { SOURCE_STATEMENTS_PROMPT, sourceStatementSessionInput } from "@do-soul/alaya-soul";
import { buildLongMemEvalSessionMessages } from "../../../datasets/longmemeval/ingestion/dataset.js";
import { sourceStatementRequests, sourceStatementSession } from "../../../runs/extraction/source-statement-request.js";
import { inspectTurnContentKeySpace } from "../../../runs/extraction/turn-contents.js";
import { computeCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import {
  normalizeCompileSeedSourceTime,
  requireLongMemEvalTimestamp
} from "../../../datasets/longmemeval/ingestion/source-time.js";

describe("normalizeCompileSeedSourceTime", () => {
  it("normalizes dataset source dates without host timezone dependence", () => {
    expect(normalizeCompileSeedSourceTime("2023/04/01 (Sat) 19:22")).toBe(
      "2023-04-01T19:22:00.000Z"
    );
    expect(normalizeCompileSeedSourceTime("2025-12-01")).toBe(
      "2025-12-01T00:00:00.000Z"
    );
    expect(normalizeCompileSeedSourceTime("2025-12-01T08:09:10.000Z")).toBe(
      "2025-12-01T08:09:10.000Z"
    );
  });

  it("binds request and cache identity to source dates without inventing per-message precision", () => {
    const session = [{ role: "user", content: "I travelled yesterday." }];
    const question = (date: string) => ({ question_id: "unchanged-question", question_type: "temporal",
      question: "not extraction input", answer: "not extraction input", question_date: "2099-01-01",
      haystack_sessions: [session], haystack_session_ids: ["recorded-session"], haystack_dates: [date], answer_session_ids: [] });
    const inventory = inspectTurnContentKeySpace([question("2026/09/14"), question("2026/09/15")], "session-statements");
    expect(inventory.distinctExtractionTurns).toHaveLength(2);
    const [first, second] = inventory.distinctExtractionTurns.map(turn => sourceStatementRequests(turn.turnMessages)[0]!);
    expect(first!.source.messages[0]).toMatchObject({ recorded_at: "2026-09-14T00:00:00.000Z",
      recorded_time: { level: "session", precision: "day", timezone: "unspecified", provenance: "longmemeval.haystack_dates" } });
    expect(second!.source.messages[0]!.recorded_at).toBe("2026-09-15T00:00:00.000Z");
    expect(first!.source.session_id).not.toBe(second!.source.session_id);
    expect(computeCacheKey("fixture", "provider-default-v1", SOURCE_STATEMENTS_PROMPT, first!.userPrompt))
      .not.toBe(computeCacheKey("fixture", "provider-default-v1", SOURCE_STATEMENTS_PROMPT, second!.userPrompt));
    const dates = ["2026/09/14", "2026/09/15"].map(date => buildLongMemEvalSessionMessages(session, date));
    expect(dates[0]![0]).not.toHaveProperty("created_at");
    for (const messages of dates) {
      const rendered = sourceStatementSession(messages).rendered;
      expect(rendered.content).toBe("User: I travelled yesterday.");
      expect(rendered.occurrences.map(row => row.utf8_span)).toEqual([[6, 28]]);
    }
    const precise = sourceStatementSessionInput([{ ...dates[0]![0]!, created_at: "2026-09-14T12:34:56.000Z" }]).messages[0]!;
    expect(precise.recorded_at).toBe("2026-09-14T12:34:56.000Z");
    expect(precise.recorded_time).toBeUndefined();
    expect(first!.userPrompt).not.toContain("2099");
    expect(sourceStatementSessionInput(buildLongMemEvalSessionMessages(session)).messages[0]!.recorded_at).toBeNull();
    expect(() => buildLongMemEvalSessionMessages(session, "not-a-date")).toThrow("invalid LongMemEval timestamp");
    expect(() => inspectTurnContentKeySpace([{ ...question("2026/09/14"), haystack_dates: [] }], "session-statements"))
      .toThrow("equal lengths");
  });

  it("rejects rollover and unsupported source dates", () => {
    expect(normalizeCompileSeedSourceTime("2026-02-31")).toBeUndefined();
    expect(normalizeCompileSeedSourceTime("not-a-date")).toBeUndefined();
    expect(() => requireLongMemEvalTimestamp("not-a-date")).toThrow(/invalid LongMemEval timestamp/u);
    expect(() => requireLongMemEvalTimestamp(undefined)).toThrow(/invalid LongMemEval timestamp/u);
  });
});
