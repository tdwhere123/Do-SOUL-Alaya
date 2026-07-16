import { describe, expect, it, vi } from "vitest";
import type { BenchWorkspaceHandle } from "../../harness/daemon.js";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";
import type { CompileSeedExtractionStats } from "../../longmemeval/compile-seed.js";
import { seedLongMemEvalQuestion } from "../../longmemeval/runner-question-seeding.js";
import { deriveLongMemEvalGoldMemoryIds } from "../../longmemeval/runner-scoring.js";

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
      seedRunner: { seedTurn, stats: seedStats() } as never,
      seedFormationMode: "diagnostic_warmup"
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
    expect(workspace.accrueSessionCoRecall).toHaveBeenCalledTimes(2);
  });

  it("keeps snapshot seeding free of session co-recall formation", async () => {
    const workspace = {
      workspaceId: "workspace-neutral-formation",
      runId: "run-neutral-formation",
      accrueSessionCoRecall: vi.fn(async () => ({
        pairsObserved: 0, minted: 0, belowThreshold: 0
      })),
      proposeSynthesis: vi.fn(async () => ({ synthesisId: null }))
    } as unknown as BenchWorkspaceHandle;

    await seedLongMemEvalQuestion({
      workspace,
      question: buildQuestion({}),
      seedRunner: {
        seedTurn: vi.fn(async () => ({
          seeds: [], turnTruncated: false, charsClipped: 0
        })),
        stats: seedStats()
      },
      seedFormationMode: "treatment_neutral"
    });

    expect(workspace.accrueSessionCoRecall).not.toHaveBeenCalled();
  });

  it("records a cache-bound outcome for every round, including zero-signal rounds", async () => {
    const question = buildQuestion({});
    const stats = seedStats();
    const seedTurn = vi.fn(async () => {
      const ordinal = seedTurn.mock.calls.length;
      const seeds = ordinal === 1 ? [buildSeed("memory-first")] : [];
      stats.cacheHits += 1;
      stats.factsProduced += seeds.length;
      stats.lastExtractionSource = "cache";
      stats.lastCacheKey = String(ordinal).padStart(64, "0");
      stats.lastRawJsonSha256 = String(ordinal + 8).padStart(64, "0");
      stats.lastTurnRawSignalCount = seeds.length;
      stats.lastTurnDraftCount = seeds.length;
      return { seeds, turnTruncated: false, charsClipped: 0 };
    });
    const workspace = {
      workspaceId: "workspace-ledger",
      runId: "run-ledger",
      accrueSessionCoRecall: vi.fn(async () => ({
        pairsObserved: 0, minted: 0, belowThreshold: 0
      })),
      proposeSynthesis: vi.fn(async () => ({ synthesisId: null }))
    } as unknown as BenchWorkspaceHandle;

    const state = await seedLongMemEvalQuestion({
      workspace,
      question,
      seedRunner: { seedTurn, stats },
      seedFormationMode: "diagnostic_warmup"
    });

    expect(state.seedRounds).toHaveLength(2);
    expect(state.seedRounds.map((round) => ({
      sessionIndex: round.sessionIndex,
      roundIndex: round.roundIndex,
      source: round.extractionSource,
      memoryObjectIds: round.memoryObjectIds
    }))).toEqual([
      { sessionIndex: 0, roundIndex: 0, source: "cache", memoryObjectIds: ["memory-first"] },
      { sessionIndex: 1, roundIndex: 0, source: "cache", memoryObjectIds: [] }
    ]);
  });

  it("rejects extraction counters that move backwards between rounds", async () => {
    const stats = seedStats();
    const seedTurn = vi.fn(async () => {
      const first = seedTurn.mock.calls.length === 1;
      stats.factsProduced = first ? 1 : 0;
      stats.lastExtractionSource = "cache";
      stats.lastCacheKey = (first ? "1" : "2").padStart(64, "0");
      stats.lastRawJsonSha256 = (first ? "3" : "4").padStart(64, "0");
      stats.lastTurnRawSignalCount = first ? 1 : 0;
      stats.lastTurnDraftCount = first ? 1 : 0;
      return {
        seeds: first ? [buildSeed("memory-first")] : [],
        turnTruncated: false,
        charsClipped: 0
      };
    });
    const workspace = {
      workspaceId: "workspace-counter-regression",
      runId: "run-counter-regression",
      accrueSessionCoRecall: vi.fn(async () => ({
        pairsObserved: 0, minted: 0, belowThreshold: 0
      })),
      proposeSynthesis: vi.fn(async () => ({ synthesisId: null }))
    } as unknown as BenchWorkspaceHandle;

    await expect(seedLongMemEvalQuestion({
      workspace,
      question: buildQuestion({}),
      seedRunner: { seedTurn, stats },
      seedFormationMode: "diagnostic_warmup"
    })).rejects.toThrow(/counters must be monotonic/u);
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
      seedRunner: { seedTurn, stats: {} } as never,
      seedFormationMode: "diagnostic_warmup"
    })).rejects.toThrow(error);
    expect(seedTurn).not.toHaveBeenCalled();
  });

  it("keeps every source round when reconciliation reuses one survivor", async () => {
    const question = buildQuestion({
      haystack_sessions: [
        [{ role: "user", content: "Same fact.", has_answer: true }],
        [{ role: "user", content: "Same fact." }]
      ]
    });
    const workspace = {
      workspaceId: "workspace-duplicate",
      runId: "run-duplicate",
      accrueSessionCoRecall: vi.fn(async () => ({
        pairsObserved: 0, minted: 0, belowThreshold: 0
      })),
      proposeSynthesis: vi.fn(async () => ({ synthesisId: null }))
    } as unknown as BenchWorkspaceHandle;

    const state = await seedLongMemEvalQuestion({
      workspace,
      question,
      seedRunner: {
        seedTurn: vi.fn(async () => ({
          seeds: [buildSeed("memory-duplicate")],
          turnTruncated: false,
          charsClipped: 0
        })),
        stats: seedStats()
      } as never,
      seedFormationMode: "diagnostic_warmup"
    });

    expect(state.seedRounds.map((round) => round.memoryObjectIds)).toEqual([
      ["memory-duplicate"],
      ["memory-duplicate"]
    ]);
    expect([...state.sidecar.values()]).toEqual([
      expect.objectContaining({
        objectId: "memory-duplicate",
        sessionId: "session-a",
        hasAnswer: true,
        sourceRounds: [
          { sessionIndex: 0, roundIndex: 0, sessionId: "session-a", hasAnswer: true },
          { sessionIndex: 1, roundIndex: 0, sessionId: "session-b", hasAnswer: false }
        ]
      })
    ]);
    expect(deriveLongMemEvalGoldMemoryIds(
      state.sidecar,
      new Set(["session-a"])
    )).toEqual(["memory-duplicate"]);
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

function seedStats(): CompileSeedExtractionStats {
  return {
    path: "official_api_compile",
    extractionAttempts: 0,
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    factsProduced: 0,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 },
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 0,
    lastTurnDraftCount: 0,
    lastExtractionSource: null,
    lastCacheKey: null,
    lastRawJsonSha256: null
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
