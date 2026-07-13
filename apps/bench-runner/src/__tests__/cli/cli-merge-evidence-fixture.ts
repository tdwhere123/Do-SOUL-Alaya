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
  writeShardRoot
} from "./cli-merge-validations-fixture.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION
} from "../../longmemeval/extraction-cache-manifest.js";

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
    cohort_ledger: cohort(),
    candidates
  };
}

export function candidate() {
  return {
    object_id: "gold-a",
    candidate_key: "workspace_local:memory_entry:gold-a",
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
    query_sought_facets: null,
    candidates: [],
    candidate_key_collisions: [],
    gold: []
  });
}

export function provenance(offset: number, count: number) {
  return {
    schema_version: 1,
    code: {
      commit_sha7: "abc1234",
      gate_sha256: "a".repeat(64),
      worktree_state_sha256: "b".repeat(64),
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "f".repeat(64),
        file_count: 3
      }
    },
    extraction_cache: {
      manifest_sha256: "c".repeat(64),
      schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
      extraction_model: "fixture-model",
      model_family: "fixture-model-family",
      request_profile: "provider-default-v1",
      provider_url: "redacted",
      system_prompt_sha256: "e".repeat(64),
      cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
      dataset: "longmemeval_s",
      dataset_revision: "fixture",
      requested_turns: count,
      cached_turns: count,
      coverage: 1,
      storage: "git-tracked",
      built_at: "2026-07-11T00:00:00.000Z",
      builder: "fixture"
    },
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
  const kpi = makeShardKpi({
    evaluated_count: 1,
    kpi: {
      ...makeShardKpi().kpi,
      r_at_5: 1,
      per_scenario: [{ id, version: 1, hit_at_5: true, tier: "warm" }]
    }
  });
  const diagnostics = makeShardDiagnostics({ questions: [question(id)] });
  const provenanceBody = provenance(offset, 1);
  await writeShardRoot(root, kpi, diagnostics);
  await writeProvenance(root, provenanceBody);
  await writeShardEvidence(root, kpi, diagnostics, provenanceBody);
}

async function writeShardEvidence(
  root: string,
  kpi: ReturnType<typeof makeShardKpi>,
  diagnostics: ReturnType<typeof makeShardDiagnostics>,
  provenanceBody: ReturnType<typeof provenance>
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
  const cohortContents = `${JSON.stringify({
    schema_version: 1,
    question_count: questionIds.length,
    question_id_digest: questionIdDigest,
    rows: questionIds.map((question_id) => ({ question_id, ...cohort() }))
  }, null, 2)}\n`;
  const comparisonContents = "{}\n";
  const fullBytes = gzipSync(diagnosticsContents);
  await writeFile(path.join(archive, "longmemeval-diagnostics.json.gz"), fullBytes);
  await writeFile(path.join(archive, "longmemeval-cohort-ledger.json"), cohortContents);
  await writeFile(path.join(archive, "longmemeval-cold-warm-comparison.json"), comparisonContents);
  const manifest = buildLongMemEvalEvidenceManifest({
    run: {
      slug,
      bench_name: "public",
      split: kpi.split,
      run_at: kpi.run_at,
      alaya_commit: kpi.alaya_commit,
      dataset_sha256: kpi.dataset.checksum_sha256 ?? "a".repeat(64),
      selection_manifest_sha256: null,
      question_id_digest: questionIdDigest,
      candidate_pool_complete: true,
      provenance_complete: true
    },
    artifacts: [
      { role: "kpi", path: "kpi.json", contents: kpiContents },
      { role: "report", path: "report.md", contents: "report\n" },
      { role: "diagnostics", path: "longmemeval-diagnostics.json", contents: diagnosticsContents },
      { role: "full_diagnostics", path: "longmemeval-diagnostics.json.gz", contents: fullBytes },
      { role: "cohort_ledger", path: "longmemeval-cohort-ledger.json", contents: cohortContents },
      { role: "comparison", path: "longmemeval-cold-warm-comparison.json", contents: comparisonContents },
      { role: "run_provenance", path: "longmemeval-run-provenance.json", contents: provenanceContents }
    ]
  });
  await writeFile(
    path.join(archive, "longmemeval-evidence-manifest.json"),
    renderLongMemEvalEvidenceManifest(manifest)
  );
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
