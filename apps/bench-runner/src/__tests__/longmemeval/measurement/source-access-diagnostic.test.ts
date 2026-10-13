import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { settleActiveBenchDaemonTasks } from "../../../harness/daemon-task.js";
import { SoulInterpretationPrepareQueryResponseSchema, SoulInterpretationRequestSchema } from "@do-soul/alaya-protocol";
import { callMcpTool } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import { censusCompleteSourceRecords } from "../../../runs/snapshot/source-records/census.js";
import { freezeLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/freeze.js";
import { readLongMemEvalSemanticFreeze } from "../../../runs/longmemeval-semantic/contract.js";
import { prepareLongMemEvalSemanticRun } from "../../../runs/longmemeval-semantic/execute.js";
import { observeSourceAccessDiagnostic } from "../../../runs/source-access-diagnostic/observe.js";
import { evaluateSourceAccessDiagnostic } from "../../../runs/source-access-diagnostic/evaluate.js";
import { runSourceAccessDiagnosticLauncher } from "../../../runs/source-access-diagnostic/launch.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, withSemanticChainDaemon,
  writeChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { SourceAccessDiagnosticEvaluationSchema, SourceAccessDiagnosticObservationSchema,
  type SourceAccessDiagnosticObservation } from "../../../runs/source-access-diagnostic/contract.js";

const roots = new Set<string>();
afterEach(async () => {
  await settleActiveBenchDaemonTasks();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function fixture(allGold = false, roundsPerSession = 1, questionCount = 1,
  sourceCount = 70, questionText = "Which source mentions tungsten?") {
  const root = await mkdtemp(join(tmpdir(), "source-access-diagnostic-"));
  roots.add(root);
  const dataDir = join(root, "data"), metaRoot = join(root, "meta");
  await mkdir(dataDir); await mkdir(metaRoot);
  const questions = Array.from({ length: questionCount }, (_, questionIndex) => {
    const sessionId = (index: number) => questionCount === 1 ? `session-${index}` : `session-${questionIndex}-${index}`;
    const sessions = Array.from({ length: sourceCount }, (_, index) =>
      Array.from({ length: roundsPerSession }, (_, round) => ({
        role: "user", content: index === sourceCount - 1
          ? roundsPerSession === 1 ? "The identifying fact is tungsten." : `The identifying fact is tungsten, round ${round}.`
          : roundsPerSession === 1 ? `Unrelated source ${index} describes a garden.`
            : `Unrelated source ${index}, round ${round}, describes a garden.` })));
    return { question_id: questionCount === 1 ? "synthetic-question" : `synthetic-question-${questionIndex}`,
      question_type: "fixture", question: questionText, answer: "synthetic gold, evaluator only",
      question_date: "2023/09/13 (Wed) 00:00",
      haystack_session_ids: sessions.map((_, index) => sessionId(index)),
      haystack_dates: sessions.map(() => "2023/09/12 (Tue) 00:00"),
      answer_session_ids: allGold ? sessions.map((_, index) => sessionId(index)) : [sessionId(sourceCount - 1)],
      haystack_sessions: sessions };
  });
  const source = JSON.stringify(questions);
  await writeFile(join(dataDir, "longmemeval_s.json"), source);
  await writeFile(join(metaRoot, "longmemeval_s.meta.json"), JSON.stringify({
    sha256: createHash("sha256").update(source).digest("hex"),
    size_bytes: Buffer.byteLength(source), question_count: questionCount
  }));
  const census = await censusCompleteSourceRecords({ population: "longmemeval_s", dataDir, pinnedMetaRoot: metaRoot });
  const sourceRoot = join(root, "source-run");
  const budget = { schema_version: 1, work_units: 1000000, memory_bytes: 60000000, page_budget: 100000,
    finalization_reserve: 10000, min_envelope: 10 };
  await freezeLongMemEvalSemanticRun({ data_dir: dataDir, pinned_meta_root: metaRoot,
    dataset_sha256: census.dataset_sha256, dataset_question_count: questionCount,
    question_ids: questions.map((question) => question.question_id),
    stage: "development", model: "gemini-2.5-flash-lite", provider_url: "http://127.0.0.1:9",
    request_profile: "gemini-2.5-nonthinking-v1", query_cache_root: join(root, "empty-query-cache"),
    recorded_at: "2026-09-13T00:00:00.000Z", producer_commit: "a".repeat(40),
    max_output_tokens: 4096, output_byte_limit: 1000000, budget }, sourceRoot);
  const prepared = await prepareLongMemEvalSemanticRun(sourceRoot);
  expect(prepared.result.rows).toHaveLength(questionCount);
  expect(prepared.result.rows.every((row) => row.status === "prepared")).toBe(true);
  const config = { contract: "source-access-diagnostic-config-v1", source_run_root: sourceRoot,
    prepared_path: prepared.path, expected_question_ids: questions.map((question) => question.question_id),
    policies: ["query-conditioned-v1", "canonical-v1"], budget,
    limits: { max_total_work: 2000000, max_pages: 100, max_pages_per_observation: 32,
      max_wall_ms: 60000, max_output_bytes: 8000000, max_disk_bytes: 200000000 } };
  return { root, config };
}

async function fileBytes(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    bytes += entry.isDirectory() ? await fileBytes(path) : (await stat(path)).size;
  }
  return bytes;
}

async function replaceAuthoredArtifact(path: string, payload: unknown): Promise<void> {
  await writeFile(path, JSON.stringify({ identity: chainIdentity(payload), payload }));
}

async function rebindRetainedResponse(root: string, observation: SourceAccessDiagnosticObservation,
  rowIndex: number, pageIndex: number, response: unknown): Promise<void> {
  const evidence = observation.rows[rowIndex]!.attempt_evidence[pageIndex]!;
  const pagePath = join(root, evidence.page!.path), resultPath = join(root, evidence.result!.path);
  const page = readChainArtifact(pagePath) as { response: unknown; wall_ms: number };
  const result = readChainArtifact(resultPath) as { response_identity: string; work: unknown;
    provider_attempts: number; wall_ms: number };
  const native = response as { work: unknown; provider_attempts: number };
  page.response = response;
  result.response_identity = chainIdentity(response);
  result.work = native.work; result.provider_attempts = native.provider_attempts;
  await replaceAuthoredArtifact(pagePath, page); evidence.page!.identity = chainIdentity(page);
  await replaceAuthoredArtifact(resultPath, result); evidence.result!.identity = chainIdentity(result);
}

describe("source access diagnostic", () => {
  it("reopens the raw-source SQLite snapshot and retains every native MCP page without provider calls", async () => {
    const f = await fixture();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls++; throw new Error("network prohibited"); }) as typeof fetch;
    try {
      const observed = await observeSourceAccessDiagnostic(f.config, join(f.root, "observed"));
      expect(observed.result.status).toBe("complete");
      expect(observed.result.rows).toHaveLength(2);
      for (const row of observed.result.rows) {
        expect(row.status).toBe("observed");
        expect(row.observed_source_count).toBe(70);
        expect(row.retained_source_count).toBe(70);
        expect(row.page_paths.length).toBeGreaterThan(1);
        expect(row.native_work).toBeGreaterThan(0);
        expect(row.initial_logical_work + row.continuation_logical_work).toBe(row.logical_work);
        expect(row.source_read_bytes).toBeGreaterThan(0);
        for (const path of row.page_paths) {
          const page = readChainArtifact(join(f.root, "observed", path)) as { response: {
            provider_attempts: number; query_handle?: string;
            query_semantics_status: unknown; outcome: unknown } };
          expect(page.response.provider_attempts).toBe(0);
          expect(page.response.query_handle).toEqual(expect.any(String));
          expect(page.response.query_semantics_status).toEqual({ status: "unavailable", reason: "absent" });
          expect(page.response.outcome).toMatchObject({ status: "preparation_required", missing: "query_semantics" });
        }
      }
      const evaluated = await evaluateSourceAccessDiagnostic(observed.path, join(f.root, "evaluated"));
      expect(evaluated.result.rows).toHaveLength(2);
      expect(evaluated.result.rows.every((row) => row.status === "measured" && row.first_gold_source_rank !== null)).toBe(true);
      const frozen = readLongMemEvalSemanticFreeze(f.config.source_run_root);
      const goldSource = frozen.selected[0]!.source_manifest.find((source) => source.session_id === "session-69")!;
      for (const [index, row] of observed.result.rows.entries()) {
        const nativeOrder = row.page_paths.flatMap((path) => {
          const page = readChainArtifact(join(f.root, "observed", path)) as { response: {
            access: { source_candidates: { source_id: string }[] } } };
          return page.response.access.source_candidates.map((candidate) => candidate.source_id);
        });
        const expectedRank = nativeOrder.indexOf(goldSource.source_id) + 1;
        expect(expectedRank).toBeGreaterThan(0);
        expect(evaluated.result.rows[index]?.first_gold_source_rank).toBe(expectedRank);
        expect(evaluated.result.rows[index]?.first_gold_session_rank).toBe(expectedRank);
        expect(evaluated.result.rows[index]).toMatchObject({ source_rank_unit: "source_root",
          session_rank_unit: "distinct_session", pool_k_unit: "source_root" });
        expect(evaluated.result.rows[index]?.pool_at_5).toBe(expectedRank <= 5 ? "hit" : "miss");
      }
      expect(evaluated.result.summary.every((row) => row.denominator === 1)).toBe(true);
      expect(observed.result.observation_bytes).toBe((await stat(observed.path)).size);
      expect(observed.result.output_bytes).toBe(await fileBytes(join(f.root, "observed")));
      expect(observed.result.output_bytes).toBe(observed.result.output_bytes_before_summary + observed.result.observation_bytes);
      expect(observed.result.disk_bytes_peak_observed).toBeGreaterThan(observed.result.disk_bytes_before_summary);
      expect(observed.result.wall_limit_scope).toBe("checkpointed_not_hard_deadline");
      expect(evaluated.result.public_recall).toBe("not_exercised");
      expect(evaluated.result.first_exposure).toBe("not_exercised");
      expect(fetchCalls).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
  }, 120000);

  it("retains a partial source pool and marks unobserved gold ranks unknown", async () => {
    const f = await fixture();
    const config = { ...f.config, limits: { ...f.config.limits, max_pages_per_observation: 1 } };
    const observed = await observeSourceAccessDiagnostic(config, join(f.root, "partial"));
    expect(observed.result.rows).toHaveLength(2);
    expect(observed.result.rows.every((row) => row.status === "partial" && row.page_paths.length === 1)).toBe(true);
    const evaluated = await evaluateSourceAccessDiagnostic(observed.path, join(f.root, "partial-evaluation"));
    expect(evaluated.result.rows.every((row) => row.status === "measured")).toBe(true);
    expect(evaluated.result.rows.every((row) => row.observation_status === "partial"
      && row.attempted_pages === 1)).toBe(true);
    expect(evaluated.result.rows.every((row) => row.rank_censored === true)).toBe(true);
    expect(evaluated.result.rows.every((row) => row.pool_at_50 === "unknown")).toBe(true);
    expect(evaluated.result.summary.filter((row) => row.k === 50)
      .every((row) => row.unknown_after_attempt === 1 && row.unattempted === 0)).toBe(true);
  }, 120000);

  it("reports source-root and distinct-session ranks separately for multiple rounds", async () => {
    const f = await fixture(false, 2);
    const observed = await observeSourceAccessDiagnostic(f.config, join(f.root, "multi-round"));
    const evaluated = await evaluateSourceAccessDiagnostic(observed.path, join(f.root, "multi-round-evaluation"));
    const frozen = readLongMemEvalSemanticFreeze(f.config.source_run_root);
    const sourceSessions = new Map(frozen.selected[0]!.source_manifest.map((source) => [source.source_id, source.session_id]));
    for (const [index, row] of observed.result.rows.entries()) {
      expect(row.status).toBe("observed");
      const orderedSessions = row.page_paths.flatMap((path) => {
        const page = readChainArtifact(join(f.root, "multi-round", path)) as { response: {
          access: { source_candidates: { source_id: string }[] } } };
        return page.response.access.source_candidates.map((candidate) => sourceSessions.get(candidate.source_id)!);
      });
      const sourceRank = orderedSessions.findIndex((session) => session === "session-69") + 1;
      const sessionRank = [...new Set(orderedSessions.slice(0, sourceRank))].length;
      expect(sourceRank).toBeGreaterThan(0);
      expect(evaluated.result.rows[index]).toMatchObject({ first_gold_source_rank: sourceRank,
        first_gold_session_rank: sessionRank, source_rank_unit: "source_root",
        session_rank_unit: "distinct_session", pool_k_unit: "source_root" });
    }
    expect(evaluated.result.rows.some((row) => row.first_gold_source_rank !== row.first_gold_session_rank)).toBe(true);
  }, 120000);

  it("binds retained pages and settled receipts before scoring the frozen pool", async () => {
    const f = await fixture();
    const observed = await observeSourceAccessDiagnostic(f.config, join(f.root, "bound-observed"));
    const baseline = await evaluateSourceAccessDiagnostic(observed.path, join(f.root, "bound-baseline"));
    const originalIdentity = chainIdentity(observed.result);
    const alteredRoot = join(f.root, "reordered-evidence");
    await cp(join(f.root, "bound-observed"), alteredRoot, { recursive: true });
    const canonical = observed.result.rows[1]!;
    const pages = canonical.page_paths.map((path) => join(alteredRoot, path));
    const first = readChainArtifact(pages[0]!) as { response: {
      access: { source_candidates: { source_id: string }[] } } };
    const goldSource = readLongMemEvalSemanticFreeze(f.config.source_run_root).selected[0]!
      .source_manifest.find((source) => source.session_id === "session-69")!.source_id;
    const goldPageIndex = pages.findIndex((path) => (readChainArtifact(path) as typeof first)
      .response.access.source_candidates.some((candidate) => candidate.source_id === goldSource));
    expect(goldPageIndex).toBeGreaterThan(0);
    const goldPage = readChainArtifact(pages[goldPageIndex]!) as typeof first;
    const goldIndex = goldPage.response.access.source_candidates.findIndex((candidate) => candidate.source_id === goldSource);
    expect(goldIndex).toBeGreaterThanOrEqual(0);
    [first.response.access.source_candidates[0], goldPage.response.access.source_candidates[goldIndex]] =
      [goldPage.response.access.source_candidates[goldIndex]!, first.response.access.source_candidates[0]!];
    await replaceAuthoredArtifact(pages[0]!, first);
    await replaceAuthoredArtifact(pages[goldPageIndex]!, goldPage);
    const altered = await evaluateSourceAccessDiagnostic(join(alteredRoot, "observation.json"), join(f.root, "reordered-result"));
    expect(altered.result.observation_identity).toBe(originalIdentity);
    expect(baseline.result.rows[1]?.status).toBe("measured");
    expect(altered.result.rows[1]).toMatchObject({ status: "unknown", pool_at_5: "unknown" });
    expect(altered.result.summary.every((row) => row.denominator === 1)).toBe(true);

    const missingRoot = join(f.root, "missing-receipt");
    await cp(join(f.root, "bound-observed"), missingRoot, { recursive: true });
    await rm(join(missingRoot, canonical.attempt_evidence[0]!.result!.path));
    const missing = await evaluateSourceAccessDiagnostic(join(missingRoot, "observation.json"), join(f.root, "missing-result"));
    expect(missing.result.rows[1]).toMatchObject({ status: "unknown", pool_at_5: "unknown" });
    expect(missing.result.observation_identity).toBe(originalIdentity);

    const missingStartRoot = join(f.root, "missing-start");
    await cp(join(f.root, "bound-observed"), missingStartRoot, { recursive: true });
    await rm(join(missingStartRoot, observed.result.start_artifact.path));
    const missingStart = await evaluateSourceAccessDiagnostic(join(missingStartRoot, "observation.json"),
      join(f.root, "missing-start-result"));
    expect(missingStart.result.rows.every((row) => row.status === "unknown" && row.pool_at_5 === "unknown")).toBe(true);
    expect(missingStart.result.summary.every((row) => row.denominator === 1)).toBe(true);
  }, 120000);

  it("rejects coherent native pages from another original question on the same sealed snapshot", async () => {
    const f = await fixture(false, 1, 1, 70, "Which source mentions garden?");
    const observed = await observeSourceAccessDiagnostic(f.config, join(f.root, "original-observed"));
    const baseline = await evaluateSourceAccessDiagnostic(observed.path, join(f.root, "original-evaluated"));
    expect(baseline.result.rows[0]).toMatchObject({ status: "measured", discovery_complete: true,
      pool_at_5: "miss" });
    const prepared = readChainArtifact(f.config.prepared_path) as { rows: { chain_root: string }[] };
    const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(prepared.rows[0]!.chain_root, "prepare.json")));
    const responses: ReturnType<typeof SoulInterpretationPrepareQueryResponseSchema.parse>[] = [];
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls++; throw new Error("provider network prohibited"); }) as typeof fetch;
    try {
      await withSemanticChainDaemon(plan.config, join(f.root, "foreign-native-session"), async (daemon) => {
        let continuation: string | undefined;
        do {
          const response = SoulInterpretationPrepareQueryResponseSchema.parse(await callMcpTool(daemon.mcpClient,
            "soul.interpretation", SoulInterpretationRequestSchema.parse({ operation: "prepare_query",
              original_query: "tungsten", budget: f.config.budget,
              access_policy: observed.result.rows[0]!.policy, authorized_scopes: plan.config.authorized_scopes,
              ...(continuation === undefined ? {} : { continuation_handle: continuation }) })));
          responses.push(JSON.parse(JSON.stringify(response)));
          continuation = response.continuation_handle;
        } while (continuation !== undefined);
      });
    } finally { globalThis.fetch = originalFetch; }
    expect(fetchCalls).toBe(0);
    expect(responses.every((response) => response.provider_attempts === 0)).toBe(true);
    const goldSource = readLongMemEvalSemanticFreeze(f.config.source_run_root).selected[0]!.source_manifest
      .find((source) => source.session_id === "session-69")!.source_id;
    expect(responses[0]?.access?.source_candidates[0]?.source_id).toBe(goldSource);
    expect(responses).toHaveLength(observed.result.rows[0]!.attempt_evidence.length);
    const alteredRoot = join(f.root, "foreign-observed");
    await cp(join(f.root, "original-observed"), alteredRoot, { recursive: true });
    const altered = readChainArtifact(join(alteredRoot, "observation.json")) as SourceAccessDiagnosticObservation;
    const row = altered.rows[0]!, oldWork = row.logical_work;
    let offset = 0;
    for (const [index, response] of responses.entries()) {
      const evidence = row.attempt_evidence[index]!;
      const startedPath = join(alteredRoot, evidence.started.path);
      const started = readChainArtifact(startedPath) as { prior_pool_id: string | null; source_offset: number };
      started.prior_pool_id = index === 0 ? null : response.access!.pool_id;
      started.source_offset = offset;
      await replaceAuthoredArtifact(startedPath, started);
      evidence.started.identity = chainIdentity(started);
      await rebindRetainedResponse(alteredRoot, altered, 0, index, response);
      offset += response.access!.source_candidates.length;
    }
    row.pool_id = responses[0]!.access!.pool_id;
    row.initial_logical_work = responses[0]!.work.logical_work!;
    row.continuation_logical_work = responses.slice(1).reduce((sum, response) => sum + response.work.logical_work!, 0);
    row.logical_work = row.initial_logical_work + row.continuation_logical_work;
    row.native_work = responses.reduce((sum, response) => sum + response.work.native_work, 0);
    row.native_bytes = responses.reduce((sum, response) => sum + response.work.native_bytes, 0);
    row.source_read_bytes = responses.flatMap((response) => response.access!.source_candidates)
      .reduce((sum, candidate) => sum + candidate.read_bytes, 0);
    row.incomplete_source_bodies = responses.flatMap((response) => response.access!.source_candidates)
      .filter((candidate) => !candidate.complete).length;
    row.stopping_reasons = [...new Set(responses.flatMap((response) => response.access!.stopping_reasons))];
    row.unvisited_sources = responses.at(-1)!.access!.unvisited_sources;
    altered.total_logical_work += row.logical_work - oldWork;
    await replaceAuthoredArtifact(join(alteredRoot, "observation.json"), altered);
    const evaluated = await evaluateSourceAccessDiagnostic(join(alteredRoot, "observation.json"),
      join(f.root, "foreign-evaluated"));
    expect(evaluated.result.rows[0]).toMatchObject({ status: "unknown", discovery_complete: null,
      pool_at_5: "unknown", first_gold_source_rank: null });
    expect(evaluated.result.summary.every((item) => item.denominator === 1)).toBe(true);
  }, 120000);

  it("rejects native residuals that contradict a rebound observation summary", async () => {
    const f = await fixture();
    const observed = await observeSourceAccessDiagnostic(f.config, join(f.root, "residual-observed"));
    const alteredRoot = join(f.root, "residual-evidence");
    await cp(join(f.root, "residual-observed"), alteredRoot, { recursive: true });
    const altered = readChainArtifact(join(alteredRoot, "observation.json")) as SourceAccessDiagnosticObservation;
    const evidence = altered.rows[1]!.attempt_evidence.at(-1)!;
    const pagePath = join(alteredRoot, evidence.page!.path), resultPath = join(alteredRoot, evidence.result!.path);
    const page = readChainArtifact(pagePath) as { response: { access: {
      unvisited_sources: boolean; stopping_reasons: string[] } } };
    page.response.access.unvisited_sources = true;
    page.response.access.stopping_reasons = ["source_limit"];
    await replaceAuthoredArtifact(pagePath, page);
    evidence.page!.identity = chainIdentity(page);
    const result = readChainArtifact(resultPath) as { response_identity: string };
    result.response_identity = chainIdentity(page.response);
    await replaceAuthoredArtifact(resultPath, result);
    evidence.result!.identity = chainIdentity(result);
    await replaceAuthoredArtifact(join(alteredRoot, "observation.json"), altered);
    const evaluated = await evaluateSourceAccessDiagnostic(join(alteredRoot, "observation.json"), join(f.root, "residual-result"));
    expect(evaluated.result.rows[1]).toMatchObject({ status: "unknown", discovery_complete: null,
      pool_at_5: "unknown", pool_at_50: "unknown" });
    expect(evaluated.result.summary.every((row) => row.denominator === 1)).toBe(true);
  }, 120000);

  it("rejects contradictory per-page omitted counts and nonempty interpretation state", async () => {
    const f = await fixture(false, 1, 1, 72, "Which source mentions garden?");
    const observed = await observeSourceAccessDiagnostic(f.config, join(f.root, "trace-observed"));
    const baseline = await evaluateSourceAccessDiagnostic(observed.path, join(f.root, "trace-baseline"));
    expect(baseline.result.rows[0]).toMatchObject({ status: "measured", discovery_complete: true,
      pool_at_5: "miss" });
    const original = observed.result.rows[0]!;
    expect(original.page_paths).toHaveLength(5);
    for (const path of original.page_paths) {
      const page = readChainArtifact(join(f.root, "trace-observed", path)) as { response: {
        access: { observed_source_count: number; source_candidates: unknown[];
          trace: { omitted_source_count: number } } } };
      expect(page.response.access.trace.omitted_source_count)
        .toBe(page.response.access.observed_source_count - page.response.access.source_candidates.length);
    }
    const lastPage = readChainArtifact(join(f.root, "trace-observed", original.page_paths.at(-1)!)) as {
      response: { access: { trace: { source_offset: number; omitted_source_count: number };
        source_candidates: unknown[] } } };
    expect(lastPage.response.access.source_candidates).toHaveLength(8);
    expect(lastPage.response.access.trace).toMatchObject({ source_offset: 64, omitted_source_count: 64 });
    for (const kind of ["omitted-source", "observed-interpretation", "interpretation-candidate", "short-complete",
      "missing-query-handle", "wrong-query-status"] as const) {
      const alteredRoot = join(f.root, `trace-${kind}`);
      await cp(join(f.root, "trace-observed"), alteredRoot, { recursive: true });
      const altered = readChainArtifact(join(alteredRoot, "observation.json")) as SourceAccessDiagnosticObservation;
      const evidence = altered.rows[0]!.attempt_evidence.at(-1)!;
      const retained = readChainArtifact(join(alteredRoot, evidence.page!.path)) as { response: unknown };
      const response = retained.response as { query_handle?: string;
        query_semantics_status: { status: string; reason: string }; access: {
        observed_interpretation_count: number; interpretation_candidates: unknown[];
        source_candidates: { read_bytes: number; body_bytes: number | null; complete: boolean }[];
        trace: { omitted_source_count: number; omitted_interpretation_count: number } } };
      if (kind === "omitted-source") response.access.trace.omitted_source_count = 999;
      if (kind === "observed-interpretation") {
        response.access.observed_interpretation_count = 1;
        response.access.trace.omitted_interpretation_count = 1;
      }
      if (kind === "interpretation-candidate") {
        response.access.observed_interpretation_count = 1;
        response.access.interpretation_candidates = [{ interpretation_id: `sha256:${"a".repeat(64)}`,
          record_id: `sha256:${"b".repeat(64)}`,
          signal: { source_text_score: null, interpretation_reading_score: 0 } }];
      }
      if (kind === "short-complete") {
        const source = response.access.source_candidates[0]!;
        expect(source.complete).toBe(true);
        expect(source.body_bytes).toBeGreaterThan(0);
        source.read_bytes = source.body_bytes! - 1;
        altered.rows[0]!.source_read_bytes--;
      }
      if (kind === "missing-query-handle") response.query_handle = undefined;
      if (kind === "wrong-query-status") response.query_semantics_status.reason = "invalid";
      await rebindRetainedResponse(alteredRoot, altered, 0, original.page_paths.length - 1, response);
      await replaceAuthoredArtifact(join(alteredRoot, "observation.json"), altered);
      const evaluated = await evaluateSourceAccessDiagnostic(join(alteredRoot, "observation.json"),
        join(f.root, `trace-evaluated-${kind}`));
      expect(evaluated.result.rows[0]).toMatchObject({ status: "unknown", discovery_complete: null,
        pool_at_5: "unknown" });
      expect(evaluated.result.summary.every((item) => item.denominator === 1)).toBe(true);
    }
    const openRoot = join(f.root, "interpretation-open");
    await cp(join(f.root, "trace-observed"), openRoot, { recursive: true });
    const open = readChainArtifact(join(openRoot, "observation.json")) as SourceAccessDiagnosticObservation;
    for (const [index, evidence] of open.rows[0]!.attempt_evidence.entries()) {
      const retained = readChainArtifact(join(openRoot, evidence.page!.path)) as { response: unknown };
      const response = retained.response as { access: { unvisited_interpretations: boolean;
        stopping_reasons: string[] }; coverage: { discovery: string }; truncated: boolean };
      response.access.unvisited_interpretations = true;
      response.access.stopping_reasons = ["budget"];
      response.coverage.discovery = "truncated";
      response.truncated = true;
      await rebindRetainedResponse(openRoot, open, 0, index, response);
    }
    open.rows[0]!.stopping_reasons = ["budget"];
    await replaceAuthoredArtifact(join(openRoot, "observation.json"), open);
    const openEvaluation = await evaluateSourceAccessDiagnostic(join(openRoot, "observation.json"),
      join(f.root, "interpretation-open-evaluated"));
    expect(openEvaluation.result.rows[0]).toMatchObject({ status: "measured", rank_censored: true,
      discovery_complete: false, pool_at_5: "unknown" });
  }, 120000);

  it("keeps a witnessed hit when an explicitly recorded later attempt is unresolved", async () => {
    const f = await fixture(true);
    const observed = await observeSourceAccessDiagnostic({ ...f.config,
      limits: { ...f.config.limits, max_pages_per_observation: 1 } }, join(f.root, "prefix-observed"));
    const alteredRoot = join(f.root, "unresolved-prefix");
    await cp(join(f.root, "prefix-observed"), alteredRoot, { recursive: true });
    const altered = readChainArtifact(join(alteredRoot, "observation.json")) as SourceAccessDiagnosticObservation;
    const row = altered.rows[0]!;
    const startedPath = "attempts/00000/query-conditioned-v1/001.started.json";
    const started = { question_id: row.question_id, policy: row.policy, page_number: 1,
      source_offset: row.retained_source_count, prior_pool_id: row.pool_id };
    writeChainArtifact(join(alteredRoot, startedPath), started);
    row.attempt_evidence.push({ page_number: 1, started: { path: startedPath, identity: chainIdentity(started) },
      result: null, page: null });
    row.attempt_paths.push(startedPath);
    row.attempted_pages++;
    row.unresolved_attempts++;
    row.reason = "native_access: interrupted";
    altered.attempted_pages++;
    altered.unresolved_attempts++;
    altered.status = "stopped";
    altered.stop_reason = "native_access: interrupted";
    await replaceAuthoredArtifact(join(alteredRoot, "observation.json"), altered);
    const evaluated = await evaluateSourceAccessDiagnostic(join(alteredRoot, "observation.json"), join(f.root, "unresolved-result"));
    expect(evaluated.result.rows[0]).toMatchObject({ status: "measured", observation_status: "partial",
      attempted_pages: 2, rank_censored: true, pool_at_5: "hit" });
  }, 120000);

  it("keeps a witnessed gold hit when native discovery is truncated", async () => {
    const f = await fixture(true);
    const observed = await observeSourceAccessDiagnostic({ ...f.config,
      limits: { ...f.config.limits, max_pages_per_observation: 1 } }, join(f.root, "hit-partial"));
    const evaluated = await evaluateSourceAccessDiagnostic(observed.path, join(f.root, "hit-partial-evaluation"));
    expect(evaluated.result.rows.every((row) => row.status === "measured" && row.rank_censored
      && row.first_gold_source_rank === 1 && row.pool_at_5 === "hit")).toBe(true);
  }, 120000);

  it("retains completed native attempt costs when the observation output bound stops paging", async () => {
    // 480 sources exceed the output-limited page count without importing the larger 2100-source population.
    const f = await fixture(false, 30, 1, 16);
    const observed = await observeSourceAccessDiagnostic({ ...f.config,
      limits: { ...f.config.limits, max_total_work: 20_000_000,
        max_output_bytes: 144 * 1024 } }, join(f.root, "output-limited"));
    expect(observed.result.stop_reason).toBe("output_bytes_limit");
    expect(observed.result.attempted_pages).toBeGreaterThan(0);
    expect(observed.result.settled_pages).toBeGreaterThan(0);
    expect(observed.result.unresolved_attempts).toBe(0);
    expect(observed.result.total_logical_work).toBeGreaterThan(0);
    expect(observed.result.settled_pages).toBe(observed.result.attempted_pages);
    const attempts = observed.result.rows.flatMap((row) => row.attempt_evidence);
    expect(attempts).toHaveLength(observed.result.settled_pages);
    let retainedLogicalWork = 0;
    for (const attempt of attempts) {
      expect(attempt.result).not.toBeNull();
      const result = readChainArtifact(join(f.root, "output-limited", attempt.result!.path)) as {
        work: { logical_work: number }; provider_attempts: number };
      expect(result.work.logical_work).toBeGreaterThan(0);
      expect(result.provider_attempts).toBe(0);
      retainedLogicalWork += result.work.logical_work;
    }
    expect(retainedLogicalWork).toBe(observed.result.total_logical_work);
    expect(observed.result.output_bytes).toBeLessThanOrEqual(144 * 1024);
    expect(observed.result.provider_calls).toBe(0);
    expect(readChainArtifact(join(f.root, "output-limited", "start.json"))).toBeDefined();
  }, 120000);

  it("retains a multi-question native summary beyond the former fixed reservation and stops within a tighter bound", async () => {
    const f = await fixture(false, 1, 4, 512);
    const config = { ...f.config, limits: { ...f.config.limits,
      max_total_work: 40000000, max_pages: 800, max_wall_ms: 180000 } };
    const observed = await observeSourceAccessDiagnostic(config, join(f.root, "large-observed"));
    expect(observed.result.status).toBe("complete");
    expect(observed.result.rows).toHaveLength(8);
    expect(observed.result.total_pages).toBe(256);
    expect(observed.result.attempted_pages).toBe(256);
    expect(observed.result.observation_bytes).toBeGreaterThan(128 * 1024);
    expect(observed.result.observation_bytes).toBeLessThanOrEqual(observed.result.summary_reserved_bytes);
    expect(observed.result.output_bytes).toBeLessThanOrEqual(config.limits.max_output_bytes);
    expect((await stat(observed.path)).size).toBe(observed.result.observation_bytes);
    const evaluated = await evaluateSourceAccessDiagnostic(observed.path, join(f.root, "large-evaluated"));
    expect(evaluated.result.rows).toHaveLength(8);
    expect(evaluated.result.summary.every((row) => row.denominator === 4)).toBe(true);

    const tightLimit = Math.max(144 * 1024, observed.result.output_bytes - 20000);
    const limited = await observeSourceAccessDiagnostic({ ...config,
      limits: { ...config.limits, max_output_bytes: tightLimit } }, join(f.root, "capacity-stopped"));
    expect(limited.result.status).toBe("stopped");
    expect(limited.result.stop_reason).toBe("output_bytes_limit");
    expect(limited.result.total_pages).toBeLessThan(256);
    expect(limited.result.rows).toHaveLength(8);
    expect(limited.result.observation_bytes).toBeLessThanOrEqual(limited.result.summary_reserved_bytes);
    expect(limited.result.output_bytes).toBeLessThanOrEqual(tightLimit);
    const limitedEvaluation = await evaluateSourceAccessDiagnostic(limited.path, join(f.root, "capacity-evaluated"));
    expect(limitedEvaluation.result.rows).toHaveLength(8);
    expect(limitedEvaluation.result.summary.every((row) => row.denominator === 4)).toBe(true);
  }, 300000);

  it("preserves the complete denominator and aggregate stop on a native page boundary", async () => {
    const f = await fixture();
    const config = { ...f.config, limits: { ...f.config.limits, max_pages: 1 } };
    const observed = await observeSourceAccessDiagnostic(config, join(f.root, "stopped"));
    expect(observed.result.status).toBe("stopped");
    expect(observed.result.stop_reason).toBe("page_limit");
    expect(observed.result.rows.map((row) => row.status)).toEqual(["partial", "unattempted"]);
    const evaluated = await evaluateSourceAccessDiagnostic(observed.path, join(f.root, "stopped-evaluation"));
    expect(evaluated.result.rows[1]?.status).toBe("unattempted");
    expect(evaluated.result.rows[1]?.attempted_pages).toBe(0);
    expect(evaluated.result.summary.filter((row) => row.policy === "canonical-v1")
      .every((row) => row.unattempted === 1 && row.unknown === 1)).toBe(true);
    expect(evaluated.result.summary.filter((row) => row.policy === "query-conditioned-v1")
      .every((row) => row.unattempted === 0)).toBe(true);
    expect(evaluated.result.summary.every((row) => row.denominator === 1)).toBe(true);
  }, 120000);

  it("stops before SQLite restore when the snapshot cannot fit the remaining disk allowance", async () => {
    const f = await fixture(false, 1, 1, 1);
    const prepared = readChainArtifact(f.config.prepared_path) as { rows: { chain_root: string }[] };
    const plan = readChainArtifact(join(prepared.rows[0]!.chain_root, "prepare.json")) as {
      config: { snapshot_path: string } };
    const sourceBytes = await fileBytes(f.config.source_run_root);
    const snapshotBytes = (await stat(plan.config.snapshot_path)).size;
    const limit = sourceBytes + 128 * 1024 + Math.floor(snapshotBytes / 2);
    const observed = await observeSourceAccessDiagnostic({ ...f.config,
      limits: { ...f.config.limits, max_disk_bytes: limit } }, join(f.root, "disk-stopped"));
    expect(observed.result.stop_reason).toBe("disk_bytes_limit_before_session");
    expect(observed.result.rows.map((row) => row.status)).toEqual(["unattempted", "unattempted"]);
    expect(observed.result.disk_admission_snapshot_bytes).toBe(snapshotBytes);
    expect(observed.result.disk_bytes_peak_observed).toBeGreaterThanOrEqual(sourceBytes);
    expect(observed.result.disk_bytes_at_stop).toBeGreaterThanOrEqual(sourceBytes);
    expect(observed.result.disk_limit_scope).toBe("checkpointed_snapshot_reservation_not_hard_cap");
    expect(await readdir(join(f.root, "disk-stopped"))).not.toContain("sessions");
  }, 120000);

  it("keeps zero page attempts unattempted through evaluation", async () => {
    const f = await fixture(false, 1, 1, 1);
    const observed = await observeSourceAccessDiagnostic({ ...f.config,
      limits: { ...f.config.limits, max_total_work: 1 } }, join(f.root, "work-stopped"));
    expect(observed.result.stop_reason).toBe("logical_work_limit");
    expect(observed.result.rows.map((row) => row.status)).toEqual(["unattempted", "unattempted"]);
    expect(observed.result.attempted_pages).toBe(0);
    const evaluated = await evaluateSourceAccessDiagnostic(observed.path, join(f.root, "work-evaluated"));
    expect(evaluated.result.rows.map((row) => row.status)).toEqual(["unattempted", "unattempted"]);
    expect(evaluated.result.summary.every((row) => row.denominator === 1 && row.unknown === 1
      && row.unattempted === 1 && row.unknown_before_attempt === 0 && row.unknown_after_attempt === 0)).toBe(true);
  }, 120000);

  it("rejects output roots reached through physical aliases of source or observation trees", async () => {
    const f = await fixture(false, 1, 1, 1);
    const sourceAlias = join(f.root, "source-alias");
    await symlink(f.config.source_run_root, sourceAlias, "dir");
    await expect(observeSourceAccessDiagnostic(f.config, join(sourceAlias, "alias-observe")))
      .rejects.toThrow(/isolated/u);
    expect(await readdir(f.config.source_run_root)).not.toContain("alias-observe");

    const observed = await observeSourceAccessDiagnostic(f.config, join(f.root, "alias-control"));
    await expect(evaluateSourceAccessDiagnostic(observed.path, join(sourceAlias, "alias-evaluate")))
      .rejects.toThrow(/isolated/u);
    expect(await readdir(f.config.source_run_root)).not.toContain("alias-evaluate");
    const observationAlias = join(f.root, "observation-alias");
    await symlink(join(f.root, "alias-control"), observationAlias, "dir");
    await expect(evaluateSourceAccessDiagnostic(observed.path, join(observationAlias, "alias-evaluate")))
      .rejects.toThrow(/isolated/u);
    expect(await readdir(join(f.root, "alias-control"))).not.toContain("alias-evaluate");
  }, 120000);

  it("rejects mismatched membership before reopening a source and parses CLI arguments strictly", async () => {
    const f = await fixture(false, 1, 1, 1);
    const observed = await observeSourceAccessDiagnostic({ ...f.config,
      expected_question_ids: ["not-the-frozen-question"] }, join(f.root, "rejected"));
    expect(observed.result.rows.map((row) => row.status)).toEqual(["unattempted", "unattempted"]);
    expect(observed.result.stop_reason).toContain("source_identity:");
    expect(await runSourceAccessDiagnosticLauncher(["observe", "--config", "missing"])).toBe(2);
  }, 120000);

  it("runs the separate observe and gold-evaluate CLI operations on a synthetic snapshot", async () => {
    const f = await fixture(false, 1, 1, 1);
    const configPath = join(f.root, "access-config.json");
    await writeFile(configPath, JSON.stringify(f.config));
    const observedRoot = join(f.root, "cli-observed"), evaluatedRoot = join(f.root, "cli-evaluated");
    expect(await runSourceAccessDiagnosticLauncher(["observe", "--config", configPath, "--out", observedRoot])).toBe(0);
    const observed = SourceAccessDiagnosticObservationSchema.parse(readChainArtifact(join(observedRoot, "observation.json")));
    expect(observed.rows.map((row) => row.status)).toEqual(["observed", "observed"]);
    expect(observed.rows.map((row) => row.retained_source_count)).toEqual([1, 1]);
    expect(await runSourceAccessDiagnosticLauncher(["evaluate", "--observation",
      join(observedRoot, "observation.json"), "--out", evaluatedRoot])).toBe(0);
    const evaluated = SourceAccessDiagnosticEvaluationSchema.parse(readChainArtifact(join(evaluatedRoot, "evaluation.json")));
    expect(evaluated.rows.every((row) => row.status === "measured")).toBe(true);
    expect(evaluated.rows.map((row) => row.first_gold_source_rank)).toEqual([1, 1]);
  }, 120000);
});
