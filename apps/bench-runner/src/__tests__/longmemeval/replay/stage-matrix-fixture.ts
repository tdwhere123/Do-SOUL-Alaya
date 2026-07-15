import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
export const HASH = /^[a-f0-9]{64}$/u;
export const execFileAsync = promisify(execFile);
export const cliPath = path.resolve(
  __dirname,
  "../../../../scripts/analyze-longmemeval-stage-matrix.mjs"
);

export function candidate(objectId: string, ranks: Record<string, number | null>) {
  return {
    object_id: objectId,
    fused_rank: ranks.fused_rank ?? null,
    rank_after_fusion: ranks.rank_after_fusion ?? null,
    rank_after_feature_rerank: ranks.feature ?? null,
    rank_after_lexical_priority: ranks.lexical ?? null,
    rank_after_coverage_selector: ranks.coverage ?? null,
    rank_after_session_coverage: ranks.session ?? null,
    rank_after_synthesis_reserve: ranks.synthesis ?? null,
    rank_after_structural_reserve: ranks.structural ?? null,
    selection_order: ranks.selection_order ?? null,
    final_rank: ranks.final_rank ?? null,
    fused_score: objectId.startsWith("gold") ? 0.4 : 0.5,
    score_factors: { facet_overlap: objectId.startsWith("gold") ? 2 : 1 }
  };
}

export function cohortRow(input: {
  id: string;
  goldIds: readonly string[];
  datasetCohort?: "answerable" | "abstention";
  status?: "present" | "absent" | "ambiguous";
  retrieval?: "hit_at_5" | "miss_at_5";
  issue?: string | null;
  measurementStatus?: "scorable" | "abstention_unscorable" | "evaluator_identity_unscorable";
  qualityAxes?: ReturnType<typeof qualityAxes>;
}) {
  const evaluatorStatus = input.status ?? "present";
  return {
    question_id: input.id,
    dataset_cohort: input.datasetCohort ?? "answerable",
    extraction_materialization: {
      status: evaluatorStatus === "present" ? "memory_emitted" : "unknown",
      emitted_memory_count: evaluatorStatus === "present" ? input.goldIds.length : 0,
      reason: null
    },
    evaluator_gold_identity: {
      status: evaluatorStatus,
      object_ids: input.goldIds
    },
    retrieval_status: input.retrieval ?? "miss_at_5",
    evidence_status: "complete",
    evaluation_issue_reason: input.issue ?? null,
    measurement_status: input.measurementStatus ??
      (input.datasetCohort === "abstention"
        ? "abstention_unscorable"
        : evaluatorStatus === "absent" || evaluatorStatus === "ambiguous" || input.issue != null
          ? "evaluator_identity_unscorable"
          : "scorable"),
    candidate_pool_complete: true,
    ...(input.qualityAxes === undefined ? {} : { quality_axes: input.qualityAxes }),
    stage_ranks: [],
    final_verdict: input.retrieval === "hit_at_5" ? "hit_at_5" : "miss_at_5"
  };
}

export function question(id: string, candidates: readonly unknown[], row: ReturnType<typeof cohortRow>) {
  return {
    question_id: id,
    question_type: "single-session-user",
    phase_latency_ms: { recall: 12 },
    candidate_pool_complete: true,
    ...(row.quality_axes === undefined ? {} : { quality_axes: row.quality_axes }),
    cohort_ledger: Object.fromEntries(Object.entries(row).filter(([key]) => key !== "question_id")),
    candidates
  };
}

export function qualityAxes(input: {
  coverage?: readonly [number, number];
  literalWitnessed?: boolean;
  timestamps?: readonly [number, number];
  abstention?: "not_applicable" | "correct" | "false_confident" | "uncalibrated";
} = {}) {
  const [covered, total] = input.coverage ?? [1, 2];
  const [available, candidates] = input.timestamps ?? [2, 5];
  const abstention = input.abstention ?? "not_applicable";
  return {
    answer_session_coverage_at_5: {
      applicable: abstention === "not_applicable",
      covered_count: covered,
      total_count: total,
      ratio: total === 0 ? null : covered / total,
      full_coverage: total > 0 && covered === total
    },
    answer_literal_witness_lower_bound_at_5: {
      applicable: abstention === "not_applicable",
      inspected_candidate_count: candidates,
      matched_candidate_count: input.literalWitnessed === false ? 0 : 1,
      witnessed: input.literalWitnessed !== false,
      witnesses: input.literalWitnessed === false ? [] : [{
        object_id: "witness",
        object_kind: "memory_entry",
        rank: 1,
        field: "content"
      }]
    },
    source_timestamp_availability_at_5: {
      source: "dataset_session_timestamp_join",
      candidate_count: candidates,
      available_count: available,
      ratio: candidates === 0 ? null : available / candidates,
      all_available: candidates > 0 && available === candidates
    },
    abstention: {
      applicable: abstention !== "not_applicable",
      status: abstention
    }
  };
}

export function contract(questions: readonly unknown[], rows: readonly ReturnType<typeof cohortRow>[]) {
  return {
    manifest: { run: { slug: "run-1" } },
    diagnostics: { schema_version: 1, questions },
    cohort: { schema_version: 1, question_count: rows.length, rows }
  };
}

export async function writeBundle(
  input: ReturnType<typeof contract>,
  complete = true,
  gzipDiagnostics = false
) {
  const root = await mkdtemp(path.join(tmpdir(), "alaya-stage-matrix-"));
  const diagnostics = `${JSON.stringify(input.diagnostics, null, 2)}\n`;
  const ids = input.cohort.rows.map((row) => row.question_id);
  const digest = sha(ids.join("\0"));
  const cohort = `${JSON.stringify({ ...input.cohort, question_id_digest: digest }, null, 2)}\n`;
  const diagnosticsContents = gzipDiagnostics
    ? gzipSync(Buffer.from(diagnostics, "utf8"))
    : diagnostics;
  const diagnosticsPath = gzipDiagnostics ? "full.json.gz" : "full.json";
  const artifacts = [
    artifact("full_diagnostics", diagnosticsPath, diagnosticsContents),
    artifact("cohort_ledger", "cohort.json", cohort)
  ];
  const unsigned = {
    schema_version: 1,
    kind: "longmemeval_evidence_bundle",
    run: {
      slug: "run-1",
      question_id_digest: digest,
      candidate_pool_complete: complete
    },
    evidence_status: complete ? "complete" : "partial",
    artifacts: artifacts.map(({ contents: _contents, ...entry }) => entry)
  };
  const manifest = { ...unsigned, bundle_sha256: sha(JSON.stringify(unsigned)) };
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(path.join(root, diagnosticsPath), diagnosticsContents),
    writeFile(path.join(root, "cohort.json"), cohort),
    writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  ]);
  return { root, manifestPath: path.join(root, "manifest.json") };
}

function artifact(role: string, artifactPath: string, contents: string | Uint8Array) {
  return {
    role,
    path: artifactPath,
    sha256: sha(contents),
    bytes: Buffer.byteLength(contents),
    contents
  };
}

export function sha(contents: string | Uint8Array) {
  return createHash("sha256").update(contents).digest("hex");
}
