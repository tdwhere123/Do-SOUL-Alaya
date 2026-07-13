import type { KpiPayload } from "@do-soul/alaya-eval";
import {
  buildLongMemEvalEvidenceManifest,
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  renderLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceArtifactInput
} from "../evidence-manifest.js";
import type { RecallEvalQuestionResult } from "../lifecycle/recall-eval-contract.js";
import type { RecallEvalRuntimeAttribution } from "../lifecycle/recall-eval-runtime.js";
import type { LongMemEvalSnapshotManifest } from "../snapshot.js";
import { snapshotQuestionIdDigest } from "../snapshot.js";
import {
  buildRecallEvalDiagnosticsEvidence,
  RECALL_EVAL_DIAGNOSTICS_FILENAME,
  renderRecallEvalDiagnosticsEvidence
} from "./recall-eval-diagnostics.js";
import {
  RECALL_EVAL_RANK_IDENTITY_FILENAME,
  renderRecallEvalRankIdentity
} from "./recall-eval-rank-identity.js";
import {
  LONGMEMEVAL_RUN_PROVENANCE_FILENAME,
  renderLongMemEvalRunProvenance,
  type LongMemEvalRunProvenance
} from "./run.js";

export function buildRecallEvalArchiveBundle(input: {
  readonly slug: string;
  readonly payload: KpiPayload;
  readonly report: string;
  readonly findings: string | null;
  readonly collected: readonly RecallEvalQuestionResult[];
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly runtimeAttribution: RecallEvalRuntimeAttribution;
  readonly offset: number;
  readonly limit: number | null;
  readonly runProvenance: LongMemEvalRunProvenance;
  readonly expectedQuestionIdDigest: string;
  readonly provenanceComplete: boolean;
}): readonly { readonly filename: string; readonly contents: string }[] {
  const rankIdentity = renderRankIdentity(input);
  const runProvenance = renderRunProvenance(input);
  const diagnostics = renderRecallEvalDiagnosticsEvidence(
    buildRecallEvalDiagnosticsEvidence({
      questions: input.collected,
      embeddingSupplement: input.runtimeAttribution.embedding_supplement,
      answerRerank: input.runtimeAttribution.answer_rerank
    })
  );
  const artifacts = buildArtifactInputs(input, rankIdentity, runProvenance, diagnostics);
  const evidence = buildLongMemEvalEvidenceManifest({
    profile: "recall_eval",
    run: buildRunBinding(input),
    artifacts
  });
  return [
    { filename: RECALL_EVAL_RANK_IDENTITY_FILENAME, contents: rankIdentity },
    { filename: LONGMEMEVAL_RUN_PROVENANCE_FILENAME, contents: runProvenance },
    { filename: RECALL_EVAL_DIAGNOSTICS_FILENAME, contents: diagnostics },
    {
      filename: LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
      contents: renderLongMemEvalEvidenceManifest(evidence)
    }
  ];
}

function renderRankIdentity(
  input: Parameters<typeof buildRecallEvalArchiveBundle>[0]
): string {
  return renderRecallEvalRankIdentity(input.collected, {
    expectedQuestionCount: input.manifest.question_count,
    expectedQuestionIdDigest: input.manifest.question_id_digest ?? null,
    requireFullSnapshotMatch:
      input.manifest.attribution?.status === "attributed" &&
      input.offset === 0 && input.limit === null
  });
}

function renderRunProvenance(
  input: Parameters<typeof buildRecallEvalArchiveBundle>[0]
): string {
  return renderLongMemEvalRunProvenance(input.runProvenance);
}

function buildArtifactInputs(
  input: Parameters<typeof buildRecallEvalArchiveBundle>[0],
  rankIdentity: string,
  runProvenance: string,
  diagnostics: string
): readonly LongMemEvalEvidenceArtifactInput[] {
  return [
    { role: "kpi", path: "kpi.json", contents: `${JSON.stringify(input.payload, null, 2)}\n` },
    { role: "report", path: "report.md", contents: input.report },
    ...(input.findings === null ? [] : [
      { role: "findings" as const, path: "findings.md", contents: input.findings }
    ]),
    { role: "rank_identity", path: RECALL_EVAL_RANK_IDENTITY_FILENAME, contents: rankIdentity },
    { role: "run_provenance", path: LONGMEMEVAL_RUN_PROVENANCE_FILENAME, contents: runProvenance },
    { role: "recall_eval_diagnostics", path: RECALL_EVAL_DIAGNOSTICS_FILENAME, contents: diagnostics }
  ];
}

function buildRunBinding(
  input: Parameters<typeof buildRecallEvalArchiveBundle>[0]
) {
  const datasetSha = input.payload.dataset.checksum_sha256;
  if (datasetSha === undefined || !/^[a-f0-9]{64}$/u.test(datasetSha)) {
    throw new Error("recall-eval evidence requires a bound dataset SHA-256");
  }
  const questionIdDigest = snapshotQuestionIdDigest(input.collected);
  if (questionIdDigest !== input.expectedQuestionIdDigest) {
    throw new Error("recall-eval evidence question slice drift");
  }
  return {
    slug: input.slug,
    bench_name: input.payload.bench_name,
    split: input.payload.split,
    run_at: input.payload.run_at,
    alaya_commit: input.payload.alaya_commit,
    dataset_sha256: datasetSha,
    selection_manifest_sha256: null,
    question_id_digest: questionIdDigest,
    candidate_pool_complete: input.collected.length === input.payload.evaluated_count &&
      input.collected.every((question) => question.diagnostics.candidate_pool_complete),
    provenance_complete: input.provenanceComplete
  };
}
