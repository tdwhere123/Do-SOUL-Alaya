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
    expect(metrics).not.toHaveProperty("budget_drop_distribution");
    expect(metrics).not.toHaveProperty("high_lexical_demoted_rate");
    expect(metrics).not.toHaveProperty("per_plane_recall_coverage");
    expect(metrics.metadata.unavailable_metrics).toMatchObject({
      budget_drop_distribution: "gold diagnostics absent on some questions"
    });
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

it.each([
  { name: "measured zero", optional: { budget_drop: { max_entries: 0 } }, count: 0 },
  { name: "measured positive", optional: { budget_drop: { max_entries: 2 } }, count: 2 },
  { name: "absent budget", optional: {}, count: undefined },
  { name: "absent max_entries", optional: { budget_drop: {} }, count: undefined }
])("controlled replay availability preserves independent measurements: $name", ({ optional, count }) => {
  const result = runQualityScript({ scenarios: [], metrics: { diagnostics_count: 4, delivery_count: 7,
    non_monotonic: { count: 1 }, high_lexical_demoted: { count: 2 }, ...optional } });
  expect(result.status, result.stderr).toBe(0);
  const metrics = JSON.parse(result.stdout);
  expect(metrics).toMatchObject({ non_monotonic_rate: 0.25, high_lexical_demoted_rate: 0.5 });
  expect(metrics.metadata.controlled_replay).toMatchObject({ delivery_count: 7, diagnostics_count: 4,
    non_monotonic_count: 1, non_monotonic_denominator: 4,
    high_lexical_demoted_count: 2, high_lexical_demoted_denominator: 4 });
  for (const key of ["cohort_first_admitted", "cohort_winning_admission", "path_expansion_share", "per_plane_recall_coverage", "active_constraints_count"]) {
    expect(metrics).not.toHaveProperty(key);
    expect(metrics.metadata.unavailable_metrics[key]).toEqual(expect.any(String));
    expect(metrics.warnings).toContainEqual(expect.stringContaining(`${key} unavailable`));
  }
  if (count === undefined) {
    expect(metrics).not.toHaveProperty("budget_drop_distribution");
    expect(metrics.metadata.controlled_replay).not.toHaveProperty("budget_drop_denominator");
    expect(metrics.metadata.unavailable_metrics.budget_drop_distribution).toEqual(expect.any(String));
  } else {
    expect(metrics.budget_drop_distribution).toEqual({ max_entries: { count, share: count / 4, denominator: 4 } });
    expect(metrics.metadata.controlled_replay.budget_drop_denominator).toBe(4);
    expect(metrics.metadata.unavailable_metrics).not.toHaveProperty("budget_drop_distribution");
  }
});

it.each([{ max_entries: "0" }, { max_entries: -1 }, { max_entries: 0.5 },
  { max_entries: null }, { max_entries: Number.MAX_SAFE_INTEGER + 1 }, null, []
])("controlled replay availability rejects malformed optional budget counts: %j", budget_drop => {
  const result = runQualityScript({ scenarios: [], metrics: { diagnostics_count: 4, delivery_count: 7,
    non_monotonic: { count: 1 }, high_lexical_demoted: { count: 2 }, budget_drop } });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("budget_drop");
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

it.each([
  { questions: [{}] },
  { questions: [{ gold: [] }] },
  { questions: [{ gold_memory_ids: [] }] },
  { questions: [{ delivered_results: [] }] },
  { questions: [{ delivered_results: [], gold: null }] },
  { questions: [{ delivered_results: [], gold: [{}] }] },
  { questions: [{ delivered_results: [{}], gold: [] }] },
  { questions: [{ delivered_results: [], gold_memory_ids: "missing" }] },
  { schema_version: 99, questions: [{ delivered_results: [], gold: [] }] }
])("refuses evidence-free, missing required or malformed per-question measurements: %j", archive => {
  const result = runQualityScript(archive);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/diagnostics/u);
});

it.each([
  { questions: [] },
  { schema_version: 1, questions: [{ delivered_results: [], gold: [] }] },
  { questions: [{ delivered_results: [], gold: [], gold_memory_ids: [] }] }
])("accepts explicitly measured empty populations: %j", archive => {
  const result = runQualityScript(archive);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ non_monotonic_rate: 0,
    budget_drop_distribution: {}, per_plane_recall_coverage: {} });
});

it("preserves legacy partial identity measurements without silently filling absent facets", () => {
  const result = runQualityScript({ questions: [{ delivered_results: [], gold_memory_ids: [] }] });
  expect(result.status, result.stderr).toBe(0);
  const metrics = JSON.parse(result.stdout);
  expect(metrics.non_monotonic_rate).toBe(0);
  expect(metrics).not.toHaveProperty("budget_drop_distribution");
  expect(metrics.metadata.longmemeval).not.toHaveProperty("gold_count");
});

it("keeps historical gold diagnostics readable without inventing identity-hit accounting", () => {
  const result = runQualityScript({ questions: [{ delivered_results: [], gold: [{ object_id: "gold" }] }] });
  expect(result.status, result.stderr).toBe(0);
  const metrics = JSON.parse(result.stdout);
  expect(metrics.metadata.longmemeval.gold_count).toBe(1);
  expect(metrics).toMatchObject({ non_monotonic_rate: 0 });
  for (const field of ["high_lexical_demoted_rate", "budget_drop_distribution", "per_plane_recall_coverage", "active_constraints_count"]) {
    expect(metrics).not.toHaveProperty(field);
  }
  expect(metrics.metadata.longmemeval).not.toHaveProperty("gold_hit_count");
  expect(metrics.cohort_first_admitted).toEqual({});
});

it("does not shrink the population or fill an absent sibling measurement", () => {
  const result = runQualityScript({ questions: [
    { delivered_results: [], gold: [] },
    { delivered_results: [{ object_id: "a" }, { object_id: "b" }], gold_memory_ids: ["a"] }
  ] });
  expect(result.status, result.stderr).toBe(0);
  const metrics = JSON.parse(result.stdout);
  expect(metrics.metadata.longmemeval.non_monotonic_denominator).toBe(2);
  expect(metrics).not.toHaveProperty("non_monotonic_rate");
  expect(metrics).not.toHaveProperty("budget_drop_distribution");
});

function measuredQuestion() {
  return {
    gold_object_ids: ["g", "h"], active_constraints: [], active_constraints_completeness: "complete",
    delivered_results: [
      { object_id: "g", relevance_score: 0.2, plane_winning_admission: null },
      { object_id: "x", relevance_score: 0.8, plane_first_admitted: "workspace_local", plane_winning_admission: "workspace_local" }
    ],
    gold: [
      { object_id: "g", budget_drop_reason: null, source_planes: ["lexical"], final_rank: 2, lexical_rank: 0.9,
        plane_first_admitted: "path_expansion", plane_winning_admission: "path_expansion" },
      { object_id: "h", budget_drop_reason: "max_entries", source_planes: ["lexical"], final_rank: 6, lexical_rank: 0.9 }
    ]
  };
}

it.each([
  { name: "full measured inputs", remove: [], absent: [], counters: [] },
  { name: "identity-only gold", remove: ["budget_drop_reason", "source_planes", "final_rank", "lexical_rank"],
    absent: ["budget_drop_distribution", "per_plane_recall_coverage", "high_lexical_demoted_rate"],
    counters: ["budget_drop_denominator", "budget_drop_field_count", "high_lexical_demoted_count", "high_lexical_demoted_denominator"] },
  { name: "mixed budget declarations", remove: ["budget_drop_reason"], absent: ["budget_drop_distribution"],
    counters: ["budget_drop_denominator", "budget_drop_field_count"] },
  { name: "mixed plane declarations", remove: ["source_planes"], absent: ["per_plane_recall_coverage"], counters: [] },
  { name: "mixed final ranks", remove: ["final_rank"], absent: ["per_plane_recall_coverage", "high_lexical_demoted_rate"],
    counters: ["high_lexical_demoted_count", "high_lexical_demoted_denominator"] },
  { name: "mixed lexical ranks", remove: ["lexical_rank"], absent: ["high_lexical_demoted_rate"],
    counters: ["high_lexical_demoted_count", "high_lexical_demoted_denominator"] }
])("projects each gold facet only from its declared population: $name", fixture => {
  const questions = [measuredQuestion(), measuredQuestion()];
  for (const key of fixture.remove) Reflect.deleteProperty(questions[1]!.gold[1]!, key);
  const result = runQualityScript({ questions });
  expect(result.status, result.stderr).toBe(0);
  const metrics = JSON.parse(result.stdout);
  for (const field of fixture.absent) expect(metrics).not.toHaveProperty(field);
  for (const field of fixture.counters) expect(metrics.metadata.longmemeval).not.toHaveProperty(field);
  const expected = { budget_drop_distribution: { max_entries: { count: 2, share: 0.5, denominator: 4 } },
    high_lexical_demoted_rate: 0.5,
    per_plane_recall_coverage: { lexical: { gold_count: 4, hit_at_5_count: 2, hit_at_5_rate: 0.5 } } };
  for (const [field, value] of Object.entries(expected)) if (!fixture.absent.includes(field)) expect(metrics[field]).toEqual(value);
  expect(metrics).toMatchObject({ non_monotonic_rate: 1, active_constraints_count: 0, path_expansion_share: 0.5 });
  expect(metrics.metadata.longmemeval).toMatchObject({ questions_count: 2, non_monotonic_denominator: 2,
    non_monotonic_count: 2, gold_hit_count: 2, gold_count: 4 });
  expect(metrics.cohort_first_admitted.path_expansion).toMatchObject({ delivered_count: 2, delivered_denominator: 4 });
  // Explicit delivered null wins over the gold fallback's path_expansion.
  expect(metrics.cohort_winning_admission.null.gold_hit_count).toBe(2);
});

it("treats declared null ranks/drop reason and empty planes as measured, not missing", () => {
  const result = runQualityScript({ questions: [{ delivered_results: [], gold_object_ids: ["g"],
    gold: [{ object_id: "g", budget_drop_reason: null, source_planes: [], final_rank: null, lexical_rank: null }],
    active_constraints_count: 0 }] });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ non_monotonic_rate: 0, high_lexical_demoted_rate: 0,
    budget_drop_distribution: {}, per_plane_recall_coverage: {}, active_constraints_count: 0,
    metadata: { longmemeval: { high_lexical_demoted_denominator: 0, high_lexical_demoted_count: 0,
      budget_drop_field_count: 1, budget_drop_denominator: 1 } } });
  const emptyPlanes = runQualityScript({ questions: [{ delivered_results: [], gold: [{ object_id: "g", source_planes: [] }] }] });
  expect(JSON.parse(emptyPlanes.stdout).per_plane_recall_coverage).toEqual({});
});

it.each(["plane_first_admitted", "plane_winning_admission", "gold_object_ids", "active_constraints",
  "active_constraints_count", "active_constraints_completeness"])("keeps independent facets when %s is unavailable", field => {
  const questions = [measuredQuestion(), measuredQuestion()];
  const partial = questions[1]!;
  if (field === "active_constraints_count") Object.assign(partial, { active_constraints_count: null });
  else if (field === "active_constraints_completeness") partial.active_constraints_completeness = "incomplete";
  else if (field.startsWith("plane_")) {
    Reflect.deleteProperty(partial.delivered_results[0]!, field);
    Reflect.deleteProperty(partial.gold[0]!, field);
  } else Reflect.deleteProperty(partial, field);
  const result = runQualityScript({ questions });
  expect(result.status, result.stderr).toBe(0);
  const metrics = JSON.parse(result.stdout);
  expect(metrics).toMatchObject({ non_monotonic_rate: 1, high_lexical_demoted_rate: 0.5 });
  if (field.startsWith("active_")) expect(metrics).not.toHaveProperty("active_constraints_count");
  if (field === "plane_first_admitted") {
    expect(metrics).not.toHaveProperty("cohort_first_admitted");
    expect(metrics).not.toHaveProperty("path_expansion_share");
    expect(metrics.metadata.longmemeval).not.toHaveProperty("plane_first_admitted_field_count");
    expect(metrics.cohort_winning_admission.null.gold_hit_count).toBe(2);
  }
  if (field === "plane_winning_admission") {
    expect(metrics).not.toHaveProperty("cohort_winning_admission");
    expect(metrics.metadata.longmemeval).not.toHaveProperty("plane_winning_admission_field_count");
    expect(metrics.path_expansion_share).toBe(0.5);
  }
  if (field === "gold_object_ids") {
    expect(metrics.metadata.longmemeval).not.toHaveProperty("gold_hit_count");
    expect(metrics.cohort_first_admitted.path_expansion).toEqual({ delivered_count: 2, delivered_share: 0.5, delivered_denominator: 4 });
    expect(metrics.path_expansion_share).toBe(0.5);
  }
});

it.each([
  ["gold", "budget_drop_reason", 3], ["gold", "budget_drop_reason", ""],
  ["gold", "lexical_rank", "0.9"], ["gold", "final_rank", "6"],
  ["gold", "source_planes", null], ["gold", "source_planes", [3]],
  ["gold", "plane_first_admitted", {}], ["delivery", "plane_winning_admission", []],
  ["delivery", "relevance_score", null], ["delivery", "relevance_score", "0.9"],
  ["question", "active_constraints", [null]], ["question", "active_constraints", null],
  ["question", "active_constraints_count", -1], ["question", "active_constraints_count", "0"],
  ["question", "active_constraints_completeness", "unknown"]
])("rejects malformed supplied %s.%s instead of coercing it to absence", (scope, field, value) => {
  const question = measuredQuestion();
  const target = scope === "gold" ? question.gold[0]! : scope === "delivery" ? question.delivered_results[0]! : question;
  Reflect.set(target, String(field), value);
  const result = runQualityScript({ questions: [question] });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(String(field));
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
