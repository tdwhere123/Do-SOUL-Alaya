import type { KpiPayload } from "@do-soul/alaya-eval";
import {
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME
} from "../../longmemeval/archive-evidence.js";
import { LONGMEMEVAL_COHORT_LEDGER_FILENAME } from
  "../../longmemeval/cohort-ledger.js";
import {
  buildLongMemEvalEvidenceManifest,
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  renderLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceArtifactInput
} from "../../longmemeval/evidence-manifest.js";
import type { MergedRunProvenanceSidecars } from
  "../../longmemeval/provenance/shard-aggregate.js";
import { selectionContractIdentity } from
  "../../longmemeval/selection/contract.js";

export interface MergedEvidenceManifestInput {
  readonly slug: string;
  readonly merged: KpiPayload;
  readonly diagnostics: {
    readonly contents: string;
    readonly fullArtifactIdentity: { readonly bytes: number; readonly sha256: string };
    readonly failedQuestionIds: readonly string[];
    readonly questions: readonly { readonly candidate_pool_complete: boolean }[];
  };
  readonly comparison: string;
  readonly cohort: string;
  readonly provenance: MergedRunProvenanceSidecars;
  readonly provenanceComplete: boolean;
  readonly report: string;
  readonly findings: string | null;
}

export function buildMergedEvidenceManifest(input: MergedEvidenceManifestInput) {
  const datasetSha = input.merged.dataset.checksum_sha256;
  if (datasetSha === undefined) {
    throw new Error("LongMemEval evidence manifest requires dataset.checksum_sha256");
  }
  const cohort = parseCohortIdentity(input.cohort);
  const candidatePoolsComplete = input.diagnostics.failedQuestionIds.length === 0 &&
    input.diagnostics.questions.length === input.merged.evaluated_count &&
    input.diagnostics.questions.every((question) => question.candidate_pool_complete);
  const selection = input.provenance.selectionContract === null
    ? undefined
    : selectionContractIdentity(input.provenance.selectionContract);
  assertSelectionIdentity(input.merged, cohort.selection_contract, selection);
  const manifest = buildLongMemEvalEvidenceManifest({
    run: {
      slug: input.slug,
      bench_name: "public",
      split: input.merged.split,
      run_at: input.merged.run_at,
      alaya_commit: input.merged.alaya_commit,
      dataset_sha256: datasetSha,
      selection_manifest_sha256: input.provenance.selectionManifestSha256,
      question_id_digest: cohort.question_id_digest,
      ...(selection === undefined ? {} : { selection_contract: selection }),
      candidate_pool_complete: candidatePoolsComplete,
      provenance_complete: input.provenanceComplete
    },
    artifacts: buildMergedEvidenceArtifacts(input)
  });
  return {
    filename: LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
    contents: renderLongMemEvalEvidenceManifest(manifest)
  };
}

function buildMergedEvidenceArtifacts(
  input: MergedEvidenceManifestInput
): LongMemEvalEvidenceArtifactInput[] {
  const artifacts: LongMemEvalEvidenceArtifactInput[] = [
    { role: "kpi", path: "kpi.json", contents: `${JSON.stringify(input.merged, null, 2)}\n` },
    { role: "report", path: "report.md", contents: input.report },
    { role: "diagnostics", path: LONGMEMEVAL_DIAGNOSTICS_FILENAME, contents: input.diagnostics.contents },
    { role: "full_diagnostics", path: `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`, identity: input.diagnostics.fullArtifactIdentity },
    { role: "cohort_ledger", path: LONGMEMEVAL_COHORT_LEDGER_FILENAME, contents: input.cohort },
    { role: "comparison", path: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME, contents: input.comparison },
    ...input.provenance.artifacts
  ];
  if (input.findings !== null) {
    artifacts.splice(2, 0, {
      role: "findings",
      path: "findings.md",
      contents: input.findings
    });
  }
  return artifacts;
}

function assertSelectionIdentity(
  merged: KpiPayload,
  cohortSelection: KpiPayload["selection_contract"],
  selection: KpiPayload["selection_contract"]
): void {
  if (JSON.stringify(cohortSelection) !== JSON.stringify(selection) ||
      JSON.stringify(merged.selection_contract) !== JSON.stringify(selection)) {
    throw new Error("merged evidence selection differs across KPI, cohort, and provenance");
  }
}

function parseCohortIdentity(contents: string): {
  readonly question_id_digest: string;
  readonly selection_contract?: KpiPayload["selection_contract"];
} {
  return JSON.parse(contents) as {
    readonly question_id_digest: string;
    readonly selection_contract?: KpiPayload["selection_contract"];
  };
}
