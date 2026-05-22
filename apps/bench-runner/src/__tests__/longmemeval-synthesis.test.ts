import { describe, expect, it } from "vitest";
import { buildSessionSynthesisInput } from "../longmemeval/compile-seed.js";
import {
  scoreLongMemEvalRecallHits,
  type LongMemEvalSidecarEntry
} from "../longmemeval/runner.js";

// S4 part 3 — buildSessionSynthesisInput is the deterministic, LLM-free
// digest that feeds the session-level potential_synthesis seed.
describe("buildSessionSynthesisInput (S4 synthesis emission)", () => {
  it("emits a synthesis seed when >= 2 turns carry a real evidence id", () => {
    const input = buildSessionSynthesisInput({
      topicKey: "q1-s0",
      turns: [
        { turnContent: "User prefers pnpm for the monorepo.", evidenceId: "ev-1" },
        { turnContent: "User deploys nightly from the staging branch.", evidenceId: "ev-2" }
      ]
    });

    expect(input).not.toBeNull();
    expect(input?.topicKey).toBe("q1-s0");
    expect(input?.evidenceRefs).toEqual(["ev-1", "ev-2"]);
    // The summary is a deterministic concat of the turn contents.
    expect(input?.summary).toContain("pnpm");
    expect(input?.summary).toContain("staging branch");
  });

  it("is deterministic — identical turns yield a byte-identical summary", () => {
    const turns = [
      { turnContent: "Turn one content.", evidenceId: "ev-1" },
      { turnContent: "Turn two content.", evidenceId: "ev-2" }
    ];
    const first = buildSessionSynthesisInput({ topicKey: "q1-s0", turns });
    const second = buildSessionSynthesisInput({ topicKey: "q1-s0", turns });
    expect(first?.summary).toBe(second?.summary);
  });

  it("returns null when fewer than 2 turns minted a real evidence id", () => {
    const input = buildSessionSynthesisInput({
      topicKey: "q1-s0",
      turns: [
        { turnContent: "Only turn with evidence.", evidenceId: "ev-1" },
        { turnContent: "Turn whose signal routed evidence-only.", evidenceId: null }
      ]
    });
    expect(input).toBeNull();
  });

  it("returns null when every collected turn content is blank", () => {
    const input = buildSessionSynthesisInput({
      topicKey: "q1-s0",
      turns: [
        { turnContent: "   ", evidenceId: "ev-1" },
        { turnContent: "", evidenceId: "ev-2" }
      ]
    });
    expect(input).toBeNull();
  });
});

// S4 part 4 — a delivered synthesis_capsule whose object_id maps to an
// answer session in the sidecar scores as a hit at its delivered rank.
describe("synthesis scoring credit (S4 part 4)", () => {
  it("credits a delivered synthesis_capsule that covers the answer session", () => {
    const sidecar = new Map<string, LongMemEvalSidecarEntry>([
      // L1 memory_entry of the answer session.
      ["memory-gold", { sessionId: "session-a", hasAnswer: true }],
      // L2 synthesis_capsule of the SAME answer session.
      ["synthesis-a", { sessionId: "session-a", hasAnswer: true }],
      ["decoy", { sessionId: "session-b", hasAnswer: false }]
    ]);

    // The synthesis_capsule is delivered at rank 1; the memory_entry is not
    // delivered at all. The synthesis hit alone must register R@1.
    const scoring = scoreLongMemEvalRecallHits({
      results: [
        { object_id: "synthesis-a", relevance_score: 0.88 },
        { object_id: "decoy", relevance_score: 0.4 }
      ],
      sidecar,
      answerSessionIds: new Set(["session-a"])
    });

    expect(scoring.hitAt1).toBe(true);
    expect(scoring.hitAt5).toBe(true);
    expect(scoring.hitAt10).toBe(true);
  });

  it("does not credit a synthesis_capsule of a non-answer session", () => {
    const sidecar = new Map<string, LongMemEvalSidecarEntry>([
      ["synthesis-b", { sessionId: "session-b", hasAnswer: false }]
    ]);

    const scoring = scoreLongMemEvalRecallHits({
      results: [{ object_id: "synthesis-b", relevance_score: 0.9 }],
      sidecar,
      answerSessionIds: new Set(["session-a"])
    });

    expect(scoring.hitAt1).toBe(false);
    expect(scoring.hitAt10).toBe(false);
  });

  it("keeps memory_entry R@K semantics intact alongside synthesis crediting", () => {
    const sidecar = new Map<string, LongMemEvalSidecarEntry>([
      ["memory-gold", { sessionId: "session-a", hasAnswer: true }],
      ["synthesis-a", { sessionId: "session-a", hasAnswer: true }]
    ]);

    // A memory_entry hit at rank 3 — R@1 false, R@5 true — regardless of
    // the synthesis row's presence in the sidecar.
    const scoring = scoreLongMemEvalRecallHits({
      results: [
        { object_id: "noise-1", relevance_score: 0.7 },
        { object_id: "noise-2", relevance_score: 0.6 },
        { object_id: "memory-gold", relevance_score: 0.5 }
      ],
      sidecar,
      answerSessionIds: new Set(["session-a"])
    });

    expect(scoring.hitAt1).toBe(false);
    expect(scoring.hitAt5).toBe(true);
    expect(scoring.hitAt10).toBe(true);
  });
});
