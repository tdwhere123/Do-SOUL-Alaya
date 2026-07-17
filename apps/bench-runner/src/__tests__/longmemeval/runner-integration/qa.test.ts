import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KpiPayloadSchema } from "@do-soul/alaya-eval";
import { LONGMEMEVAL_COHORT_LEDGER_FILENAME } from
  "../../../longmemeval/selection/cohort-ledger.js";
import { LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME } from
  "../../../longmemeval/provenance/evidence-manifest.js";
import { QaChatError } from "../../../longmemeval/qa/qa-chat.js";
import { runLongMemEval } from "../../../longmemeval/runner.js";
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
  await rm(tmpRoot, { recursive: true, force: true });
});

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

it("records transient QA failures in diagnostics and evidence", async () => {
  const fixture = await createRunnerFixture({
    root: tmpRoot,
    label: "qa-failure",
    variant: "longmemeval_oracle",
    questions: buildRunnerQuestions("q", 2)
  });
  const result = await runLongMemEval({
    ...fixture,
    limit: 2,
    policyShape: "chat",
    qa: {
      chat: transientQaChat,
      answerModel: "mock-answer-model",
      judgeModel: "mock-judge-model"
    }
  });

  await assertQaFailureArchive(result);
}, 180_000);

async function transientQaChat(system: string, user: string): Promise<string> {
  if (!/grader/iu.test(system) && /topic q002/iu.test(user)) {
    throw new QaChatError("transient qa failure");
  }
  return /grader/iu.test(system) ? "yes" : "The stored fact answers this.";
}

async function assertQaFailureArchive(result: {
  readonly diagnosticsPath: string | null;
  readonly kpiPath: string;
}): Promise<void> {
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
  expect(kpi).toMatchObject({ evaluated_count: 1, answerable_evaluated_count: 1 });
  expect(kpi.kpi.per_scenario).toHaveLength(1);
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
