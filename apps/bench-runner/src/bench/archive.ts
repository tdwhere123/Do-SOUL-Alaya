import {
  buildDiffVsPrevious,
  diffKpis,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { writeExternalDiagnosticsArtifact } from "./diagnostics/artifacts/diagnostics-artifacts.js";
import {
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  type LongMemEvalDiagnosticsSidecar
} from "./diagnostics.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport
} from "./extraction/seed-fuel/seed-extraction-release-blocker.js";
import type { BenchCampaignIdentity, BenchRunResult } from "./types.js";
import {
  composeArchiveHistorySlug,
  resolveArchiveGitState,
  type ArchiveGitIdentityInput
} from "./provenance/identity/archive-git-identity.js";
import { assertMeasuredGitCommit } from "./provenance/identity/run-code-identity.js";

export async function writeBenchArchive(input: {
  readonly identity: BenchCampaignIdentity;
  readonly historyRoot: string;
  readonly runAt: Date;
  readonly commitSha7: string;
  readonly payload: KpiPayload;
  readonly diagnosticsPayload: LongMemEvalDiagnosticsSidecar;
} & ArchiveGitIdentityInput): Promise<BenchRunResult> {
  const layout: HistoryLayout = { historyRoot: input.historyRoot };
  const previous = await applyBaselineDiff(layout, input);
  // Generic bench archives have no run-provenance sidecar; git is measured once for the slug.
  const recorded = await resolveArchiveGitState(input);
  assertMeasuredGitCommit(input.commitSha7, recorded);
  const slug = composeArchiveHistorySlug({
    runAt: input.runAt,
    commitSha7: input.commitSha7,
    recorded
  });
  const documents = renderArchiveDocuments(input.payload, previous);
  const entry = await writeEntry(
    layout,
    input.identity.benchName,
    slug,
    input.payload,
    documents.report,
    documents.findings,
    {
      sidecars: [
        await writeDiagnosticsSidecar({
          identity: input.identity,
          historyRoot: input.historyRoot,
          slug,
          diagnosticsPayload: input.diagnosticsPayload
        })
      ]
    }
  );
  return buildArchiveResult(
    slug,
    entry,
    input.payload,
    input.identity.diagnosticsFilename
  );
}

async function applyBaselineDiff(
  layout: HistoryLayout,
  input: {
    readonly identity: BenchCampaignIdentity;
    readonly payload: KpiPayload;
  }
) {
  const previous = await readLatest(layout, input.identity.benchName, {
    split: input.identity.split,
    embeddingProvider: input.payload.embedding_provider,
    pointerKind: input.identity.baselinePointerKind ?? "passing"
  });
  input.payload.diff_vs_previous = buildDiffVsPrevious(
    input.payload,
    previous,
    previous?.run_at ?? ""
  );
  return previous;
}

function renderArchiveDocuments(
  payload: KpiPayload,
  previous: Awaited<ReturnType<typeof readLatest>>
) {
  const diff = diffKpis(payload, previous);
  return {
    report: appendSeedExtractionReleaseBlockerToReport(
      renderReport(payload, previous, diff),
      payload
    ),
    findings: appendSeedExtractionReleaseBlockerToFindings(
      renderFindings(payload, diff),
      payload
    )
  };
}

async function writeDiagnosticsSidecar(input: {
  readonly identity: BenchCampaignIdentity;
  readonly historyRoot: string;
  readonly slug: string;
  readonly diagnosticsPayload: LongMemEvalDiagnosticsSidecar;
}): Promise<{ readonly filename: string; readonly contents: string }> {
  const diagnosticsArtifactPath = await writeExternalDiagnosticsArtifact({
    historyRoot: input.historyRoot,
    benchName: input.identity.benchName,
    slug: input.slug,
    filename: input.identity.diagnosticsFilename,
    contents: renderDiagnosticsSidecar(input.diagnosticsPayload)
  });
  return {
    filename: input.identity.diagnosticsFilename,
    contents: renderCompactDiagnosticsSidecar(
      input.diagnosticsPayload,
      diagnosticsArtifactPath
    )
  };
}

function buildArchiveResult(
  slug: string,
  entry: Awaited<ReturnType<typeof writeEntry>>,
  payload: KpiPayload,
  diagnosticsFilename: string
): BenchRunResult {
  const diagnosticsPath = entry.sidecarPaths[diagnosticsFilename]!;
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath,
    payload
  };
}
