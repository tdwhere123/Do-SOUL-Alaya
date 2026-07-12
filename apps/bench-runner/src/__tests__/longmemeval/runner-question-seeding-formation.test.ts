import { describe, expect, it, vi } from "vitest";
import type { BenchWorkspaceHandle } from "../../harness/daemon.js";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";
import { seedLongMemEvalQuestion } from "../../longmemeval/runner-question-seeding.js";

describe("seedLongMemEvalQuestion formation order", () => {
  it("derives edge order from session, round, and seed ordinals", async () => {
    const question: LongMemEvalQuestion = {
      question_id: "q-formation-order",
      question_type: "single_session",
      question: "Which facts were seeded?",
      answer: "The seeded facts.",
      question_date: "2026-01-01",
      haystack_session_ids: ["session-a", "session-b"],
      haystack_dates: ["2025-12-01", "2025-12-02"],
      haystack_sessions: [
        [
          { role: "user", content: "First turn." },
          { role: "assistant", content: "First reply." },
          { role: "user", content: "Second turn." }
        ],
        [{ role: "user", content: "Third turn." }]
      ],
      answer_session_ids: ["session-a"]
    };
    const seedTurn = vi.fn(async (input: { evidenceRefBase: string }) => ({
      seeds: input.evidenceRefBase.endsWith("-s0-r0")
        ? [buildSeed("memory-a0"), buildSeed("memory-a1")]
        : input.evidenceRefBase.endsWith("-s0-r1")
          ? [buildSeed("memory-a2")]
          : [buildSeed("memory-b0")],
      turnTruncated: false,
      charsClipped: 0
    }));
    const workspace = {
      workspaceId: "workspace-formation-order",
      runId: "run-formation-order",
      accrueSessionCoRecall: vi.fn(async () => ({
        pairsObserved: 0,
        minted: 0,
        belowThreshold: 0
      })),
      proposeSynthesis: vi.fn(async () => ({ synthesisId: null }))
    } as unknown as BenchWorkspaceHandle;

    const state = await seedLongMemEvalQuestion({
      workspace,
      question,
      seedRunner: { seedTurn, stats: {} } as never
    });

    expect(state.coherenceMembers).toEqual([
      formationMember("memory-a0", "session-a", 0, 0, 0),
      formationMember("memory-a1", "session-a", 0, 0, 1),
      formationMember("memory-a2", "session-a", 0, 1, 0),
      formationMember("memory-b0", "session-b", 1, 0, 0)
    ]);
    expect(seedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceRefBase: "q-formation-order-s0-r0",
        sourceObservedAt: "2025-12-01T00:00:00.000Z"
      })
    );
  });

  it.each([
    [["2025-12-01"], /timeline arrays must have equal lengths/u],
    [["not-a-date", "2025-12-02"], /invalid LongMemEval timestamp/u]
  ])("fails before seeding an invalid historical timeline", async (haystackDates, error) => {
    const question = buildQuestion({ haystack_dates: haystackDates });
    const seedTurn = vi.fn();

    await expect(seedLongMemEvalQuestion({
      workspace: {} as BenchWorkspaceHandle,
      question,
      seedRunner: { seedTurn, stats: {} } as never
    })).rejects.toThrow(error);
    expect(seedTurn).not.toHaveBeenCalled();
  });

});

function buildQuestion(overrides: Partial<LongMemEvalQuestion>): LongMemEvalQuestion {
  return {
    question_id: "q-invalid-timeline",
    question_type: "single_session",
    question: "What happened?",
    answer: "An event.",
    question_date: "2026-01-01",
    haystack_session_ids: ["session-a", "session-b"],
    haystack_dates: ["2025-12-01", "2025-12-02"],
    haystack_sessions: [[{ role: "user", content: "First." }], [{ role: "user", content: "Second." }]],
    answer_session_ids: ["session-a"],
    ...overrides
  };
}

function buildSeed(memoryId: string) {
  return {
    memoryId,
    signalId: `signal-${memoryId}`,
    proposalId: `proposal-${memoryId}`,
    evidenceId: null,
    truncated: false,
    charsClipped: 0
  };
}

function formationMember(
  memoryId: string,
  sessionId: string,
  sessionIndex: number,
  roundIndex: number,
  seedOrdinal: number
) {
  const ordinal = (value: number) => String(value).padStart(12, "0");
  return {
    memoryId,
    sessionId,
    formationKey: JSON.stringify([
      ordinal(sessionIndex),
      ordinal(roundIndex),
      ordinal(seedOrdinal),
      sessionId
    ])
  };
}
