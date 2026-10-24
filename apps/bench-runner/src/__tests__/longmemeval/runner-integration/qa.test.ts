import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { KpiPayloadSchema } from "@do-soul/alaya-eval";
import { LONGMEMEVAL_COHORT_LEDGER_FILENAME, renderLongMemEvalCohortLedger } from
  "../../../runs/selection/cohort-ledger.js";
import { LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME } from
  "../../../runs/provenance/evidence-manifest.js";
import { QaChatError } from "../../../runs/qa/qa-chat.js";
import { runLongMemEval, type LongMemEvalRunResult } from "../../../datasets/longmemeval/runner.js";
import { readLongMemEvalDiagnosticsSidecar } from "../../../runs/archive/archive-evidence.js";
import { buildMergedLongMemEvalDiagnosticsSidecar } from "../../../cli/merge-sidecar.js";
import {
  buildRunnerQuestions,
  createRunnerFixture,
  readJson,
  stubOfflineExtractionEnv
} from "./fixture.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "lme-qa-integration-"));
  stubOfflineExtractionEnv();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
  expect(boundary.violations).toEqual([]);
});
afterAll(() => boundary.restore());

it("scores end-to-end QA over delivered recall", async () => {
  const fixture = await createRunnerFixture({
    root: tmpRoot,
    label: "qa",
    variant: "longmemeval_oracle",
    questions: buildRunnerQuestions("q", 2)
  });
  const chatCalls: Array<{ system: string; user: string }> = [];
  const result = await runLongMemEval({
    ...fixture,
    limit: 2,
    policyShape: "chat",
    qa: {
      chat: async (system, user) => {
        chatCalls.push({ system, user });
        return /grader/iu.test(system) ? "yes" : "The stored fact answers this.";
      },
      answerModel: "mock-answer-model",
      judgeModel: "mock-judge-model"
    }
  });

  expect(KpiPayloadSchema.safeParse(result.payload).success).toBe(true);
  expect(result.payload.kpi.qa_metrics).toMatchObject({
    qa_total: 2,
    qa_correct: 2,
    qa_accuracy: 1,
    answer_model: "mock-answer-model",
    judge_model: "mock-judge-model"
  });
  expect(chatCalls).toHaveLength(4);
}, 180_000);

it.each(["answer", "judge"] as const)("retains Recall in collection and archive after a terminal QA %s failure", async (stage) => {
  const fixture = await createRunnerFixture({
    root: tmpRoot,
    label: "qa-failure",
    variant: "longmemeval_oracle",
    questions: buildRunnerQuestions("q", 2)
  });
  const failure = new QaChatError("transient qa failure");
  const chat = vi.fn(async (_system: string, user: string) => {
    if (stage === "answer" && /topic q002/iu.test(user)) throw failure;
    return "The stored fact answers this.";
  });
  const judgeChat = vi.fn(async () => "yes").mockResolvedValueOnce("yes");
  if (stage === "judge") judgeChat.mockRejectedValueOnce(failure);
  const errors: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  const result = await runLongMemEval({
    ...fixture,
    limit: 2,
    policyShape: "chat",
    qa: {
      chat,
      judgeChat,
      answerModel: "mock-answer-model",
      judgeModel: "mock-judge-model"
    }
  });

  expect(chat).toHaveBeenCalledTimes(2);
  expect(judgeChat).toHaveBeenCalledTimes(stage === "answer" ? 1 : 2);
  expect(errors.join("")).toContain("FAILED — transient qa failure");
  expect(result.evidenceContext).toBeNull();
  await assertQaFailureArchive(result, fixture.historyRoot);
}, 180_000);

async function assertQaFailureArchive(
  result: LongMemEvalRunResult,
  historyRoot: string
): Promise<void> {
  const diagnostics = await readJson<{
    question_failures?: {
      failed_count: number;
      completed_count: number;
      failed_question_ids: string[];
    };
  }>(result.diagnosticsPath!);
  expect(diagnostics.question_failures).toEqual({
    failed_count: 1,
    completed_count: 1,
    failed_question_ids: ["q002"]
  });
  const kpi = KpiPayloadSchema.parse(JSON.parse(await readFile(result.kpiPath, "utf8")));
  const cohort = await readJson<{ rows: Array<{ question_id: string }> }>(
    join(dirname(result.kpiPath), LONGMEMEVAL_COHORT_LEDGER_FILENAME)
  );
  expect(cohort.rows.find((row) => row.question_id === "q001")).toMatchObject({
    dataset_cohort: "answerable",
    extraction_materialization: { status: "memory_emitted" },
    evaluator_gold_identity: { status: "present", object_ids: expect.arrayContaining([expect.any(String)]) }
  });
  expect(kpi).toMatchObject({ evaluated_count: 2, answerable_evaluated_count: 2 });
  expect(kpi.kpi.qa_metrics).toMatchObject({ qa_total: 1, qa_correct: 1, qa_accuracy: 1 });
  expect(kpi.kpi.per_scenario.map((row) => row.id)).toEqual(["q001", "q002"]);
  const full = await readLongMemEvalDiagnosticsSidecar({ historyRoot }, "public", result.slug);
  expect(full?.questions.map((question) => question.question_id)).toEqual(["q001", "q002"]);
  const retained = full!.questions[1]!;
  expect(retained.delivered_results.length).toBeGreaterThan(0);
  const merged = buildMergedLongMemEvalDiagnosticsSidecar(kpi, [full], {
    report_side_effects: null, scored_recall_evidence: null
  });
  expect(merged.sidecar.question_failures).toEqual(diagnostics.question_failures);
  const mergedLedger = JSON.parse(renderLongMemEvalCohortLedger(
    merged.sidecar.questions, merged.failed_question_ids
  ));
  expect(mergedLedger.rows).toHaveLength(2);
  // Mixed native Recall retains the delivered memory evidence, but an unwired
  // source-index lane cannot certify a complete candidate population.
  expect(mergedLedger.rows[1]).toMatchObject({ question_id: "q002", evidence_status: "partial" });
  expect(kpi.kpi.per_scenario[1]).toMatchObject({
    id: retained.question_id, hit_at_5: retained.hit_at_5, scorable: true
  });
  expect(cohort.rows[1]).toMatchObject({
    question_id: "q002", evidence_status: "partial", candidate_pool_complete: false
  });
  expect(kpi.kpi.r_at_5).toBe(
    kpi.kpi.per_scenario.filter((row) => row.hit_at_5).length / 2
  );
  expect(kpi.measurement_attribution).toMatchObject({
    gate_eligible: false, candidate_pool_complete: false
  });
  await expect(readFile(join(historyRoot, "public", "latest-passing.json"), "utf8"))
    .rejects.toMatchObject({ code: "ENOENT" });
  await assertQaEvidenceFiles(dirname(result.kpiPath));
}

async function assertQaEvidenceFiles(archiveRoot: string): Promise<void> {
  const cohort = await readJson<{ question_count: number; rows: unknown[] }>(
    join(archiveRoot, LONGMEMEVAL_COHORT_LEDGER_FILENAME)
  );
  const manifest = await readJson<{
    evidence_status: string;
    artifacts: Array<{ role: string }>;
  }>(join(archiveRoot, LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME));
  expect(cohort).toMatchObject({ question_count: 2 });
  expect(cohort.rows).toHaveLength(2);
  expect(manifest.evidence_status).toBe("partial");
  expect(manifest.artifacts.map(({ role }) => role)).toEqual(expect.arrayContaining([
    "kpi", "diagnostics", "full_diagnostics", "cohort_ledger", "run_provenance"
  ]));
}
