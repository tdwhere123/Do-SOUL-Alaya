import { describe, expect, it } from "vitest";
import { KpiPayloadSchema } from "@do-soul/alaya-eval";
import { buildQuestionDiagnostic } from "../../longmemeval/diagnostics.js";
import { buildMultiturnPayload } from "../../longmemeval/multiturn-payload.js";
import type {
  MultiturnExecutionResult,
  MultiturnRunContext
} from "../../longmemeval/multiturn-run.js";
import { createLongMemEvalSelectionContract } from
  "../../longmemeval/selection/contract.js";
import { buildMockQuestion } from "./longmemeval-runner-fixture.js";
import {
  emptySeedResult,
  emptyTokenMetrics,
  measurementDiagnostic,
  seedStats,
  type MeasurementStatus
} from "./specialized-answerable-recall-fixture.js";

describe("multiturn final-round qualification", () => {
  it("uses final rows for provider qualification while retaining every round", () => {
    const question = buildMockQuestion("q-final", "session-final");
    const payload = buildMultiturnPayload(
      contextFor(question),
      executionWithProviderTransition()
    );

    expect(payload.payload.kpi.provider_returned_rate).toBe(1);
    expect(payload.payload.kpi.provider_failed_rate).toBe(0);
    expect(payload.diagnosticsPayload.provider_state_summary).toMatchObject({
      total: 1,
      provider_returned: 1,
      provider_failed: 0
    });
    expect(payload.diagnosticsPayload.questions).toHaveLength(1);
    expect(payload.diagnosticsPayload.questions[0]?.round_index).toBe(2);
    expect(payload.diagnosticsPayload.round_diagnostics).toHaveLength(2);
  });

  it("excludes final-round abstentions from headline and round recall", () => {
    const questions = [
      buildMockQuestion("q-answerable", "session-answerable"),
      buildMockQuestion("q-abstention_abs", "session-abstention"),
      buildMockQuestion("q-identity", "session-identity")
    ];
    const result = buildMultiturnPayload(
      contextForQuestions(questions),
      executionWithAnswerableAndAbstention()
    );

    expect(result.payload.answerable_evaluated_count).toBe(1);
    expect(result.payload.kpi).toMatchObject({
      r_at_1: 1,
      r_at_5: 1,
      r_at_10: 1,
      r_at_5_round_1: 1,
      r_at_5_round_2: 1,
      r_at_5_round_n: 1,
      r_at_5_overall: 1 / 3
    });
    expect(() => KpiPayloadSchema.parse(result.payload)).not.toThrow();
  });
});

function contextFor(
  question: ReturnType<typeof buildMockQuestion>
): MultiturnRunContext {
  return contextForQuestions([question]);
}

function contextForQuestions(
  questions: readonly ReturnType<typeof buildMockQuestion>[]
): MultiturnRunContext {
  const datasetSha256 = "a".repeat(64);
  return {
    opts: {
      variant: "longmemeval_s",
      historyRoot: "/tmp/history",
      embeddingMode: "env",
      extractionCacheRoot: "/tmp/cache"
    },
    questions,
    window: questions,
    datasetSha256,
    datasetChecksumSource: "/fixture/meta.json",
    datasetSourcePath: "/fixture/data.json",
    releaseEvidenceAuthority: null,
    selectionContract: createLongMemEvalSelectionContract({
      datasetSha256,
      questions
    }),
    rounds: 2,
    alayaVersion: "0.3.11",
    commitInfo: { source: "git", raw: "abc1234", sha7: "abc1234" },
    commitSha7: "abc1234",
    runAt: new Date("2026-07-16T00:00:00.000Z"),
    embeddingProviderLabel: "openai:test",
    seedRunner: { stats: seedStats(), seedTurn: async () => emptySeedResult() }
  } as unknown as MultiturnRunContext;
}

function executionWithAnswerableAndAbstention(): MultiturnExecutionResult {
  return {
    collected: [
      resultWithRounds("q-answerable", "scorable", true),
      resultWithRounds("q-abstention_abs", "abstention", false),
      resultWithRounds("q-identity", "identity_unscorable", false)
    ]
  };
}

function resultWithRounds(
  questionId: string,
  status: MeasurementStatus,
  hit: boolean
): MultiturnExecutionResult["collected"][number] {
  return {
    questionId,
    rounds: [1, 2].map((index) => measurementRound(questionId, index, status, hit)),
    seedTurnsTruncated: 0,
    answerTurnsTruncated: 0,
    seedCharsClipped: 0,
    tokenMetrics: emptyTokenMetrics()
  };
}

function measurementRound(
  questionId: string,
  roundIndex: number,
  status: MeasurementStatus,
  hit: boolean
) {
  return {
    roundIndex,
    hitAt1: hit,
    hitAt5: hit,
    hitAt10: hit,
    firstTier: "warm" as const,
    latencyMs: 1,
    degradationReason: null,
    diagnostics: measurementDiagnostic(questionId, status, hit, roundIndex),
    recallTokenEconomy: null
  };
}

function executionWithProviderTransition(): MultiturnExecutionResult {
  return {
    collected: [{
      questionId: "q-final",
      rounds: [round(1, "provider_failed"), round(2, "provider_returned")],
      seedTurnsTruncated: 0,
      answerTurnsTruncated: 0,
      seedCharsClipped: 0,
      tokenMetrics: {
        raw_history_tokens: 0,
        stored_memory_tokens: 0,
        recalled_context_tokens_total: 0,
        recall_event_count: 0,
        recalled_context_tokens_mean: 0,
        seed_event_count: 0
      }
    }]
  };
}

function round(
  roundIndex: number,
  providerState: "provider_failed" | "provider_returned"
) {
  return {
    roundIndex,
    hitAt1: true,
    hitAt5: true,
    hitAt10: true,
    firstTier: "warm" as const,
    latencyMs: 1,
    degradationReason: null,
    diagnostics: buildQuestionDiagnostic({
      questionId: "q-final",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "env",
      roundIndex,
      recallResult: { diagnostics: { provider_state: providerState, candidates: [] } }
    }),
    recallTokenEconomy: null
  };
}
