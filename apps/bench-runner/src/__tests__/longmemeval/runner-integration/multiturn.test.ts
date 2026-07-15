import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readExternalDiagnosticsArtifact } from
  "../../../longmemeval/diagnostics-artifacts.js";
import { runLongMemEvalMultiturn } from "../../../longmemeval/multiturn.js";
import {
  assertPartialTierOneArchive,
  buildRunnerQuestions,
  createRunnerFixture,
  readJson,
  stubOfflineExtractionEnv
} from "./fixture.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "lme-multiturn-integration-"));
  stubOfflineExtractionEnv();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("LongMemEval multiturn archive integration", () => {
  it("archives only final rows for qualification and all rounds in gzip", async () => {
    const fixture = await createRunnerFixture({
      root: tmpRoot,
      label: "multiturn",
      variant: "longmemeval_s",
      questions: buildRunnerQuestions("qmt", 1)
    });
    const result = await runLongMemEvalMultiturn({
      ...fixture,
      limit: 1,
      rounds: 2
    });

    expect(result.payload.bench_name).toBe("public-multiturn");
    expect(result.payload.diff_vs_previous).toBeNull();
    expect(result.payload.kpi.multiturn_rounds).toBe(2);
    expect(result.payload.kpi.r_at_5_round_n).toBe(result.payload.kpi.r_at_5);
    await assertPartialTierOneArchive({
      result,
      historyRoot: fixture.historyRoot,
      benchName: "public-multiturn",
      otherBenchName: "public-crossquestion"
    });
    await assertMultiturnDiagnostics(result);
  }, 180_000);
});

async function assertMultiturnDiagnostics(result: {
  readonly kpiPath: string;
  readonly diagnosticsPath: string | null;
}): Promise<void> {
  const diagnostics = await readJson<{
    bench_name: string;
    question_count: number;
    full_diagnostics_artifact_path: string;
    questions?: unknown[];
    round_diagnostics?: unknown[];
  }>(result.diagnosticsPath!);
  expect(diagnostics).toMatchObject({
    bench_name: "public-multiturn",
    question_count: 1
  });
  expect(diagnostics.questions).toHaveLength(1);
  expect(diagnostics.round_diagnostics).toBeUndefined();
  const full = JSON.parse(await readExternalDiagnosticsArtifact(join(
    dirname(result.kpiPath),
    diagnostics.full_diagnostics_artifact_path
  ))) as {
    questions: Array<{ round_index: number | null }>;
    round_diagnostics: Array<{ round_index: number | null }>;
  };
  expect(full.questions.map((row) => row.round_index)).toEqual([2]);
  expect(full.round_diagnostics.map((row) => row.round_index)).toEqual([1, 2]);
}
