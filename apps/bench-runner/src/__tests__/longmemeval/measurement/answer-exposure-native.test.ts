import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { prepareLongMemEvalSemanticRun, replayLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/execute.js";
import { measureLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/measure.js";
import { readChainArtifact, writeChainArtifact } from "../../../runs/recall-measurement/contract.js";

const roots: string[] = [];
afterAll(async () => {
  await settleActiveBenchDaemonTasks();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  isolation.restore();
  expect(isolation.violations).toEqual([]);
});

it("scores exact public source exposure after SQLite reopen and immutable native replay, without Q/H/C or a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "answer-exposure-native-")); roots.push(root);
  const dataDir = join(root, "data"), meta = join(root, "meta"), run = join(root, "run"), evaluator = join(root, "evaluator");
  await mkdir(dataDir); await mkdir(meta);
  const questions = [
    { id: "mapped", content: "東京有答案 café 🐈" },
    { id: "partial", content: `A long answer-bearing turn: ${"東京 café 🐈 ".repeat(800)}` },
    { id: "uncalibrated_abs", content: "An unrelated original source." },
    { id: "not-selected", content: "Not part of the frozen development group." }
  ].map(({ id, content }) => ({ question_id: id, question_type: "fixture", question: "What was recorded?",
    answer: "evaluator label must never enter a producer", question_date: "2023/09/13 (Wed) 00:00",
    haystack_session_ids: [`${id}-session`], haystack_dates: ["2023/09/12 (Tue) 00:00"],
    answer_session_ids: [`${id}-session`], haystack_sessions: [[{ role: "user", content, has_answer: true }]] }));
  const source = JSON.stringify(questions), digest = createHash("sha256").update(source).digest("hex");
  await writeFile(join(dataDir, "longmemeval_s.json"), source);
  await writeFile(join(meta, "longmemeval_s.meta.json"), JSON.stringify({ sha256: digest,
    size_bytes: Buffer.byteLength(source), question_count: questions.length }));
  const frozen = await freezeLongMemEvalSemanticRun({ data_dir: dataDir, pinned_meta_root: meta,
    dataset_sha256: digest, dataset_question_count: questions.length, question_ids: questions.slice(0, 3).map(row => row.question_id),
    model: "gemini-2.5-flash-lite", provider_url: "http://127.0.0.1:9", request_profile: "gemini-2.5-nonthinking-v1",
    query_cache_root: join(root, "absent-query-cache"), recorded_at: "2026-09-13T00:00:00.000Z", producer_commit: "a".repeat(40),
    max_output_tokens: 4096, output_byte_limit: 1000000,
    budget: { schema_version: 1, work_units: 1000000, memory_bytes: 60000000, page_budget: 100000,
      finalization_reserve: 10000, min_envelope: 10 } }, run);
  expect(JSON.stringify(frozen)).not.toContain("has_answer");
  expect(JSON.stringify(frozen)).not.toContain("evaluator label");
  const prepared = await prepareLongMemEvalSemanticRun(run);
  expect(prepared.result.rows.every(row => row.status === "prepared")).toBe(true);
  const replay = await replayLongMemEvalSemanticRun(run, prepared.path);
  expect(replay.result.rows.every(row => row.status === "replayed")).toBe(true);
  const producerPaths = [join(run, "freeze.json"), prepared.path, replay.path,
    ...replay.result.rows.flatMap(row => row.status !== "replayed" ? [] : [row.publication_path, row.replay_path])];
  const originalBytes = producerPaths.map(path => readFileSync(path));
  const measured = await measureLongMemEvalSemanticRun(run, replay.path, evaluator);
  expect(measured.result.route_scope).toMatchObject({ arm: "source_only_canonical", access_policy: "canonical-v1",
    embedding_configuration: { mode: "disabled" }, normal_production_capability_baseline: false });
  expect(measured.result.rows[0]?.acquisition?.metrics["answer_span_exposure@5"].status).toBe("hit");
  expect(measured.result.rows[1]?.acquisition?.metrics["source_bearing_any@5"].status).toBe("hit");
  expect(measured.result.rows[1]?.acquisition?.metrics["answer_span_exposure@5"].status).toBe("miss");
  expect(measured.result.rows[2]).toMatchObject({ outcome: "uncalibrated", acquisition: {
    metrics: { "answer_span_exposure@5": { status: "unknown", reason: "abstention_requires_separate_calibration" } } } });
  expect(measured.result.rows[3]).toMatchObject({ selected: false, acquisition: null });
  expect(measured.result.acquisition.metrics["answer_span_exposure@5"]).toMatchObject({ denominator: 3, hits: 1, misses: 1, unknown: 1 });
  expect(measured.result.acquisition.metrics["source_bearing_any@5"]).toMatchObject({ denominator: 3, hits: 2, misses: 0, unknown: 1 });
  expect(measured.result.acquisition.support_sufficiency).toEqual({ measured: 0, not_measured: 3 });
  expect(measured.result.acquisition.observed_costs.evaluator_proof_work).toMatchObject({ known: 3, unknown: 0, known_sum: 0 });
  expect(measured.result.rows[1]?.acquisition?.earliest_observable_loss).toMatchObject({ status: "unknown", stage: null,
    earliest_unknown_stage: "deliverable_window", observed_failed_stage: "delivery" });
  for (const [index, path] of producerPaths.entries()) expect(readFileSync(path)).toEqual(originalBytes[index]);
  expect(await measureLongMemEvalSemanticRun(run, replay.path, evaluator)).toEqual(measured);

  const refusedReplay = join(root, "refused-replay.json");
  writeChainArtifact(refusedReplay, { ...replay.result, rows: replay.result.rows.map((row, index) => index === 0
    ? { question_id: row.question_id, status: "unavailable", reason: "refusal" } : row) });
  const refused = await measureLongMemEvalSemanticRun(run, refusedReplay, join(root, "refusal-evaluator"));
  expect(refused.result.acquisition.metrics["answer_span_exposure@5"]).toMatchObject({ denominator: 3, hits: 0, misses: 1, unknown: 2 });
  expect(refused.result.rows[0]?.acquisition?.metrics["answer_span_exposure@5"]).toEqual({ status: "unknown", reason: "refusal" });

  // A counterfeit preview cannot become exposure by preserving root IDs, span length and first-exposure hashes.
  const first = replay.result.rows[0]!;
  if (first.status !== "replayed") throw new Error("native replay required");
  const aggregate = readChainArtifact(first.replay_path) as { rows: { response: { results: { content_preview: string }[] } }[] };
  aggregate.rows[0]!.response.results[0]!.content_preview = "Counterfeit source preview";
  writeFileSync(first.replay_path, JSON.stringify(aggregate));
  const invalid = await measureLongMemEvalSemanticRun(run, replay.path, join(root, "invalid-evaluator"));
  expect(invalid.result.rows[0]?.acquisition?.metrics["answer_span_exposure@5"].status).toBe("unknown");
  expect(invalid.result.acquisition.metrics["answer_span_exposure@5"]).toMatchObject({ denominator: 3, hits: 0, misses: 1, unknown: 2 });
}, 120_000);
