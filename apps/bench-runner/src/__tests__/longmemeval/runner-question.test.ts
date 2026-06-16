import { afterEach, describe, expect, it, vi } from "vitest";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";
import type { BenchDaemonHandle, BenchWorkspaceHandle } from "../../harness/daemon.js";
import { runLongMemEvalQuestion } from "../../longmemeval/runner-question.js";
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

    await runLongMemEvalQuestion({
      daemon,
      question,
      turnIndex: 0,
      seedRunner: { seedTurn } as never,
      recallOptions: { maxResults: 10, conflictAwareness: false },
      simulateReport: "none",
      embeddingMode: "disabled",
      embeddingProviderKind: "openai",
      captureSnapshot: false,
      qaChat: answerChat,
      qaJudgeChat: judgeChat
    });

    expect(answerChat).toHaveBeenCalledTimes(1);
    const answerPrompt = answerChat.mock.calls[0]?.[1] ?? "";
    expect(countOccurrences(answerPrompt, "Duplicated gold turn.")).toBe(1);
    expect(countOccurrences(answerPrompt, "Unique gold turn.")).toBe(1);
    expect(answerPrompt).not.toContain("Distractor turn.");
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
