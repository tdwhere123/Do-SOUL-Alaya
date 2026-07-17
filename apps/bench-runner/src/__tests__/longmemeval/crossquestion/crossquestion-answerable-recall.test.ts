import { KpiPayloadSchema } from "@do-soul/alaya-eval";
import { describe, expect, it } from "vitest";
import { buildCrossQuestionPayload } from "../../../longmemeval/crossquestion/crossquestion-payload.js";
import type {
  CrossQuestionExecutionResult,
  CrossQuestionRunContext
} from "../../../longmemeval/crossquestion/crossquestion-run.js";
import { createLongMemEvalSelectionContract } from "../../../longmemeval/selection/contract.js";
import { buildMockQuestion } from "../runner/longmemeval-runner-fixture.js";
import {
  emptySeedResult,
  emptyTokenMetrics,
  measurementDiagnostic,
  seedStats,
  type MeasurementStatus
} from "../recall-eval/specialized-answerable-recall-fixture.js";

describe("cross-question answerable recall", () => {
  it("excludes abstention and identity failures from headline and halves", () => {
    const rows = fixtureRows();
    const questions = rows.map((row) => buildMockQuestion(row.id, `session-${row.id}`));
    const result = buildCrossQuestionPayload(
      contextForQuestions(questions),
      executionFor(rows)
    );

    expect(result.payload.answerable_evaluated_count).toBe(2);
    expect(result.payload.kpi).toMatchObject({
      r_at_1: 0.5,
      r_at_5: 0.5,
      r_at_10: 0.5,
      r_at_5_first_half: 1,
      r_at_5_last_half: 0,
      r_at_5_overall: 1 / 6,
      crossquestion_questions: 6
    });
    expect(() => KpiPayloadSchema.parse(result.payload)).not.toThrow();
  });
});

interface FixtureRow {
  readonly id: string;
  readonly status: MeasurementStatus;
  readonly hit: boolean;
}

function fixtureRows(): readonly FixtureRow[] {
  return [
    { id: "cq-first-hit", status: "scorable", hit: true },
    { id: "cq-first-abs_abs", status: "abstention", hit: false },
    { id: "cq-first-identity", status: "identity_unscorable", hit: false },
    { id: "cq-last-miss", status: "scorable", hit: false },
    { id: "cq-last-abs_abs", status: "abstention", hit: false },
    { id: "cq-last-identity", status: "identity_unscorable", hit: false }
  ];
}

function executionFor(rows: readonly FixtureRow[]): CrossQuestionExecutionResult {
  return {
    collected: rows.map((row, index) => ({
      questionId: row.id,
      questionIndex: index,
      hitAt1: row.hit,
      hitAt5: row.hit,
      hitAt10: row.hit,
      firstTier: "warm" as const,
      latencyMs: 1,
      degradationReason: null,
      seedTurnsTruncated: 0,
      answerTurnsTruncated: 0,
      seedCharsClipped: 0,
      diagnostics: measurementDiagnostic(row.id, row.status, row.hit),
      recallTokenEconomy: null
    })),
    tokenEconomyInput: emptyTokenMetrics(),
    seedStats: seedStats()
  };
}

function contextForQuestions(
  questions: readonly ReturnType<typeof buildMockQuestion>[]
): CrossQuestionRunContext {
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
    selectionContract: createLongMemEvalSelectionContract({ datasetSha256, questions }),
    alayaVersion: "0.3.11",
    commitInfo: { source: "git", raw: "abc1234", sha7: "abc1234" },
    commitSha7: "abc1234",
    runAt: new Date("2026-07-16T00:00:00.000Z"),
    embeddingProviderLabel: "openai:test",
    seedRunner: { stats: seedStats(), seedTurn: async () => emptySeedResult() }
  } as unknown as CrossQuestionRunContext;
}
