import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { LongMemEvalQuestionDiagnosticSchema } from "../../longmemeval/diagnostics-schema.js";
import {
  buildLongMemEvalEvidenceManifest,
  renderLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceManifest
} from "../../longmemeval/evidence-manifest.js";
import {
  makeShardDiagnostics,
  makeShardKpi,
  withEligibleMeasurementContract,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION
} from "../../longmemeval/extraction-cache-manifest.js";
import { computeQuestionIdDigest } from "../../longmemeval/selection/question-manifest.js";
import { computeCohortAssignmentDigest } from "../../longmemeval/selection/contract.js";
import { MERGE_TEST_DATASET_SHA256 } from "./cli-merge-dataset-fixture.js";
import { syntheticExtractionClosure } from
  "../longmemeval/extraction-closure-fixture.js";

const DATASET_SHA = MERGE_TEST_DATASET_SHA256;

export const roots: string[] = [];

export async function cleanupRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export function cohort() {
  return {
    dataset_cohort: "answerable",
    extraction_materialization: { status: "memory_emitted", emitted_memory_count: 1, reason: null },
    evaluator_gold_identity: { status: "present", object_ids: ["gold-a"] },
    retrieval_status: "hit_at_5",
    evidence_status: "complete",
    evaluation_issue_reason: null,
    candidate_pool_complete: true,
    stage_ranks: [],
    final_verdict: "hit_at_5"
  } as const;
}

export function question(id: string, candidates: readonly unknown[] = []) {
  return {
    question_id: id,
    gold_memory_ids: ["gold-a"],
    delivered_memory_ids: ["gold-a"],
    delivered_gold_ids: ["gold-a"],
    miss_reasons: [],
    provider_state: "provider_not_requested",
    query_probes: { normalized_query: "synthetic" },
    candidate_pool_complete: true,
    candidate_pool_count: candidates.length,
    fine_pruned_count: 0,
    fine_assessment_pruned_candidates: [],
    cohort_ledger: cohort(),
    candidates
  };
}

export function candidate() {
  return {
    object_id: "gold-a",
    candidate_key: "workspace_local:memory_entry:gold-a",
    origin_plane: "workspace_local",
    final_rank: 1,
    pre_budget_rank: 1,
    selection_order: 1,
    fused_rank: 1,
    fused_score: 1,
    per_stream_rank: null,
    fused_rank_contribution_per_stream: null,
    score_factors: {}
  };
}

export function streamedQuestion(id: string) {
  return LongMemEvalQuestionDiagnosticSchema.parse({
    question_id: id,
    question_type: "single-session-user",
    is_abstention: false,
    premise_invalid: false,
    round_index: null,
    gold_memory_ids: [],
    answer_session_ids: [],
    delivered_results: [],
    active_constraint_results: [],
    hit_at_1: false,
    hit_at_5: false,
    hit_at_10: false,
    miss_classification: "candidate_absent",
    miss_taxonomy: null,
    degradation_reason: null,
    recall_diagnostics_present: true,
    recall_diagnostics_keys: [],
    provider_state: "provider_not_requested",
    provider_degradation_reason: null,
    graph_expansion_plane_count_per_hop: [0, 0],
    graph_expansion_plane_count_per_edge_type: {
      derives_from: 0,
      recalls: 0,
      supports: 0
    },
    candidate_pool_complete: true,
    candidate_pool_count: 0,
    fine_pruned_count: 0,
    fine_assessment_pruned_candidates: [],
    query_sought_facets: null,
    candidates: [],
    candidate_key_collisions: [],
    gold: []
  });
}

export function provenance(
  offset: number,
  count: number,
  questionIds: readonly string[] = Array.from(
    { length: count }, (_, index) => `fixture-${offset + index}`
  ),
  commitSha7 = "abc1234"
) {
  const selection = selectionIdentity(questionIds);
  return {
    schema_version: 1,
    dataset_sha256: DATASET_SHA,
    selection,
    code: fixtureCodeProvenance(commitSha7),
    extraction_cache: fixtureExtractionCache(count),
    runtime: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      embedding_mode: "disabled",
      embedding_provider_kind: "openai",
      embedding_provider_label: "none",
      onnx_threads: null,
      embedding_supplement: { enabled: false },
      answer_rerank: { enabled: false },
      paired_env: {}
    },
    execution: {
      protocol: "sequential",
      concurrency: 1,
      offset,
      limit: count,
      evaluated_count: count
    },
    recall_config: {
      conf_slice_compatibility: false,
      schema_version: 2,
      max_results: 10,
      conflict_awareness: true,
      effective_config_sha256: "d".repeat(64)
    },
    seed_capabilities: { facet_tags_enabled: false },
    question_manifest: null
  };
}

function fixtureCodeProvenance(commitSha7: string) {
  return {
    commit_sha7: commitSha7,
    commit_sha: commitSha7 + "0".repeat(33),
    gate_sha256: "a".repeat(64),
    gate_contract_path: "/tmp/frozen-contract.json",
    worktree_state_sha256: "b".repeat(64),
    worktree_clean: true,
    executed_dist: {
      algorithm: "sha256-reachable-path-file-sha256-v1",
      sha256: "f".repeat(64),
      file_count: 3
    }
  };
}

function fixtureExtractionCache(count: number) {
  const extractionModel = "fixture-model";
  const requestProfile = "provider-default-v1" as const;
  const closure = syntheticExtractionClosure({
    count,
    model: extractionModel,
    requestProfile,
    seed: `cli-merge-${count}`
  });
  return {
    manifest_sha256: "c".repeat(64),
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: extractionModel,
    model_family: "fixture-model-family",
    request_profile: requestProfile,
    provider_url: "redacted",
    system_prompt_sha256: "e".repeat(64),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval_s",
    dataset_revision: DATASET_SHA,
    requested_turns: count,
    cached_turns: count,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: 500,
    ...closure,
    storage: "git-tracked",
    built_at: "2026-07-11T00:00:00.000Z",
    builder: "fixture"
  };
}

export async function writeProvenance(root: string, body: unknown): Promise<void> {
  const archive = path.join(root, "public", "2026-05-14T100000Z-abc1234");
  await mkdir(archive, { recursive: true });
  await writeFile(
    path.join(archive, "longmemeval-run-provenance.json"),
    `${JSON.stringify(body, null, 2)}\n`,
    "utf8"
  );
}

export async function setupShard(root: string, id: string, offset: number): Promise<void> {
  const kpi = eligibleShardKpi(id);
  const diagnostics = makeShardDiagnostics({
    recall_pipeline_version: kpi.recall_pipeline_version,
    policy_shape: kpi.policy_shape,
    simulate_report: kpi.simulate_report,
    seed_extraction_path: kpi.kpi.seed_extraction_path,
    report_usage: {
      mode: "none",
      reports_attempted: 0,
      reports_used: 0,
      reports_skipped: 1,
      used_object_count: 0
    },
    report_side_effects: undefined,
    questions: [{
      ...streamedQuestion(id),
      hit_at_1: true,
      hit_at_5: true,
      hit_at_10: true,
      miss_classification: "hit_at_5",
      cohort_ledger: cohort()
    }]
  });
  const provenanceBody = provenance(offset, 1, [id], kpi.alaya_commit);
  await writeShardRoot(root, kpi, diagnostics);
  await writeProvenance(root, provenanceBody);
  await writeShardEvidenceBundle(
    root,
    kpi,
    diagnostics,
    provenanceBody,
    diagnostics
  );
}

export async function setupCompactShard(
  root: string,
  id: string,
  offset: number
): Promise<void> {
  const kpi = eligibleShardKpi(id);
  const fullDiagnostics = makeShardDiagnostics({ questions: [streamedQuestion(id)] });
  const compactDiagnostics = makeShardDiagnostics({
    compact_schema_version: 1,
    question_count: 1,
    full_diagnostics_artifact_path: "longmemeval-diagnostics.json.gz",
    questions: undefined
  });
  const provenanceBody = provenance(offset, 1, [id], kpi.alaya_commit);
  await writeShardRoot(root, kpi, compactDiagnostics);
  await writeProvenance(root, provenanceBody);
  await writeShardEvidenceBundle(
    root,
    kpi,
    compactDiagnostics,
    provenanceBody,
    fullDiagnostics
  );
}

function eligibleShardKpi(id: string) {
  const eligible = withEligibleMeasurementContract(makeShardKpi({
    evaluated_count: 1,
    kpi: { ...makeShardKpi().kpi, r_at_1: 1, r_at_5: 1, r_at_10: 1 }
  }));
  return {
    ...eligible,
    selection_contract: selectionIdentity([id]),
    kpi: {
      ...eligible.kpi,
      per_scenario: [{
        id,
        version: 1,
        hit_at_5: true,
        scorable: true,
        measurement_cohort: "answerable" as const,
        tier: "warm" as const
      }]
    }
  };
}

export async function writeShardEvidenceBundle(
  root: string,
  kpi: ReturnType<typeof makeShardKpi>,
  diagnostics: ReturnType<typeof makeShardDiagnostics>,
  provenanceBody: unknown,
  fullDiagnostics: ReturnType<typeof makeShardDiagnostics> = diagnostics
): Promise<void> {
  const slug = `2026-05-14T100000Z-${kpi.alaya_commit}`;
  const archive = path.join(root, "public", slug);
  const kpiContents = `${JSON.stringify(kpi, null, 2)}\n`;
  const diagnosticsContents = `${JSON.stringify(diagnostics, null, 2)}\n`;
  const provenanceContents = `${JSON.stringify(provenanceBody, null, 2)}\n`;
  const questionIds = kpi.kpi.per_scenario.map((row) => row.id);
  const questionIdDigest = createHash("sha256")
    .update(questionIds.join("\0"), "utf8")
    .digest("hex");
  const selection = selectionIdentity(questionIds);
  const cohortContents = `${JSON.stringify({
    schema_version: 1,
    question_count: questionIds.length,
    question_id_digest: questionIdDigest,
    selection_contract: selection,
    rows: questionIds.map((question_id) => ({ question_id, ...cohort() }))
  }, null, 2)}\n`;
  const comparisonContents = "{}\n";
  const fullBytes = gzipSync(`${JSON.stringify(fullDiagnostics, null, 2)}\n`);
  await writeFile(path.join(archive, "longmemeval-diagnostics.json.gz"), fullBytes);
  await writeFile(path.join(archive, "longmemeval-cohort-ledger.json"), cohortContents);
  await writeFile(path.join(archive, "longmemeval-cold-warm-comparison.json"), comparisonContents);
  const manifest = buildShardEvidenceManifest({
    slug,
    kpi,
    questionIdDigest,
    selection,
    kpiContents,
    diagnosticsContents,
    fullBytes,
    cohortContents,
    comparisonContents,
    provenanceContents
  });
  await writeFile(
    path.join(archive, "longmemeval-evidence-manifest.json"),
    renderLongMemEvalEvidenceManifest(manifest)
  );
}

interface ShardEvidenceManifestInput {
  readonly slug: string;
  readonly kpi: ReturnType<typeof makeShardKpi>;
  readonly questionIdDigest: string;
  readonly selection: ReturnType<typeof selectionIdentity>;
  readonly kpiContents: string;
  readonly diagnosticsContents: string;
  readonly fullBytes: ReturnType<typeof gzipSync>;
  readonly cohortContents: string;
  readonly comparisonContents: string;
  readonly provenanceContents: string;
}

function buildShardEvidenceManifest(input: ShardEvidenceManifestInput) {
  return buildLongMemEvalEvidenceManifest({
    run: {
      slug: input.slug,
      bench_name: "public",
      split: input.kpi.split,
      run_at: input.kpi.run_at,
      alaya_commit: input.kpi.alaya_commit,
      dataset_sha256: input.kpi.dataset.checksum_sha256 ?? "a".repeat(64),
      selection_manifest_sha256: null,
      question_id_digest: input.questionIdDigest,
      selection_contract: input.selection,
      candidate_pool_complete: true,
      provenance_complete: true
    },
    artifacts: [
      { role: "kpi", path: "kpi.json", contents: input.kpiContents },
      { role: "report", path: "report.md", contents: "report\n" },
      { role: "diagnostics", path: "longmemeval-diagnostics.json", contents: input.diagnosticsContents },
      { role: "full_diagnostics", path: "longmemeval-diagnostics.json.gz", contents: input.fullBytes },
      { role: "cohort_ledger", path: "longmemeval-cohort-ledger.json", contents: input.cohortContents },
      { role: "comparison", path: "longmemeval-cold-warm-comparison.json", contents: input.comparisonContents },
      { role: "run_provenance", path: "longmemeval-run-provenance.json", contents: input.provenanceContents }
    ]
  });
}

function selectionIdentity(questionIds: readonly string[]) {
  const assignments = questionIds.map((question_id) => ({
    question_id,
    dataset_cohort: "answerable" as const
  }));
  return {
    schema_version: 1 as const,
    dataset_sha256: DATASET_SHA,
    selected_id_digest: computeQuestionIdDigest(questionIds),
    selected_count: questionIds.length,
    expected_cohort_counts: { answerable: questionIds.length, abstention: 0 },
    cohort_assignment_digest: computeCohortAssignmentDigest(assignments)
  };
}

export async function archiveRoot(history: string): Promise<string> {
  const pointer = JSON.parse(await readFile(
    path.join(history, "public", "latest-run.json"), "utf8"
  )) as { slug: string };
  return path.join(history, "public", pointer.slug);
}

export async function rewriteShardManifest(
  shardRoot: string,
  updateRun: (manifest: LongMemEvalEvidenceManifest) => LongMemEvalEvidenceManifest["run"]
): Promise<void> {
  const manifestPath = path.join(
    shardRoot,
    "public",
    "2026-05-14T100000Z-abc1234",
    "longmemeval-evidence-manifest.json"
  );
  const current = JSON.parse(await readFile(manifestPath, "utf8")) as LongMemEvalEvidenceManifest;
  const rebuilt = buildLongMemEvalEvidenceManifest({
    run: updateRun(current),
    artifacts: current.artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.path,
      identity: { sha256: artifact.sha256, bytes: artifact.bytes }
    }))
  });
  await writeFile(manifestPath, renderLongMemEvalEvidenceManifest(rebuilt));
}
