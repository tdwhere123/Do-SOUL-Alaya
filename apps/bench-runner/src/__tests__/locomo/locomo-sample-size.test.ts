import { describe, expect, it } from "vitest";
import { LocomoSampleSchema, type LocomoSample } from "../../locomo/dataset.js";
import { resolveLocomoSampleSize } from "../../locomo/runner.js";

function buildConversation(
  sampleId: string,
  qa: ReadonlyArray<{
    question: string;
    evidence: string[];
    category: number;
    answer?: string;
  }>
): LocomoSample {
  return LocomoSampleSchema.parse({
    sample_id: sampleId,
    conversation: {
      speaker_a: "Alice",
      speaker_b: "Bob"
    },
    qa: qa.map((row) => ({ ...row, answer: row.answer ?? "gold" }))
  });
}

describe("resolveLocomoSampleSize", () => {
  it("counts every evidence-bearing QA across the full dataset", () => {
    const conversations = [
      buildConversation("c1", [
        { question: "q1", evidence: ["D1"], category: 1, answer: "a1" },
        { question: "q2", evidence: ["D2"], category: 2, answer: "a2" },
        { question: "q3", evidence: ["D3"], category: 5, answer: "" }
      ]),
      buildConversation("c2", [
        { question: "q4", evidence: ["D4"], category: 1, answer: "a4" },
        { question: "q5", evidence: [], category: 3, answer: "a5" }
      ])
    ];
    expect(resolveLocomoSampleSize(conversations)).toBe(4);
  });

  it("returns 0 when every QA lacks retrieval evidence", () => {
    const conversations = [
      buildConversation("c1", [
        { question: "q1", evidence: [], category: 3, answer: "gold" }
      ])
    ];
    expect(resolveLocomoSampleSize(conversations)).toBe(0);
  });

  it("counts in QA units, never in conversation units", () => {
    // 10 conversations of 200 evidence-bearing QAs each = 2000;
    // confirms denominator is at QA granularity, not 10.
    const conversations: LocomoSample[] = [];
    for (let c = 0; c < 10; c++) {
      const qa: { question: string; evidence: string[]; category: number }[] = [];
      for (let q = 0; q < 200; q++) {
        qa.push({ question: `q${c}-${q}`, evidence: [`D${c}-${q}`], category: 1 });
      }
      conversations.push(buildConversation(`c${c}`, qa));
    }
    expect(resolveLocomoSampleSize(conversations)).toBe(2000);
    // confirm: per-conversation aggregation lifts the unit, not the
    // length of the conversation array.
    expect(conversations.length).toBe(10);
  });
});
