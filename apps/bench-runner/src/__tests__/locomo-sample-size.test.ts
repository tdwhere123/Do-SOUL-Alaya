import { describe, expect, it } from "vitest";
import { LocomoSampleSchema, type LocomoSample } from "../locomo/dataset.js";
import { resolveLocomoSampleSize } from "../locomo/runner.js";

function buildConversation(
  sampleId: string,
  qa: ReadonlyArray<{ question: string; evidence: string[]; category: number }>
): LocomoSample {
  return LocomoSampleSchema.parse({
    sample_id: sampleId,
    conversation: {
      speaker_a: "Alice",
      speaker_b: "Bob"
    },
    qa: qa.map((row) => ({ ...row, answer: "" }))
  });
}

describe("resolveLocomoSampleSize", () => {
  it("counts only evidence-bearing QAs across the full dataset", () => {
    const conversations = [
      buildConversation("c1", [
        { question: "q1", evidence: ["D1"], category: 1 },
        { question: "q2", evidence: ["D2"], category: 2 },
        { question: "q3", evidence: [], category: 5 }
      ]),
      buildConversation("c2", [
        { question: "q4", evidence: ["D3"], category: 1 },
        { question: "q5", evidence: [], category: 5 }
      ])
    ];
    expect(resolveLocomoSampleSize(conversations)).toBe(3);
  });

  it("returns 0 when every QA is adversarial / empty-evidence", () => {
    const conversations = [
      buildConversation("c1", [
        { question: "q1", evidence: [], category: 5 }
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
