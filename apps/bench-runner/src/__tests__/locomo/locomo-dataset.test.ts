import { describe, expect, it } from "vitest";
import { LocomoSampleSchema, extractSessions, type LocomoConversationBody } from "../../locomo/dataset.js";

describe("LocomoSampleSchema", () => {
  it("parses a minimal LoCoMo conversation record", () => {
    const record = {
      sample_id: "conv-1",
      conversation: {
        speaker_a: "Alice",
        speaker_b: "Bob",
        session_1_date_time: "2026-05-16 10:00 am",
        session_1: [
          { speaker: "Alice", dia_id: "D1:1", text: "hello" },
          { speaker: "Bob", dia_id: "D1:2", text: "hi" }
        ]
      },
      qa: [
        { question: "who greeted first?", answer: "Alice", evidence: ["D1:1"], category: 1 }
      ]
    };
    const parsed = LocomoSampleSchema.parse(record);
    expect(parsed.sample_id).toBe("conv-1");
    expect(parsed.qa).toHaveLength(1);
  });
});

describe("extractSessions", () => {
  it("returns sessions in numeric order, ignoring speaker/date keys", () => {
    const body: LocomoConversationBody = {
      speaker_a: "Alice",
      speaker_b: "Bob",
      session_2_date_time: "later",
      session_2: [{ speaker: "Alice", dia_id: "D2:1", text: "second" }],
      session_1_date_time: "earlier",
      session_1: [{ speaker: "Bob", dia_id: "D1:1", text: "first" }]
    } as unknown as LocomoConversationBody;
    const sessions = extractSessions(body);
    expect(sessions.map((s) => s.session_id)).toEqual(["session_1", "session_2"]);
    expect(sessions[0]?.turns[0]?.text).toBe("first");
    expect(sessions[1]?.date_time).toBe("later");
  });
});
