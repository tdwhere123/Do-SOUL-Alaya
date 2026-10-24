import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { createHash } from "node:crypto";
import { SoulMemorySearchRequestSchema } from "@do-soul/alaya-protocol";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { prepareLongMemEvalSemanticRun, replayLongMemEvalSemanticRun, QuestionPublicationSchema } from "../../../runs/longmemeval-semantic/execute.js";
import { measureLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/measure.js";
import { readChainArtifact, writeChainArtifact } from "../../../runs/recall-measurement/contract.js";

import { startBenchDaemon } from "../../../harness/daemon.js";
import { restoreSnapshotToDataDir } from "../../../runs/snapshot/materialize.js";
import { censusCompleteSourceRecords, type LongMemEvalSourceCensusRecord } from "../../../runs/snapshot/source-records/census.js";
import { prepareSourceRecordLexicalIndex, recallSourcePages } from "../../harness/recall/source-records-worker-fixture.js";
import { expectArchivedFieldRefusal } from "../ingestion/source-records-publication.test-support.js";

const BUDGET = { schema_version: 1 as const, work_units: 1000000, memory_bytes: 60000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 };
const roots: string[] = [];
afterAll(async () => {
  await settleActiveBenchDaemonTasks();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  isolation.restore();
  expect(isolation.violations).toEqual([]);
});

async function verifyNativeExposure(publicationPath: string, dataDir: string, original: LongMemEvalSourceCensusRecord, complete: boolean) {
  const publication = QuestionPublicationSchema.parse(readChainArtifact(publicationPath));
  await restoreSnapshotToDataDir({ snapshotDbPath: publication.snapshot_path, dataDirRoot: dataDir, expectedSha256: publication.db_sha256 });
  prepareSourceRecordLexicalIndex(dataDir, publication.workspace_id);
  const daemon = await startBenchDaemon({ dataDirRoot: dataDir, workspaceId: publication.workspace_id, runId: publication.run_id,
    embeddingMode: "disabled" });
  try {
    const { results } = await recallSourcePages(daemon, SoulMemorySearchRequestSchema.parse({ query: "café",
      max_results: 20, result_kind_view: "source_only", enumeration_policy: "native_query",
      scope_class: null, dimension: null, domain_tags: null, source_observed_at: "2023-09-13T00:00:00.000Z",
      protocol_version: 1, supports_source_evidence: true, supported_result_kinds: ["source_evidence"],
      supports_product_updates: true }));
    expect(results).toHaveLength(1);
    const target = results[0]!.target;
    if (target?.kind !== "source_evidence" || target.span === undefined) throw new Error("native source extent required");
    expect(target).toMatchObject({ root_id: publication.sources[0]!.record_id, root_kind: "source_record",
      workspace_id: publication.workspace_id, source_version: original.source_version, content_digest: original.content_digest,
      span: { content_start: 0, content_complete: complete } });
    const body = Buffer.from(original.content_bytes, "utf8");
    const end = target.span.content_end;
    expect(end).toBeGreaterThan(0);
    expect(results[0]!.content_preview).toBe(body.subarray(0, end).toString("utf8"));
    expect(Buffer.byteLength(results[0]!.content_preview!)).toBe(end);
    if (complete) expect(end).toBe(body.length);
    else expect(end).toBeLessThan(body.length);
  } finally { await daemon.shutdown(); }
}

it("retains exact native source bytes after SQLite reopen while archived scoring explicitly refuses field pages", async () => {
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
    budget: BUDGET }, run);
  expect(JSON.stringify(frozen)).not.toContain("has_answer");
  expect(JSON.stringify(frozen)).not.toContain("evaluator label");
  const prepared = await prepareLongMemEvalSemanticRun(run);
  expect(prepared.result.rows.every(row => row.status === "prepared")).toBe(true);
  const replay = await replayLongMemEvalSemanticRun(run, prepared.path);
  expect(replay.result.rows.every(row => row.status === "replayed")).toBe(true);
  const producerPaths = [join(run, "freeze.json"), prepared.path, replay.path,
    ...replay.result.rows.flatMap(row => row.status !== "replayed" ? [] : [row.publication_path, row.replay_path])];
  const originalBytes = producerPaths.map(path => readFileSync(path));
  const census = await censusCompleteSourceRecords({ population: "answer-exposure", dataDir, pinnedMetaRoot: meta });
  expect(census.dataset_sha256).toBe(digest);
  expect(census.records.map(record => record.question_id)).toEqual(questions.map(question => question.question_id));
  for (const [index, row] of replay.result.rows.slice(0, 2).entries()) {
    if (row.status !== "replayed") throw new Error("native replay required");
    await verifyNativeExposure(row.publication_path, join(root, `native-${row.question_id}`),
      census.records.find(record => record.question_id === row.question_id)!, index === 0);
  }
  const measured = await measureLongMemEvalSemanticRun(run, replay.path, evaluator);
  expect(measured.result.route_scope).toMatchObject({ arm: "source_only_canonical", access_policy: "canonical-v1",
    embedding_configuration: { mode: "disabled" }, normal_production_capability_baseline: false });
  for (const row of measured.result.rows.slice(0, 3)) {
    expectArchivedFieldRefusal(row, replay.result);
    expect(row.acquisition?.metrics["answer_span_exposure@5"]).toEqual({ status: "unknown", reason: "invalid_response" });
    expect(row.acquisition?.metrics["source_bearing_any@5"]).toEqual({ status: "unknown", reason: "invalid_response" });
  }
  expect(measured.result.rows[2]).toMatchObject({ outcome: "uncalibrated", acquisition: {
    metrics: { "answer_span_exposure@5": { status: "unknown", reason: "invalid_response" } } } });
  expect(measured.result.rows[3]).toMatchObject({ selected: false, acquisition: null });
  expect(measured.result.acquisition.metrics["answer_span_exposure@5"]).toMatchObject({ denominator: 3, hits: 0, misses: 0, unknown: 3 });
  expect(measured.result.acquisition.metrics["source_bearing_any@5"]).toMatchObject({ denominator: 3, hits: 0, misses: 0, unknown: 3 });
  expect(measured.result.acquisition.support_sufficiency).toEqual({ measured: 0, not_measured: 3 });
  expect(measured.result.acquisition.observed_costs.evaluator_proof_work).toMatchObject({ known: 3, unknown: 0, known_sum: 0 });
  expect(measured.result.rows[1]?.acquisition?.earliest_observable_loss).toMatchObject({ status: "unknown", stage: null,
    earliest_unknown_stage: "source_available", observed_failed_stage: null });
  for (const [index, path] of producerPaths.entries()) expect(readFileSync(path)).toEqual(originalBytes[index]);
  expect(await measureLongMemEvalSemanticRun(run, replay.path, evaluator)).toEqual(measured);

  const refusedReplay = join(root, "refused-replay.json");
  writeChainArtifact(refusedReplay, { ...replay.result, rows: replay.result.rows.map((row, index) => index === 0
    ? { question_id: row.question_id, status: "unavailable", reason: "refusal" } : row) });
  const refused = await measureLongMemEvalSemanticRun(run, refusedReplay, join(root, "refusal-evaluator"));
  expect(refused.result.acquisition.metrics["answer_span_exposure@5"]).toMatchObject({ denominator: 3, hits: 0, misses: 0, unknown: 3 });
  expect(refused.result.rows[0]?.acquisition?.metrics["answer_span_exposure@5"]).toEqual({ status: "unknown", reason: "refusal" });

  // Supported-archive scoring and counterfeit-preview rejection stay in answer-exposure.test.ts;
  // refusing the native field family first cannot establish either of those guarantees.
}, 120_000);
