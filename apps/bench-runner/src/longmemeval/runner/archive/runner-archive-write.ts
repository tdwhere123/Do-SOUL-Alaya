import {
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  writeEntry,
  isHistoryEntryCommittedError,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import path from "node:path";
import {
  LONGMEMEVAL_DIAGNOSTICS_FILENAME
} from "../../../bench/archive/archive-evidence.js";
import { selectFullRunBaseline } from "../../../bench/lifecycle/recall-eval/recall-eval-archive-impl.js";
import type { BenchCommitInfo } from "../runner-helpers.js";
import type { LongMemEvalRunOptions, LongMemEvalRunResult } from "../../runner.js";
import type { LongMemEvalRunArchiveAggregate } from "./runner-archive-aggregate.js";
import type { LongMemEvalPayloadBuild } from "./runner-archive-payload.js";
import {
  composeArchiveHistorySlug,
  resolveArchiveGitState,
  type ArchiveGitIdentityInput
} from "../../../bench/provenance/identity/archive-git-identity.js";
import { assertMeasuredGitCommit } from
  "../../../bench/provenance/identity/run-code-identity.js";
import {
  withPublishedDiagnosticsArtifact
} from "../../../bench/measurement/artifact-transaction.js";
import type { LongMemEvalSelectionContract } from "../../../bench/selection/contract.js";
import {
  createLongMemEvalHistoryLayout,
  resolveLongMemEvalEvidenceContext
} from "../../history/evidence-context.js";
import type { EffectiveReconciliationBasis } from "@do-soul/alaya";
import type { LongMemEvalReleaseEvidenceAuthority } from
  "@do-soul/alaya-eval/authority";
import type { LongMemEvalDiagnosticsSpool } from "../../../bench/diagnostics/spool.js";
import {
  buildLongMemEvalArchiveSidecars,
  type ArchiveSidecarBuildResult
} from "./runner-archive-sidecars.js";

export async function writeLongMemEvalRunArchive(input: {
  readonly opts: LongMemEvalRunOptions;
  readonly datasetSha256: string;
  readonly datasetSourcePath: string;
  readonly datasetChecksumSource: string;
  readonly releaseEvidenceAuthority: LongMemEvalReleaseEvidenceAuthority | null;
  readonly selectionContract: LongMemEvalSelectionContract;
  readonly aggregate: LongMemEvalRunArchiveAggregate;
  readonly build: LongMemEvalPayloadBuild;
  readonly commitInfo: BenchCommitInfo;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly questionFailures: number;
  readonly failedQuestionIds: readonly string[];
  readonly reconciliationBasis?: EffectiveReconciliationBasis;
  readonly collectedLength: number;
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
} & ArchiveGitIdentityInput): Promise<LongMemEvalRunResult> {
  const layout = createLongMemEvalHistoryLayout({
    historyRoot: input.opts.historyRoot,
    authority: input.releaseEvidenceAuthority
  });
  const payload = await withLongMemEvalDiff(layout, input.build.payload);
  const recorded = await resolveArchiveGitState(input);
  assertMeasuredGitCommit(input.commitSha7, recorded);
  const slug = composeArchiveHistorySlug({
    runAt: input.runAt,
    commitSha7: input.commitSha7,
    policyDiscriminator: benchArchiveDiscriminator(payload.policy_shape, payload.simulate_report),
    recorded
  });
  const sidecars = await buildLongMemEvalArchiveSidecars({
    ...input, payload, layout, slug, recordedGitState: recorded
  });
  const entry = await publishLongMemEvalArchiveEntry(layout, slug, sidecars);
  const evidenceContext = await resolveLongMemEvalEvidenceContext(
    layout,
    path.dirname(entry.kpiPath),
    sidecars.payload
  );
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    payload: sidecars.payload,
    evidenceContext
  };
}

async function publishLongMemEvalArchiveEntry(
  layout: HistoryLayout,
  slug: string,
  sidecars: ArchiveSidecarBuildResult
) {
  return withPublishedDiagnosticsArtifact(
    sidecars.diagnosticsArtifact,
    () => writeEntry(
      layout,
      "public",
      slug,
      sidecars.payload,
      sidecars.report,
      sidecars.findings,
      {
        sidecars: sidecars.sidecars,
        fileSidecars: [{
          filename: `${LONGMEMEVAL_DIAGNOSTICS_FILENAME}.gz`,
          sourcePath: sidecars.diagnosticsArtifact.finalPath
        }]
      }
    ),
    isHistoryEntryCommittedError
  );
}

async function withLongMemEvalDiff(
  layout: HistoryLayout,
  payload: KpiPayload
): Promise<KpiPayload> {
  const previous = await selectFullRunBaseline(layout, "public", {
    split: payload.split,
    policyShape: payload.policy_shape,
    simulateReport: payload.simulate_report,
    embeddingProvider: payload.embedding_provider
  });
  return {
    ...payload,
    diff_vs_previous: buildDiffVsPrevious(payload, previous, previous?.run_at ?? "")
  };
}
