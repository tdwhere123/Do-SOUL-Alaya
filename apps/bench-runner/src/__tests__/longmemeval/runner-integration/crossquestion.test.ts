import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readExternalDiagnosticsArtifact } from
  "../../../longmemeval/diagnostics-artifacts.js";
import { runLongMemEvalCrossQuestion } from "../../../longmemeval/crossquestion.js";
import {
  assertPartialTierOneArchive,
  buildRunnerQuestions,
  createRunnerFixture,
  readJson,
  stubOfflineExtractionEnv
} from "./fixture.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "lme-crossquestion-integration-"));
  stubOfflineExtractionEnv();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("LongMemEval crossquestion archive integration", () => {
  it("archives one compact and full diagnostic row per question", async () => {
    const fixture = await createRunnerFixture({
      root: tmpRoot,
      label: "crossquestion",
      variant: "longmemeval_s",
      questions: buildRunnerQuestions("qcq", 1)
    });
    const result = await runLongMemEvalCrossQuestion({ ...fixture, limit: 1 });

    expect(result.payload.bench_name).toBe("public-crossquestion");
    expect(result.payload.diff_vs_previous).toBeNull();
    await assertPartialTierOneArchive({
      result,
      historyRoot: fixture.historyRoot,
      benchName: "public-crossquestion",
      otherBenchName: "public-multiturn"
    });
    await assertCrossQuestionDiagnostics(result);
  }, 180_000);
});

async function assertCrossQuestionDiagnostics(result: {
  readonly kpiPath: string;
  readonly diagnosticsPath: string | null;
}): Promise<void> {
  const diagnostics = await readJson<{
    bench_name: string;
    question_count: number;
    questions?: unknown[];
    full_diagnostics_artifact_path: string;
  }>(result.diagnosticsPath!);
  expect(diagnostics).toMatchObject({
    bench_name: "public-crossquestion",
    question_count: 1
  });
  expect(diagnostics.questions).toHaveLength(1);
  expect(diagnostics.full_diagnostics_artifact_path).not.toContain("docs/bench-history");
  const full = JSON.parse(await readExternalDiagnosticsArtifact(join(
    dirname(result.kpiPath),
    diagnostics.full_diagnostics_artifact_path
  ))) as { questions: Array<{ question_id: string }> };
  expect(full.questions).toHaveLength(1);
  expect(full.questions[0]?.question_id).toBe("qcq001");
}
