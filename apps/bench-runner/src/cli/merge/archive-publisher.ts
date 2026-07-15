import {
  isHistoryEntryCommittedError,
  writeEntry,
  type HistoryLayout,
  type KpiPayload,
  type VerifiedLongMemEvalEvidenceContext
} from "@do-soul/alaya-eval";
import path from "node:path";
import { LONGMEMEVAL_DIAGNOSTICS_FILENAME } from
  "../../longmemeval/archive-evidence.js";
import { withPublishedDiagnosticsArtifact } from
  "../../longmemeval/measurement/artifact-transaction.js";
import { resolveLongMemEvalEvidenceContext } from
  "../../longmemeval/history/evidence-context.js";

export async function publishMergedArchive(input: {
  readonly layout: HistoryLayout;
  readonly slug: string;
  readonly archive: {
    readonly merged: KpiPayload;
    readonly report: string;
    readonly findings: string | null;
    readonly sidecars: readonly { readonly filename: string; readonly contents: string }[];
    readonly diagnosticsArtifact: {
      readonly stagedPath: string;
      readonly finalPath: string;
    };
  };
}): Promise<{
  readonly kpiPath: string;
  readonly diagnosticsPath: string | null;
  readonly evidenceContext: VerifiedLongMemEvalEvidenceContext | null;
}> {
  const entry = await withPublishedDiagnosticsArtifact(
    input.archive.diagnosticsArtifact,
    () => writeEntry(
      input.layout,
      "public",
      input.slug,
      input.archive.merged,
      input.archive.report,
      input.archive.findings,
      {
        sidecars: input.archive.sidecars,
        fileSidecars: [{
          filename: `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`,
          sourcePath: input.archive.diagnosticsArtifact.finalPath
        }]
      }
    ),
    isHistoryEntryCommittedError
  );
  const evidenceContext = await resolveLongMemEvalEvidenceContext(
    input.layout,
    path.dirname(entry.kpiPath),
    input.archive.merged
  );
  return {
    kpiPath: entry.kpiPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    evidenceContext
  };
}
