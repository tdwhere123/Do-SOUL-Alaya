import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { makeQualityMetrics } from "./merge/cli-merge-validations-fixture.js";

it.each([
  { gold_memory_ids: ["memory"], gold_evidence_ids: ["capsule"], gold_object_ids: ["memory", "capsule"] },
  { gold_memory_ids: ["memory"], gold_evidence_ids: ["capsule"] },
  { gold_memory_ids: ["capsule"] }
])("counts capsule and legacy memory gold identities in both archive scripts: %j", identities => {
  const root = mkdtempSync(path.join(tmpdir(), "alaya-gold-cohort-"));
  try {
    const archive = path.join(root, "archive.json");
    writeFileSync(archive, JSON.stringify({ questions: [{
      ...identities,
      delivered_results: [{ object_id: "capsule", plane_first_admitted: "workspace_local",
        plane_winning_admission: "workspace_local" }]
    }] }));
    const scripts = path.resolve(import.meta.dirname, "../../../../../scripts");
    const cohort = spawnSync(process.execPath, [path.join(scripts, "compute-cohort-from-archive.mjs"), archive], { encoding: "utf8" });
    expect(cohort.status, cohort.stderr).toBe(0);
    expect(cohort.stdout).toContain("Total gold hits: 1");
    const quality = spawnSync(process.execPath, [path.join(scripts, "compute-bench-quality-metrics.mjs"), archive], { encoding: "utf8" });
    expect(quality.status, quality.stderr).toBe(0);
    const metrics = JSON.parse(quality.stdout);
    expect(metrics.cohort_first_admitted.workspace_local).toMatchObject({ gold_hit_count: 1, gold_hit_denominator: 1 });
    expect(metrics.cohort_winning_admission.workspace_local).toMatchObject({ gold_hit_count: 1, gold_hit_denominator: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("preserves unavailable quality status and historic absence instead of projecting zeros", () => {
  const quality = { schema_version: "bench-quality-metrics.unavailable.v1",
    unavailable_reason: "not_recomputed_from_shard_archives", evaluator_identity_unscorable_count: 2 };
  const result = runQualityScript({ kpi: { quality_metrics: quality } });
  expect(result.status, result.stderr).toBe(0);
  const metrics = JSON.parse(result.stdout);
  expect(metrics).toMatchObject(quality);
  for (const key of ["non_monotonic_rate", "high_lexical_demoted_rate", "active_constraints_count",
    "per_plane_recall_coverage", "budget_drop_distribution", "path_expansion_share"]) expect(metrics).not.toHaveProperty(key);
});

it("keeps measured zero and empty collections distinct from unavailable", () => {
  const quality = makeQualityMetrics({ denominator: 0 });
  Reflect.deleteProperty(quality, "evidence_stream_gold_delivery_rate");
  const result = runQualityScript({ kpi: { quality_metrics: quality } });
  expect(result.status, result.stderr).toBe(0);
  const metrics = JSON.parse(result.stdout);
  expect(metrics.schema_version).toBe("bench-quality-metrics.v1");
  expect(metrics.non_monotonic_rate).toBe(0);
  expect(metrics.non_monotonic_denominator).toBe(0);
  expect(metrics.budget_drop_distribution).toEqual(quality.budget_drop_distribution);
  expect(metrics).not.toHaveProperty("unavailable_reason");
  expect(metrics).not.toHaveProperty("evidence_stream_gold_delivery_rate");
  const empty = runQualityScript({ questions: [] });
  expect(empty.status, empty.stderr).toBe(0);
  expect(JSON.parse(empty.stdout).metadata.longmemeval.questions_count).toBe(0);
});

it("accepts an explicitly measured zero controlled replay", () => {
  const result = runQualityScript({ scenarios: [], metrics: { diagnostics_count: 0, delivery_count: 0,
    non_monotonic: { count: 0 }, high_lexical_demoted: { count: 0 }, budget_drop: { max_entries: 0 } } });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: 0, high_lexical_demoted_rate: 0 });
});

it.each([{}, { arbitrary: true }, { questions: "corrupt" }, { questions: [null] },
  { questions: [{ delivered_results: "corrupt" }] }, { scenarios: [], metrics: {} },
  { kpi: { quality_metrics: { schema_version: "future" } } },
  { kpi: { quality_metrics: { schema_version: "bench-quality-metrics.unavailable.v1",
    unavailable_reason: "not_recomputed_from_shard_archives", non_monotonic_rate: 0 } } }
])("rejects unknown or damaged contracts without a numeric result: %j", value => {
  const result = runQualityScript(value);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
});

function runQualityScript(value: unknown) {
  const root = mkdtempSync(path.join(tmpdir(), "quality-status-"));
  try {
    // A preferred filename must not turn a damaged input into a known shape.
    const archive = path.join(root, "longmemeval-diagnostics.json");
    writeFileSync(archive, JSON.stringify(value));
    return spawnSync(process.execPath, [path.resolve(import.meta.dirname,
      "../../../../../scripts/compute-bench-quality-metrics.mjs"), archive], { encoding: "utf8" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it.each(["missing", "malformed"])("does not emit measured-zero metrics for a %s archive", kind => {
  const root = mkdtempSync(path.join(tmpdir(), "alaya-quality-"));
  try {
    const archive = path.join(root, "archive.json");
    if (kind === "malformed") writeFileSync(archive, "{invalid");
    const script = path.resolve(import.meta.dirname, "../../../../../scripts/compute-bench-quality-metrics.mjs");
    const result = spawnSync(process.execPath, [script, archive], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed to read archive:");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
