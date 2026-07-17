import type { KpiPayload } from "@do-soul/alaya-eval";
import {
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME
} from "../../archive/archive-evidence.js";
import { LONGMEMEVAL_COHORT_LEDGER_FILENAME } from "../../selection/cohort-ledger.js";
import type { LongMemEvalDiagnosticsSidecar } from "../../diagnostics.js";
import {
  buildLongMemEvalEvidenceManifest,
  LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
  renderLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceArtifactInput
} from "../evidence-manifest.js";
import type { LongMemEvalSelectionContractIdentity } from "../../selection/contract.js";
import { LongMemEvalRunProvenanceSchema } from "../run.js";
import type { LongMemEvalRunProvenance } from "../run.js";

export interface ArchiveEvidenceSidecarInput {
  readonly slug: string;
  readonly payload: KpiPayload;
  readonly failedQuestionIds: readonly string[];
  readonly diagnostics: {
    readonly compact: string;
    readonly fullArtifactIdentity: { readonly bytes: number; readonly sha256: string };
    readonly persistedPayload: LongMemEvalDiagnosticsSidecar;
  };
  readonly comparison: string;
  readonly runProvenanceSidecar: { readonly filename: string; readonly contents: string };
  readonly boundRunProvenance?: LongMemEvalRunProvenance;
  readonly authorityReferenceSidecar?: {
    readonly filename: string;
    readonly contents: string;
  } | null;
  readonly report: string;
  readonly findings: string | null;
  readonly cohortLedger: string;
}

export function buildArchiveEvidenceManifestSidecar(
  input: ArchiveEvidenceSidecarInput
) {
  const provenance = input.boundRunProvenance ??
    LongMemEvalRunProvenanceSchema.parse(
      JSON.parse(input.runProvenanceSidecar.contents)
    );
  const cohortIdentity = JSON.parse(input.cohortLedger) as {
    readonly question_id_digest: string;
    readonly selection_contract?: LongMemEvalSelectionContractIdentity;
  };
  const datasetSha = input.payload.dataset.checksum_sha256;
  if (datasetSha === undefined) {
    throw new Error("LongMemEval evidence manifest requires dataset.checksum_sha256");
  }
  const selection = provenance.selection;
  if (datasetSha !== provenance.dataset_sha256 || selection === undefined ||
      cohortIdentity.question_id_digest !== selection.selected_id_digest ||
      JSON.stringify(cohortIdentity.selection_contract) !== JSON.stringify(selection)) {
    throw new Error("LongMemEval evidence identity differs across KPI, provenance, and cohort ledger");
  }
  const questions = input.diagnostics.persistedPayload.questions;
  const manifest = buildLongMemEvalEvidenceManifest({
    run: {
      slug: input.slug,
      bench_name: input.payload.bench_name,
      split: input.payload.split,
      run_at: input.payload.run_at,
      alaya_commit: input.payload.alaya_commit,
      dataset_sha256: datasetSha,
      selection_manifest_sha256: provenance.question_manifest?.file_sha256 ?? null,
      question_id_digest: cohortIdentity.question_id_digest,
      selection_contract: selection,
      candidate_pool_complete: input.failedQuestionIds.length === 0 &&
        questions.every((row) => row.candidate_pool_complete),
      provenance_complete:
        input.payload.measurement_attribution?.provenance_complete === true
    },
    artifacts: buildEvidenceArtifacts(input)
  });
  return {
    filename: LONGMEMEVAL_EVIDENCE_MANIFEST_FILENAME,
    contents: renderLongMemEvalEvidenceManifest(manifest)
  };
}

function buildEvidenceArtifacts(
  input: ArchiveEvidenceSidecarInput
): LongMemEvalEvidenceArtifactInput[] {
  return [
    { role: "kpi", path: "kpi.json", contents: `${JSON.stringify(input.payload, null, 2)}\n` },
    { role: "report", path: "report.md", contents: input.report },
    ...(input.findings === null
      ? []
      : [{ role: "findings" as const, path: "findings.md", contents: input.findings }]),
    { role: "diagnostics", path: LONGMEMEVAL_DIAGNOSTICS_FILENAME, contents: input.diagnostics.compact },
    {
      role: "full_diagnostics",
      path: `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`,
      identity: input.diagnostics.fullArtifactIdentity
    },
    { role: "cohort_ledger", path: LONGMEMEVAL_COHORT_LEDGER_FILENAME, contents: input.cohortLedger },
    { role: "comparison", path: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME, contents: input.comparison },
    { role: "run_provenance", path: input.runProvenanceSidecar.filename, contents: input.runProvenanceSidecar.contents },
    ...(input.authorityReferenceSidecar === undefined ||
      input.authorityReferenceSidecar === null
      ? []
      : [{
          role: "extraction_authority_ref" as const,
          path: input.authorityReferenceSidecar.filename,
          contents: input.authorityReferenceSidecar.contents
        }])
  ];
}
