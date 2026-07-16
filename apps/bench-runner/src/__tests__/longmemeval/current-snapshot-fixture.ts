import { computeQuestionIdDigest } from
  "../../longmemeval/selection/question-manifest.js";
import { computeCohortAssignmentDigest } from
  "../../longmemeval/selection/contract.js";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";
import type { LongMemEvalSnapshotManifest } from "../../longmemeval/snapshot.js";
import { makeShardProvenance } from "./runner-concurrency-fixture.js";
import {
  buildSnapshotExtractionAuthority,
  buildSnapshotExtractionSummary
} from "../../longmemeval/snapshot/extraction-authority.js";
import { compactSnapshotRunProvenance } from
  "../../longmemeval/snapshot/run-provenance.js";

export const currentCanonicalQuestions = [question("q-1"), question("q-99")];

export function currentSnapshotManifestFor(
  selectedId: string,
  integrity: NonNullable<LongMemEvalSnapshotManifest["artifact_integrity"]> = {
    db_sha256: "0".repeat(64),
    sidecar_sha256: "1".repeat(64),
    extraction_authority_filename: "snapshot.db.extraction-authority.json",
    extraction_authority_sha256: "2".repeat(64),
    extraction_authority_bytes: 1
  }
): LongMemEvalSnapshotManifest {
  const provenance = makeShardProvenance(0, 1);
  const assignment = [{ question_id: selectedId, dataset_cohort: "answerable" as const }];
  provenance.selection = {
    ...provenance.selection!,
    selected_id_digest: computeQuestionIdDigest([selectedId]),
    cohort_assignment_digest: computeCohortAssignmentDigest(assignment)
  };
  const extraction = currentSnapshotExtractionSummary();
  return {
    schema_version: 2,
    variant: "longmemeval_s",
    question_count: 1,
    recall_pipeline_version: "recall-eval-v1",
    schema_migration_version: 1,
    bench_runner_version: "test",
    alaya_commit: "abc1234",
    db_filename: "snapshot.db",
    sidecar_filename: "snapshot.db.sidecar.json",
    built_at: "2026-07-16T00:00:00.000Z",
    extraction_provenance: extraction,
    seed_extraction_path: cacheOnlySeedPath(),
    artifact_integrity: integrity,
    run_provenance: compactSnapshotRunProvenance(provenance),
    question_id_digest: provenance.selection.selected_id_digest,
    dataset_sha256: provenance.dataset_sha256,
    attribution: { status: "attributed", gate_eligible: true }
  };
}

export function currentSnapshotExtractionAuthority() {
  const { manifest, manifestSha256 } = currentExtractionManifest();
  return buildSnapshotExtractionAuthority(manifest, manifestSha256);
}

function currentSnapshotExtractionSummary() {
  const { manifest, manifestSha256 } = currentExtractionManifest();
  return buildSnapshotExtractionSummary(manifest, manifestSha256);
}

function currentExtractionManifest() {
  const cache = makeShardProvenance(0, 1).extraction_cache!;
  if (cache.schema_version !== 3) throw new Error("fixture requires v3 extraction");
  const { manifest_sha256: manifestSha256, ...manifest } = cache;
  return { manifest, manifestSha256 };
}

export function currentSnapshotSidecarFor(questionId: string) {
  const source = currentCanonicalQuestions.find(
    (candidate) => candidate.question_id === questionId
  )!;
  return {
    schema_version: 2,
    variant: "longmemeval_s",
    questions: [{
      questionId,
      question: source.question,
      questionDate: source.question_date,
      answerSessionIds: [],
      sidecar: [],
      seedRounds: [],
      workspaceId: `longmemeval-${questionId}`,
      runId: `longmemeval-${questionId}`
    }]
  };
}

function question(questionId: string): LongMemEvalQuestion {
  return {
    question_id: questionId,
    question_type: "single-session-user",
    question: `Question ${questionId}?`,
    answer: "answer",
    question_date: "2026-07-16T00:00:00.000Z",
    haystack_session_ids: [],
    haystack_dates: [],
    haystack_sessions: [],
    answer_session_ids: []
  };
}

function cacheOnlySeedPath() {
  return {
    path: "official_api_compile" as const,
    extraction_attempts: 1,
    cache_hits: 1,
    llm_calls: 0,
    offline_fallbacks: 0,
    live_extraction_failures: 0,
    cached_extraction_failures: 0,
    facts_produced: 1,
    signals_dropped: 0,
    parse_dropped: 0,
    compile_overflow_dropped: 0,
    signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
  };
}
