import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readLatest,
  verifiedLongMemEvalEvidenceMatches,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildVerifiedPriorArchivePayload
} from "../longmemeval-runner-fixture.js";
import { readDiagnosticsGzipStream } from
  "../../../longmemeval/diagnostics/artifact-gzip-reader.js";
import {
  createVerifiedHistoryAuthority,
  writeVerifiedHistoryArchive
} from "../verified-history-archive-fixture.js";
import { buildRunnerQuestions, readJson } from "./fixture.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "verified-prior-integration-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("Tier 1 verified prior fixture", () => {
  it.each([
    ["public-multiturn" as const, "multiturn"],
    ["public-crossquestion" as const, "crossquestion"]
  ])("writes release-size %s evidence through real pointers", async (benchName, label) => {
    const fixture = buildVerifiedFixture(benchName, label);
    const authority = createVerifiedHistoryAuthority({
      historyRoot: fixture.historyRoot,
      datasetSha256: fixture.datasetSha256,
      questions: fixture.questions
    });
    const written = await writeVerifiedHistoryArchive({
      layout: authority.layout,
      slug: fixture.slug,
      payload: fixture.payload
    });

    expect(verifiedLongMemEvalEvidenceMatches(
      fixture.payload,
      written.evidenceContext
    )).toBe(true);
    await assertVerifiedPointers(authority.layout, fixture);
    await assertValidFullDiagnostics(written.entry.kpiPath, fixture.payload);
  });
});

function buildVerifiedFixture(
  benchName: "public-multiturn" | "public-crossquestion",
  label: string
) {
  const questions = buildRunnerQuestions(`q-${label}-`, 500);
  const datasetSha256 = createHash("sha256")
    .update(JSON.stringify(questions), "utf8")
    .digest("hex");
  const slug = "2026-05-15T120000Z-aaa1111";
  const historyRoot = join(tmpRoot, `history-${label}`);
  const payload = buildVerifiedPriorArchivePayload({
    benchName,
    datasetName: `longmemeval_s:${label}`,
    datasetSha256,
    questions,
    runAt: "2026-05-15T12:00:00.000Z",
    commitSha7: "aaa1111"
  });
  return { questions, datasetSha256, slug, historyRoot, payload };
}

async function assertVerifiedPointers(
  layout: Parameters<typeof readLatest>[0],
  fixture: ReturnType<typeof buildVerifiedFixture>
): Promise<void> {
  const benchRoot = join(fixture.historyRoot, fixture.payload.bench_name);
  const latestRun = await readJson<{ slug: string }>(join(benchRoot, "latest-run.json"));
  const latestPassing = await readJson<{ slug: string }>(
    join(benchRoot, "latest-passing.json")
  );
  expect(latestRun.slug).toBe(fixture.slug);
  expect(latestPassing.slug).toBe(fixture.slug);
  const passing = await readLatest(layout, fixture.payload.bench_name, {
    pointerKind: "passing"
  });
  expect(passing?.run_at).toBe(fixture.payload.run_at);
  expect(passing).toMatchObject({
    alaya_version: "0.3.11",
    sample_size: 500,
    evaluated_count: 500
  } satisfies Partial<KpiPayload>);
}

async function assertValidFullDiagnostics(
  kpiPath: string,
  payload: KpiPayload
): Promise<void> {
  const diagnostics = await readDiagnosticsGzipStream(
    join(dirname(kpiPath), "longmemeval-diagnostics.json.gz")
  );
  expect(diagnostics.questions).toHaveLength(payload.evaluated_count);
  expect(diagnostics.provider_state_summary).toMatchObject({
    total: payload.evaluated_count,
    provider_not_requested: payload.evaluated_count,
    provider_not_requested_rate: 1
  });
  expect(diagnostics.questions.filter((row) => row.hit_at_5)).toHaveLength(
    payload.kpi.per_scenario.filter((row) => row.hit_at_5).length
  );
  expect(diagnostics.questions.every((row) =>
    row.candidate_pool_complete && row.cohort_ledger?.evidence_status === "complete"
  )).toBe(true);
  expect(diagnostics.miss_taxonomy_summary).toEqual({
    candidate_absent: 0,
    materialization_drop: 0,
    budget_drop: 0,
    delivery_order_drop: 0,
    answer_set_coverage_drop: 0,
    evaluation_or_gold_issue: 0
  });
  expect(diagnostics.questions[0]).toMatchObject({
    recall_diagnostics_present: true,
    candidate_pool_complete: true,
    provider_state: "provider_not_requested",
    delivered_results: [expect.objectContaining({ rank: 1 })],
    candidates: [expect.objectContaining({ final_rank: 1 })],
    cohort_ledger: expect.objectContaining({
      candidate_pool_complete: true,
      evidence_status: "complete"
    })
  });
}
