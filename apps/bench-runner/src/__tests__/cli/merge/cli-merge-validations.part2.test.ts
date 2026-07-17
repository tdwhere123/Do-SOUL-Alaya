import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectReleaseHardGates, type KpiPayload } from "@do-soul/alaya-eval";

import { runCli } from "../../../cli/index.js";

import { LONGMEMEVAL_DIAGNOSTICS_FILENAME } from "./cli-merge-validations-fixture.js";

import { setupShard } from "./cli-merge-evidence-fixture.js";

import { createMergeDatasetSource } from "./cli-merge-dataset-fixture.js";

import {
  withEligibleMeasurementContract,
  makeQualityMetrics,
  makeShardDiagnostics,
  makeShardKpi,
  writeHistoryEntry,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

let tmpRoot: string;
let originalWrite: typeof process.stderr.write;
let stderrBuf: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "merge-validations-"));
  stderrBuf = "";
  originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrBuf += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stderr.write = originalWrite;
  await rm(tmpRoot, { recursive: true, force: true });
});

async function verifyMalformedQuestionCountRejected(): Promise<void> {
  const shard = path.join(tmpRoot, "shard-malformed-question-count");
  await writeShardRoot(
    shard,
    makeShardKpi({
      policy_shape: "chat",
      simulate_report: "mixed",
      kpi: {
        ...makeShardKpi().kpi,
        r_at_5: 1
      }
    }),
    makeShardDiagnostics({
      compact_schema_version: 1,
      question_count: "bad",
      questions: undefined,
      report_side_effects: undefined
    })
  );

  const exitCode = await runCli([
    "merge-longmemeval",
    "--variant",
    "s",
    "--history-root",
    path.join(tmpRoot, "history-malformed-question-count"),
    "--shards",
    shard
  ]);

  expect(exitCode).toBe(2);
  expect(stderrBuf).toContain(
    "invalid compact diagnostics question_count: expected non-negative integer"
  );
}

async function verifyMissingPointerRejected(): Promise<void> {
  const shard = path.join(tmpRoot, "shard-no-pointer");
  await mkdir(path.join(shard, "public"), { recursive: true });

  const historyRoot = path.join(tmpRoot, "history-no-pointer");
  const exitCode = await runCli([
    "merge-longmemeval",
    "--variant",
    "s",
    "--history-root",
    historyRoot,
    "--shards",
    shard
  ]);

  expect(exitCode).toBe(2);
  expect(stderrBuf).toContain(
    "no usable shard pointer; checked latest-passing.json, latest-run.json, latest-baseline.json"
  );
}

async function writeDuplicateDiagnosticsShard(
  shard: string,
  evidenceSuffix: string
): Promise<void> {
  await writeShardRoot(
    shard,
    makeShardKpi({
      evaluated_count: 1,
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [
          { id: "q-diagnostics-a", version: 1, hit_at_5: true, tier: "warm" }
        ]
      }
    }),
    makeShardDiagnostics({
      questions: [
        {
          question_id: "q-diagnostics-a",
          gold_memory_ids: [`gold-${evidenceSuffix}`],
          delivered_memory_ids: [`delivered-${evidenceSuffix}`],
          delivered_gold_ids: [`gold-${evidenceSuffix}`],
          miss_reasons: [],
          provider_state: "provider_not_requested"
        }
      ]
    })
  );
}

async function verifyDuplicateQuestionIdsRejected(): Promise<void> {
  const shardA = path.join(tmpRoot, "shard-diagnostics-a");
  const shardB = path.join(tmpRoot, "shard-diagnostics-b");
  await writeDuplicateDiagnosticsShard(shardA, "a");
  await writeDuplicateDiagnosticsShard(shardB, "b");

  const exitCode = await runCli([
    "merge-longmemeval",
    "--variant",
    "s",
    "--history-root",
    path.join(tmpRoot, "history-duplicate-diagnostics"),
    "--shards",
    shardA,
    shardB
  ]);

  expect(exitCode).toBe(2);
  expect(stderrBuf).toContain(
    "merge refused: duplicate question_id 'q-diagnostics-a' across shards"
  );
}

async function writeCustomPinnedHistory(historyRoot: string): Promise<void> {
  const priorPassingRunAt = "2026-05-13T12:00:00.000Z";
  await writeHistoryEntry(
    historyRoot,
    "2026-05-13T120000Z-aaa1111-policy-stress",
    withEligibleMeasurementContract(makeShardKpi({
      run_at: priorPassingRunAt,
      alaya_commit: "aaa1111",
      kpi: {
        ...makeShardKpi().kpi,
        r_at_5: 0.8
      }
    }))
  );
  await writeHistoryEntry(
    historyRoot,
    "2026-05-13T130000Z-bbb2222-policy-stress",
    makeShardKpi({
      run_at: "2026-05-13T13:00:00.000Z",
      alaya_commit: "bbb2222",
      kpi: {
        ...makeShardKpi().kpi,
        r_at_5: 0.1
      }
    }),
    "# findings\n- regression\n"
  );
}

async function verifyCustomPinnedDatasetSource(): Promise<void> {
  const shardA = path.join(tmpRoot, "shard-a");
  const shardB = path.join(tmpRoot, "shard-b");
  const dataset = await createMergeDatasetSource(tmpRoot);
  await setupShard(shardA, "q-a", 0);
  await setupShard(shardB, "q-b", 1);
  const historyRoot = path.join(tmpRoot, "history-baseline");
  await writeCustomPinnedHistory(historyRoot);

  const exitCode = await runCli([
    "merge-longmemeval",
    "--variant",
    "s",
    "--history-root",
    historyRoot,
    "--concurrency",
    "2",
    ...dataset.cliArgs,
    "--shards",
    shardA,
    shardB
  ]);

  const pointer = JSON.parse(
    await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
  ) as { slug: string };
  const merged = JSON.parse(
    await readFile(
      path.join(historyRoot, "public", pointer.slug, "kpi.json"),
      "utf8"
    )
  ) as KpiPayload;
  expect(collectReleaseHardGates(merged)).toEqual([]);
  expect(merged.measurement_attribution?.gate_eligible).toBe(true);
  expect(merged.selection_contract).toBeDefined();
  expect(merged.diff_vs_previous).toBeNull();
  expect(exitCode, stderrBuf).toBe(1);
}

function baseEvidence(): Record<string, unknown> {
  return makeShardDiagnostics().scored_recall_evidence as Record<string, unknown>;
}

async function writeTaxonomyShard(
  shard: string,
  questionId: string,
  hitAt5: boolean,
  missTaxonomyDistribution: Record<string, number>
): Promise<void> {
  await writeShardRoot(
    shard,
    makeShardKpi({
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [
          { id: questionId, version: 1, hit_at_5: hitAt5, tier: "warm" }
        ]
      }
    }),
    makeShardDiagnostics({
      scored_recall_evidence: {
        ...baseEvidence(),
        miss_taxonomy_distribution: missTaxonomyDistribution
      }
    })
  );
}

async function writeLegacyTaxonomyShard(shardLegacy: string): Promise<void> {
  const {
    miss_taxonomy_distribution: _legacyTaxonomy,
    ...legacyEvidence
  } = baseEvidence();
  await writeShardRoot(
    shardLegacy,
    makeShardKpi({
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [
          { id: "q-taxonomy-legacy", version: 1, hit_at_5: true, tier: "warm" }
        ]
      }
    }),
    makeShardDiagnostics({ scored_recall_evidence: legacyEvidence })
  );
}

async function prepareTaxonomyShards(): Promise<ReadonlyArray<string>> {
  const shardA = path.join(tmpRoot, "shard-taxonomy-a");
  const shardB = path.join(tmpRoot, "shard-taxonomy-b");
  const shardLegacy = path.join(tmpRoot, "shard-taxonomy-legacy");
  await writeTaxonomyShard(shardA, "q-taxonomy-a", true, {
    candidate_absent: 1,
    materialization_drop: 2,
    fine_assessment_drop: 6,
    budget_drop: 0,
    delivery_order_drop: 0,
    answer_set_coverage_drop: 0,
    evaluation_or_gold_issue: 0
  });
  await writeTaxonomyShard(shardB, "q-taxonomy-b", false, {
    candidate_absent: 0,
    materialization_drop: 0,
    fine_assessment_drop: 7,
    budget_drop: 3,
    delivery_order_drop: 4,
    answer_set_coverage_drop: 0,
    evaluation_or_gold_issue: 5
  });
  await writeLegacyTaxonomyShard(shardLegacy);
  return [shardA, shardB, shardLegacy];
}

type MergedTaxonomyDiagnostics = {
  scored_recall_evidence?: {
    miss_taxonomy_distribution?: Record<string, number>;
  };
  questions?: Array<{
    question_id: string;
    cohort_ledger?: { measurement_evidence_mode?: string };
  }>;
};

async function readMergedTaxonomyDiagnostics(
  historyRoot: string
): Promise<MergedTaxonomyDiagnostics> {
  const pointer = JSON.parse(
    await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
  ) as { slug: string };
  return JSON.parse(
    await readFile(
      path.join(historyRoot, "public", pointer.slug, LONGMEMEVAL_DIAGNOSTICS_FILENAME),
      "utf8"
    )
  ) as MergedTaxonomyDiagnostics;
}

async function verifyTaxonomyDistributionMerged(): Promise<void> {
  const [shardA, shardB, shardLegacy] = await prepareTaxonomyShards();
  const historyRoot = path.join(tmpRoot, "history-taxonomy");
  const exitCode = await runCli([
    "merge-longmemeval",
    "--variant",
    "s",
    "--history-root",
    historyRoot,
    "--shards",
    shardA!,
    shardB!,
    shardLegacy!
  ]);

  expect(exitCode).toBe(1);
  const diagnostics = await readMergedTaxonomyDiagnostics(historyRoot);
  expect(diagnostics.scored_recall_evidence?.miss_taxonomy_distribution).toEqual({
    candidate_absent: 1,
    materialization_drop: 2,
    fine_assessment_drop: 13,
    budget_drop: 3,
    delivery_order_drop: 4,
    answer_set_coverage_drop: 0,
    evaluation_or_gold_issue: 5
  });
  expect(diagnostics.questions?.find(
    (question) => question.question_id === "q-taxonomy-legacy"
  )?.cohort_ledger?.measurement_evidence_mode).toBe("legacy_synthesized");
}

describe("merge-longmemeval validations", () => {
  it("fails closed when compact question_count is malformed", async () =>
    verifyMalformedQuestionCountRejected());
});

describe("merge-longmemeval validations", () => {
  it("reports a clear error when a shard root has no usable pointer", async () =>
    verifyMissingPointerRejected());
});

describe("merge-longmemeval validations", () => {
  it("fails closed when merged full diagnostics duplicate question ids", async () =>
    verifyDuplicateQuestionIdsRejected());
});

describe("merge-longmemeval validations", () => {
  it("omits passing-history diffs for a custom pinned dataset source", async () =>
    verifyCustomPinnedDatasetSource());
});

describe("merge-longmemeval validations", () => {
  it("merges diagnostics miss taxonomy distribution while accepting legacy sidecars", async () =>
    verifyTaxonomyDistributionMerged());
});
