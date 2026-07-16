import { afterEach, describe, expect, it, vi } from "vitest";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";
import type { BenchDaemonHandle, BenchWorkspaceHandle } from "../../harness/daemon.js";
import {
  buildQaDeliveredCandidates,
  runLongMemEvalQuestion
} from "../../longmemeval/runner-question.js";
import { createEmptyLongMemEvalSeedDropReasons } from "../../longmemeval/seed-drop-reasons.js";
import { buildRecallResult } from "./longmemeval-runner-fixture.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runLongMemEvalQuestion QA delivery", () => {
  it("dedupes the gold-only runner path before building QA context", async () => {
    vi.stubEnv("ALAYA_BENCH_DELIVER_GOLD_ONLY", "1");

    const question: LongMemEvalQuestion = {
      question_id: "q-gold-only",
      question_type: "single_session",
      question: "What facts should the QA context contain?",
      answer: "One duplicate fact and one unique fact.",
      question_date: "2026-01-01",
      haystack_session_ids: ["session-a", "session-b"],
      haystack_dates: ["2025-12-01", "2025-11-01"],
      haystack_sessions: [
        [
          { role: "user", content: "Duplicated gold turn.", has_answer: true },
          { role: "assistant", content: "Noted." },
          { role: "user", content: "Unique gold turn.", has_answer: true },
          { role: "assistant", content: "Logged." }
        ],
        [{ role: "user", content: "Distractor turn." }]
      ],
      answer_session_ids: ["session-a"]
    };

    const seedTurn = vi.fn(
      async (input: { evidenceRefBase: string }) => {
        if (input.evidenceRefBase.endsWith("-s0-r0")) {
          return {
            seeds: [
              buildSeed("memory-gold-1"),
              buildSeed("memory-gold-2")
            ],
            turnTruncated: false,
            charsClipped: 0
          };
        }
        if (input.evidenceRefBase.endsWith("-s0-r1")) {
          return {
            seeds: [buildSeed("memory-gold-3")],
            turnTruncated: false,
            charsClipped: 0
          };
        }
        return {
          seeds: [buildSeed("memory-decoy-1")],
          turnTruncated: false,
          charsClipped: 0
        };
      }
    );

    const answerChat = vi.fn(async (_system: string, user: string) => {
      return user;
    });
    const judgeChat = vi.fn(async () => "yes");

    const workspace = {
      workspaceId: "workspace-q-gold-only",
      runId: "run-q-gold-only",
      accrueSessionCoRecall: vi.fn(async () => ({
        pairsObserved: 0,
        minted: 0,
        belowThreshold: 0
      })),
      proposeSynthesis: vi.fn(async () => ({ synthesisId: null })),
      recall: vi.fn(async () => buildRecallResult("delivery-1", ["memory-decoy-1"])),
      queryTokenMetrics: vi.fn(async () => ({
        raw_history_tokens: 100,
        stored_memory_tokens: 20,
        recalled_context_tokens_total: 10,
        recall_event_count: 1,
        recalled_context_tokens_mean: 10,
        seed_event_count: 4
      })),
      queryEdgeProposalKpiRows: vi.fn(async () => []),
      detach: vi.fn(async () => undefined)
    } as unknown as BenchWorkspaceHandle;

    const daemon = {
      attachWorkspace: vi.fn(async () => workspace),
      runEdgePlanePassIfConfigured: vi.fn(async () => undefined),
      runtime: {
        services: {
          graphHealthService: {
            getStatus: vi.fn(async (workspaceId: string) => ({
              workspace_id: workspaceId,
              path_relations_by_kind: {},
              path_relations_total: 0,
              latest_path_event_at: null,
              warnings: []
            }))
          }
        }
      }
    } as unknown as BenchDaemonHandle;

    const result = await runLongMemEvalQuestion({
      daemon,
      question,
      turnIndex: 0,
      seedRunner: {
        seedTurn,
        stats: {
          extractionPath: "no_credentials_fallback",
          cacheHits: 0,
          llmCalls: 0,
          offlineFallbacks: 0,
          factsExtracted: 0,
          signalsDropped: 0,
          signalsDroppedByReason: createEmptyLongMemEvalSeedDropReasons()
        }
      } as never,
      recallOptions: { maxResults: 10, conflictAwareness: false },
      simulateReport: "none",
      embeddingMode: "disabled",
      embeddingProviderKind: "openai",
      captureSnapshot: true,
      qaChat: answerChat,
      qaJudgeChat: judgeChat
    });

    expect(answerChat).toHaveBeenCalledTimes(1);
    const answerPrompt = answerChat.mock.calls[0]?.[1] ?? "";
    expect(countOccurrences(answerPrompt, "Duplicated gold turn.")).toBe(1);
    expect(countOccurrences(answerPrompt, "Unique gold turn.")).toBe(1);
    expect(answerPrompt).not.toContain("Distractor turn.");
    expect(workspace.recall).toHaveBeenCalledWith(
      question.question,
      expect.objectContaining({ referenceTime: "2026-01-01T00:00:00.000Z" })
    );
    expect(workspace.accrueSessionCoRecall).not.toHaveBeenCalled();
    expect(result.snapshotQuestion?.questionDate).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("buildQaDeliveredCandidates sourceRank honesty", () => {
  it("ranks memory_entry candidates against the full recall list, not the filtered subsequence", () => {
    // A non-memory_entry pointer (synthesis_capsule) sits at rank 1, ABOVE the
    // first memory_entry at rank 2. The delivered candidate's sourceRank must be
    // its original full-list position (2), not its memory-entry-filtered position (1).
    const results = [
      { object_id: "capsule-1", object_kind: "synthesis_capsule" },
      { object_id: "memory-1", object_kind: "memory_entry" },
      { object_id: "memory-2", object_kind: "memory_entry" }
    ];
    const sidecar = new Map<string, { content?: string; sessionId?: string | null }>([
      ["memory-1", { content: "first fact", sessionId: "session-a" }],
      ["memory-2", { content: "second fact", sessionId: "session-b" }]
    ]);

    const { memoryEntryCandidates } = buildQaDeliveredCandidates({
      results,
      goldMemoryIds: [],
      lookupMemoryEntry: (objectId) => sidecar.get(objectId)
    });

    expect(memoryEntryCandidates.map((c) => c.objectId)).toEqual([
      "memory-1",
      "memory-2"
    ]);
    expect(memoryEntryCandidates[0]?.sourceRank).toBe(2);
    expect(memoryEntryCandidates[1]?.sourceRank).toBe(3);
  });

  it("carries sessionId and the gold's original recall rank in the gold-only path", () => {
    const results = [
      { object_id: "capsule-1", object_kind: "synthesis_capsule" },
      { object_id: "memory-gold", object_kind: "memory_entry" },
      { object_id: "memory-decoy", object_kind: "memory_entry" }
    ];
    const sidecar = new Map<string, { content?: string; sessionId?: string | null }>([
      ["memory-gold", { content: "gold fact", sessionId: "session-gold" }],
      ["memory-absent", { content: "absent gold", sessionId: "session-absent" }]
    ]);

    const { goldOnly } = buildQaDeliveredCandidates({
      results,
      goldMemoryIds: ["memory-gold", "memory-absent"],
      lookupMemoryEntry: (objectId) => sidecar.get(objectId)
    });

    const recalledGold = goldOnly.find((c) => c.objectId === "memory-gold");
    expect(recalledGold?.sessionId).toBe("session-gold");
    expect(recalledGold?.sourceRank).toBe(2);

    // Gold absent from results carries its session but no recall rank.
    const absentGold = goldOnly.find((c) => c.objectId === "memory-absent");
    expect(absentGold?.sessionId).toBe("session-absent");
    expect(absentGold?.sourceRank).toBeUndefined();
  });

  it("does not borrow a same-id synthesis capsule rank for memory gold-only delivery", () => {
    const results = [
      { object_id: "shared-object", object_kind: "synthesis_capsule" }
    ];
    const memorySidecar = new Map<string, { content?: string; sessionId?: string | null }>([
      ["shared-object", { content: "memory gold fact", sessionId: "session-gold" }]
    ]);
    const synthesisSidecar = new Map<string, { content?: string; sessionId?: string | null }>([
      ["shared-object", { content: "session summary", sessionId: "session-gold" }]
    ]);

    const { deliveryCandidates, goldOnly } = buildQaDeliveredCandidates({
      results,
      goldMemoryIds: ["shared-object"],
      lookupMemoryEntry: (objectId) => memorySidecar.get(objectId),
      lookupCandidate: (objectKind, objectId) =>
        objectKind === "synthesis_capsule"
          ? synthesisSidecar.get(objectId)
          : memorySidecar.get(objectId)
    });

    expect(deliveryCandidates[0]).toMatchObject({
      objectId: "shared-object",
      objectKind: "synthesis_capsule",
      sourceRank: 1
    });
    expect(goldOnly[0]).toMatchObject({
      objectId: "shared-object",
      content: "memory gold fact",
      sessionId: "session-gold"
    });
    expect(goldOnly[0]?.sourceRank).toBeUndefined();
  });
});

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

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
