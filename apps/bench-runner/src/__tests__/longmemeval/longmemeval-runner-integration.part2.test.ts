import { createHash } from "node:crypto";

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KpiPayloadSchema, type KpiPayload } from "@do-soul/alaya-eval";

import { LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME } from "../../longmemeval/archive-evidence.js";

import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";

import { QaChatError } from "../../longmemeval/qa-chat.js";

import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";

import { runLongMemEvalMultiturn } from "../../longmemeval/multiturn.js";

import { runLongMemEvalCrossQuestion } from "../../longmemeval/crossquestion.js";

import {
  buildLongMemEvalSidecarKey,
  buildLongMemEvalReportContextUsage,
  deriveLongMemEvalGoldMemoryIds,
  resolveBenchEmbeddingProviderLabel,
  runLongMemEval,
  runLongMemEvalRecallCycle,
  scoreLongMemEvalRecallHits
} from "../../longmemeval/runner.js";

import {
  buildLongMemEvalArchivePayload,
  buildMockQuestion,
  writeArchiveEntry
} from "./longmemeval-runner-fixture.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lme-test-"));
  // These runs take the no-credentials offline seed path; the model value is
  // never used for a live call. Each run below passes an isolated
  // extractionCacheRoot (no manifest -> first-ever-build preflight), so this
  // model is arbitrary and the tests are decoupled from the production
  // extraction-cache manifest's model.
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "test-extraction-model");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("LongMemEval runner", () => {

  it(
    "scores end-to-end QA over delivered recall when --qa is injected",
    async () => {
      // Integration: a real runLongMemEval pass (offline seed + MCP recall) with
      // a mock qa.chat. Mock answer LLM echoes a non-empty answer; mock judge
      // returns yes — exercising scoreQaQuestion + aggregateQaVerdicts wiring
      // through the runner with zero network / zero cost. Asserts the kpi gains a
      // qa_metrics block with qa_total > 0 (the B1.f end-to-end coverage).
      const dataDir = join(tmpDir, "longmemeval-qa");
      await mkdir(dataDir, { recursive: true });
      const historyRoot = join(tmpDir, "history-qa");

      const mockQuestions: LongMemEvalQuestion[] = [
        buildMockQuestion("q001", "session-a"),
        buildMockQuestion("q002", "session-b")
      ];

      const variant = "longmemeval_oracle";
      const datasetRaw = JSON.stringify(mockQuestions);
      const datasetSha = createHash("sha256").update(datasetRaw, "utf8").digest("hex");
      await writeFile(join(dataDir, `${variant}.json`), datasetRaw, "utf8");
      await writeFile(
        join(dataDir, `${variant}.meta.json`),
        JSON.stringify({ variant, sha256: datasetSha, questionCount: 2 }),
        "utf8"
      );

      const pinnedMetaRoot = join(tmpDir, "pinned-meta-qa");
      await mkdir(pinnedMetaRoot, { recursive: true });
      await writeFile(
        join(pinnedMetaRoot, `${variant}.meta.json`),
        JSON.stringify({
          name: variant,
          sha256: datasetSha,
          question_count: 2,
          first_pinned_at: "2026-05-14T00:00:00Z",
          pinned_by_commit: "test"
        }),
        "utf8"
      );

      // Mock chat: system carrying the strict-grader prompt -> yes (one-word
      // anscheck verdict); otherwise an arbitrary non-empty answer. In-process.
      const chatCalls: Array<{ system: string; user: string }> = [];
      const mockChat = async (system: string, user: string): Promise<string> => {
        chatCalls.push({ system, user });
        return /grader/iu.test(system) ? "yes" : "The stored fact answers this.";
      };

      const result = await runLongMemEval({
        variant,
        limit: 2,
        historyRoot,
        dataDir,
        pinnedMetaRoot,
        policyShape: "chat",
        qa: {
          chat: mockChat,
          answerModel: "mock-answer-model",
          judgeModel: "mock-judge-model"
        },
        extractionCacheRoot: join(tmpDir, "extraction-cache-qa")
      });

      const parseResult = KpiPayloadSchema.safeParse(result.payload);
      expect(parseResult.success).toBe(true);

      const qaMetrics = result.payload.kpi.qa_metrics;
      expect(qaMetrics).toBeDefined();
      expect(qaMetrics?.qa_total).toBeGreaterThan(0);
      expect(qaMetrics?.qa_total).toBe(2);
      expect(qaMetrics?.qa_correct).toBe(2);
      expect(qaMetrics?.qa_accuracy).toBe(1);
      expect(qaMetrics?.answer_model).toBe("mock-answer-model");
      expect(qaMetrics?.judge_model).toBe("mock-judge-model");
      // 2 questions × (1 answer call + 1 judge call), all in-process.
      expect(chatCalls.length).toBe(4);
    },
    180_000
  );

  it(
    "records skipped QA questions in diagnostics metadata when a transient QA chat fails",
    async () => {
      const dataDir = join(tmpDir, "longmemeval-qa-failure");
      await mkdir(dataDir, { recursive: true });
      const historyRoot = join(tmpDir, "history-qa-failure");

      const mockQuestions: LongMemEvalQuestion[] = [
        buildMockQuestion("q001", "session-a"),
        buildMockQuestion("q002", "session-b")
      ];

      const variant = "longmemeval_oracle";
      const datasetRaw = JSON.stringify(mockQuestions);
      const datasetSha = createHash("sha256").update(datasetRaw, "utf8").digest("hex");
      await writeFile(join(dataDir, `${variant}.json`), datasetRaw, "utf8");
      await writeFile(
        join(dataDir, `${variant}.meta.json`),
        JSON.stringify({ variant, sha256: datasetSha, questionCount: 2 }),
        "utf8"
      );

      const pinnedMetaRoot = join(tmpDir, "pinned-meta-qa-failure");
      await mkdir(pinnedMetaRoot, { recursive: true });
      await writeFile(
        join(pinnedMetaRoot, `${variant}.meta.json`),
        JSON.stringify({
          name: variant,
          sha256: datasetSha,
          question_count: 2,
          first_pinned_at: "2026-05-14T00:00:00Z",
          pinned_by_commit: "test"
        }),
        "utf8"
      );

      const qaChat = async (system: string, user: string): Promise<string> => {
        if (!/grader/iu.test(system) && /topic q002/iu.test(user)) {
          throw new QaChatError("transient qa failure");
        }
        return /grader/iu.test(system) ? "yes" : "The stored fact answers this.";
      };

      const result = await runLongMemEval({
        variant,
        limit: 2,
        historyRoot,
        dataDir,
        pinnedMetaRoot,
        policyShape: "chat",
        qa: {
          chat: qaChat,
          answerModel: "mock-answer-model",
          judgeModel: "mock-judge-model"
        },
        extractionCacheRoot: join(tmpDir, "extraction-cache-qa-failure")
      });

      const diagnostics = JSON.parse(
        await readFile(result.diagnosticsPath!, "utf8")
      ) as {
        question_failures?: {
          failed_count: number;
          completed_count: number;
          failed_question_ids: string[];
        };
      };

      expect(diagnostics.question_failures).toEqual({
        failed_count: 1,
        completed_count: 1,
        failed_question_ids: ["q002"]
      });
    },
    180_000
  );

  it(
    "archives public-multiturn runs with round KPIs and diagnostics sidecar",
    async () => {
      const dataDir = join(tmpDir, "longmemeval-multiturn");
      await mkdir(dataDir, { recursive: true });
      const historyRoot = join(tmpDir, "history-multiturn");

      const mockQuestions: LongMemEvalQuestion[] = [
        buildMockQuestion("qmt001", "session-a")
      ];
      const variant = "longmemeval_s";
      const datasetRaw = JSON.stringify(mockQuestions);
      const datasetSha = createHash("sha256").update(datasetRaw, "utf8").digest("hex");
      await writeFile(join(dataDir, `${variant}.json`), datasetRaw, "utf8");
      await writeFile(
        join(dataDir, `${variant}.meta.json`),
        JSON.stringify({ variant, sha256: datasetSha, questionCount: 1 }),
        "utf8"
      );
      const pinnedMetaRoot = join(tmpDir, "pinned-meta-multiturn");
      await mkdir(pinnedMetaRoot, { recursive: true });
      await writeFile(
        join(pinnedMetaRoot, `${variant}.meta.json`),
        JSON.stringify({
          name: variant,
          sha256: datasetSha,
          question_count: 1,
          first_pinned_at: "2026-05-15T00:00:00Z",
          pinned_by_commit: "test"
        }),
        "utf8"
      );
      const priorPassingRunAt = "2026-05-15T12:00:00.000Z";
      await writeArchiveEntry(
        historyRoot,
        "public-multiturn",
        "2026-05-15T120000Z-aaa1111",
        buildLongMemEvalArchivePayload({
          bench_name: "public-multiturn",
          split: "longmemeval-s",
          run_at: priorPassingRunAt,
          alaya_commit: "aaa1111",
          dataset: {
            name: "longmemeval_s:multiturn",
            size: 1,
            source: "fixture"
          }
        })
      );
      await writeArchiveEntry(
        historyRoot,
        "public-multiturn",
        "2026-05-15T130000Z-bbb2222",
        buildLongMemEvalArchivePayload({
          bench_name: "public-multiturn",
          split: "longmemeval-s",
          run_at: "2026-05-15T13:00:00.000Z",
          alaya_commit: "bbb2222",
          dataset: {
            name: "longmemeval_s:multiturn",
            size: 1,
            source: "fixture"
          }
        }),
        "# findings\n- regression\n"
      );

      const result = await runLongMemEvalMultiturn({
        variant,
        limit: 1,
        rounds: 2,
        historyRoot,
        dataDir,
        pinnedMetaRoot,
        extractionCacheRoot: join(tmpDir, "extraction-cache")
      });

      expect(result.payload.bench_name).toBe("public-multiturn");
      expect(result.payload.diff_vs_previous?.previous_run).toBe(priorPassingRunAt);
      expect(result.payload.kpi.multiturn_rounds).toBe(2);
      expect(result.payload.kpi.r_at_5_round_1).toBeGreaterThanOrEqual(0);
      expect(result.payload.kpi.r_at_5_round_n).toBe(result.payload.kpi.r_at_5);
      expect(result.diagnosticsPath).not.toBeNull();
      const diagnostics = JSON.parse(
        await readFile(result.diagnosticsPath!, "utf8")
      ) as {
        bench_name: string;
        question_count: number;
        full_diagnostics_artifact_path: string;
      };
      expect(diagnostics.bench_name).toBe("public-multiturn");
      expect(diagnostics.question_count).toBe(2);
      const fullDiagnostics = JSON.parse(
        await readFile(diagnostics.full_diagnostics_artifact_path, "utf8")
      ) as { questions: Array<{ round_index: number | null }> };
      expect(fullDiagnostics.questions.map((row) => row.round_index)).toEqual([1, 2]);
    },
    180_000
  );

  it(
    "archives public-crossquestion runs with compact diagnostics and external full artifact",
    async () => {
      const dataDir = join(tmpDir, "longmemeval-crossquestion");
      await mkdir(dataDir, { recursive: true });
      const historyRoot = join(tmpDir, "history-crossquestion");

      const mockQuestions: LongMemEvalQuestion[] = [
        buildMockQuestion("qcq001", "session-a")
      ];
      const variant = "longmemeval_s";
      const datasetRaw = JSON.stringify(mockQuestions);
      const datasetSha = createHash("sha256").update(datasetRaw, "utf8").digest("hex");
      await writeFile(join(dataDir, `${variant}.json`), datasetRaw, "utf8");
      await writeFile(
        join(dataDir, `${variant}.meta.json`),
        JSON.stringify({ variant, sha256: datasetSha, questionCount: 1 }),
        "utf8"
      );
      const pinnedMetaRoot = join(tmpDir, "pinned-meta-crossquestion");
      await mkdir(pinnedMetaRoot, { recursive: true });
      await writeFile(
        join(pinnedMetaRoot, `${variant}.meta.json`),
        JSON.stringify({
          name: variant,
          sha256: datasetSha,
          question_count: 1,
          first_pinned_at: "2026-05-15T00:00:00Z",
          pinned_by_commit: "test"
        }),
        "utf8"
      );
      const priorPassingRunAt = "2026-05-16T12:00:00.000Z";
      await writeArchiveEntry(
        historyRoot,
        "public-crossquestion",
        "2026-05-16T120000Z-aaa1111",
        buildLongMemEvalArchivePayload({
          bench_name: "public-crossquestion",
          split: "longmemeval-s",
          run_at: priorPassingRunAt,
          alaya_commit: "aaa1111",
          dataset: {
            name: "longmemeval_s:crossquestion",
            size: 1,
            source: "fixture"
          }
        })
      );
      await writeArchiveEntry(
        historyRoot,
        "public-crossquestion",
        "2026-05-16T130000Z-bbb2222",
        buildLongMemEvalArchivePayload({
          bench_name: "public-crossquestion",
          split: "longmemeval-s",
          run_at: "2026-05-16T13:00:00.000Z",
          alaya_commit: "bbb2222",
          dataset: {
            name: "longmemeval_s:crossquestion",
            size: 1,
            source: "fixture"
          }
        }),
        "# findings\n- regression\n"
      );

      const result = await runLongMemEvalCrossQuestion({
        variant,
        limit: 1,
        historyRoot,
        dataDir,
        pinnedMetaRoot,
        extractionCacheRoot: join(tmpDir, "extraction-cache")
      });

      expect(result.payload.bench_name).toBe("public-crossquestion");
      expect(result.payload.diff_vs_previous?.previous_run).toBe(priorPassingRunAt);
      expect(result.diagnosticsPath).not.toBeNull();
      const diagnostics = JSON.parse(
        await readFile(result.diagnosticsPath!, "utf8")
      ) as {
        bench_name: string;
        question_count: number;
        questions?: unknown;
        full_diagnostics_artifact_path: string;
      };
      expect(diagnostics.bench_name).toBe("public-crossquestion");
      expect(diagnostics.question_count).toBe(1);
      expect(diagnostics.questions).toBeUndefined();
      expect(diagnostics.full_diagnostics_artifact_path).not.toContain(
        join("docs", "bench-history")
      );
      const fullDiagnostics = JSON.parse(
        await readFile(diagnostics.full_diagnostics_artifact_path, "utf8")
      ) as { questions: Array<{ question_id: string }> };
      expect(fullDiagnostics.questions).toHaveLength(1);
      expect(fullDiagnostics.questions[0]?.question_id).toBe("qcq001");
    },
    180_000
  );
});
