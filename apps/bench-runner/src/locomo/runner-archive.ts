import {
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { writeExternalDiagnosticsArtifact } from "../longmemeval/diagnostics-artifacts.js";
import {
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  type LongMemEvalDiagnosticsSidecar
} from "../longmemeval/diagnostics.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport
} from "../longmemeval/seed-extraction-release-blocker.js";
import type { LocomoRunOptions, LocomoRunResult } from "./runner-types.js";

export async function writeLocomoRunArchive(input: {
  readonly opts: LocomoRunOptions;
  readonly runAt: Date;
  readonly commitSha7: string;
  readonly payload: KpiPayload;
  readonly diagnosticsPayload: LongMemEvalDiagnosticsSidecar;
}): Promise<LocomoRunResult> {
  const layout: HistoryLayout = { historyRoot: input.opts.historyRoot };
  const previous = await readLatest(layout, "public-locomo", {
    split: "locomo10",
    embeddingProvider: input.payload.embedding_provider,
    pointerKind: "passing"
  });
  const diff = diffKpis(input.payload, previous);
  input.payload.diff_vs_previous = buildDiffVsPrevious(
    input.payload,
    previous,
    previous?.run_at ?? ""
  );
  const slug = entrySlug(input.runAt, input.commitSha7);
  const report = appendSeedExtractionReleaseBlockerToReport(
    renderReport(input.payload, previous, diff),
    input.payload
  );
  const findings = appendSeedExtractionReleaseBlockerToFindings(
    renderFindings(input.payload, diff),
    input.payload
  );
  const diagnosticsSidecar = await writeLocomoDiagnosticsSidecar({
    opts: input.opts,
    slug,
    diagnosticsPayload: input.diagnosticsPayload
  });
  const entry = await writeEntry(
    layout,
    "public-locomo",
    slug,
    input.payload,
    report,
    findings,
    { sidecars: [diagnosticsSidecar] }
  );
  return buildLocomoRunResult(slug, entry, input.payload);
}

async function writeLocomoDiagnosticsSidecar(input: {
  readonly opts: LocomoRunOptions;
  readonly slug: string;
  readonly diagnosticsPayload: LongMemEvalDiagnosticsSidecar;
}): Promise<{ readonly filename: string; readonly contents: string }> {
  const diagnosticsArtifactPath = await writeExternalDiagnosticsArtifact({
    historyRoot: input.opts.historyRoot,
    benchName: "public-locomo",
    slug: input.slug,
    filename: "locomo-diagnostics.json",
    contents: renderDiagnosticsSidecar(input.diagnosticsPayload)
  });
  return {
    filename: "locomo-diagnostics.json",
    contents: renderCompactDiagnosticsSidecar(
      input.diagnosticsPayload,
      diagnosticsArtifactPath
    )
  };
}

function buildLocomoRunResult(
  slug: string,
  entry: Awaited<ReturnType<typeof writeEntry>>,
  payload: KpiPayload
): LocomoRunResult {
  const diagnosticsPath = entry.sidecarPaths["locomo-diagnostics.json"]!;
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath,
    payload
  };
}
