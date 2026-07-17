import type { LongMemEvalReleaseEvidenceAuthority } from
  "@do-soul/alaya-eval/internal";
import type { BenchRecallWeightOverrides } from
  "../../harness/recall/recall-weight-overrides.js";
import { resolveBenchRunnerVersion } from "../../shared/version.js";
import {
  createCompileSeedRunner,
  EXTRACTION_CACHE_ROOT
} from "../compile-seed.js";
import type { LongMemEvalDiagnosticsSpool } from "../diagnostics/spool.js";
import { collectDistinctTurnContents } from "../extraction/extraction-fill.js";
import {
  deriveLongMemEvalReleaseEvidenceAuthority,
  loadDatasetWithIdentity
} from "../ingestion/fetch.js";
import {
  createOwnedTempRoot,
  externalTempRoot
} from "../lifecycle/owned-temp-root.js";
import {
  recallOptionsForPolicyShape,
  resolveBenchEmbeddingProviderLabel,
  resolveCommitInfo
} from "./runner-helpers.js";
import type { LongMemEvalRunOptions } from "../runner.js";
import { loadQuestionManifestSelection } from
  "../selection/question-manifest.js";
import {
  createLongMemEvalSelectionContract,
  type LongMemEvalSelectionContract
} from "../selection/contract.js";

type LoadedLongMemEvalDataset = Awaited<ReturnType<typeof loadDatasetWithIdentity>>;
type LongMemEvalQuestions = LoadedLongMemEvalDataset["questions"];
type LongMemEvalQuestion = LongMemEvalQuestions[number];

export interface LongMemEvalRunContext {
  readonly opts: LongMemEvalRunOptions;
  readonly questions: LongMemEvalQuestions;
  readonly window: readonly LongMemEvalQuestion[];
  readonly datasetSha256: string;
  readonly datasetChecksumSource: string;
  readonly datasetSourcePath: string;
  readonly releaseEvidenceAuthority: LongMemEvalReleaseEvidenceAuthority | null;
  readonly selectionContract: LongMemEvalSelectionContract;
  readonly alayaVersion: string;
  readonly commitInfo: ReturnType<typeof resolveCommitInfo>;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly embeddingProviderLabel: string;
  readonly policyShape: NonNullable<LongMemEvalRunOptions["policyShape"]>;
  readonly simulateReport: NonNullable<LongMemEvalRunOptions["simulateReport"]>;
  readonly recallOptions: ReturnType<typeof recallOptionsForPolicyShape>;
  readonly seedRunner: ReturnType<typeof createCompileSeedRunner>;
  readonly captureSnapshot: boolean;
  readonly extractionCacheRoot: string;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
  readonly seedDataDirRoot?: string;
  readonly removeSeedDataDirRoot: boolean;
  readonly diagnosticsSpool: LongMemEvalDiagnosticsSpool;
}

export async function prepareLongMemEvalRun(
  opts: LongMemEvalRunOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined,
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<LongMemEvalRunContext> {
  const dataset = await loadDatasetWithIdentity(opts.variant, datasetLoadOptions(opts));
  const questions = dataset.questions;
  const selectedQuestions = await selectManifestQuestions(opts, dataset);
  const window = selectQuestionWindow(selectedQuestions, opts);
  const commitInfo = resolveCommitInfo();
  const extractionCacheRoot = opts.extractionCacheRoot ?? EXTRACTION_CACHE_ROOT;
  return {
    opts,
    questions,
    window,
    datasetSha256: dataset.sha256,
    datasetChecksumSource: dataset.checksumSource,
    datasetSourcePath: dataset.sourcePath,
    releaseEvidenceAuthority: deriveRunEvidenceAuthority(dataset, opts, window),
    selectionContract: createLongMemEvalSelectionContract({
      datasetSha256: dataset.sha256,
      questions: window
    }),
    alayaVersion: resolveBenchRunnerVersion(),
    commitInfo,
    commitSha7: commitInfo.sha7,
    runAt: new Date(),
    embeddingProviderLabel: resolveBenchEmbeddingProviderLabel(
      opts.embeddingMode ?? "disabled",
      process.env,
      opts.embeddingProviderKind
    ),
    policyShape: opts.policyShape ?? "stress",
    simulateReport: opts.simulateReport ?? "none",
    recallOptions: recallOptionsForPolicyShape(opts.policyShape ?? "stress"),
    seedRunner: createLongMemEvalSeedRunner(
      window,
      extractionCacheRoot,
      Math.max(0, opts.offset ?? 0)
    ),
    captureSnapshot: opts.snapshotOut !== undefined,
    extractionCacheRoot,
    recallWeightOverrides,
    diagnosticsSpool,
    ...(await resolveSeedDataDirRoot(opts))
  };
}

function deriveRunEvidenceAuthority(
  dataset: LoadedLongMemEvalDataset,
  opts: LongMemEvalRunOptions,
  window: readonly LongMemEvalQuestion[]
): LongMemEvalReleaseEvidenceAuthority | null {
  const offset = Math.max(0, opts.offset ?? 0);
  if (opts.questionManifest !== undefined || offset !== 0) return null;
  return deriveLongMemEvalReleaseEvidenceAuthority(dataset.promotionAuthority, {
    kind: "execution_window",
    offset,
    limit: window.length
  });
}

function datasetLoadOptions(opts: LongMemEvalRunOptions) {
  return { dataDir: opts.dataDir, pinnedMetaRoot: opts.pinnedMetaRoot };
}

async function selectManifestQuestions(
  opts: LongMemEvalRunOptions,
  dataset: LoadedLongMemEvalDataset
): Promise<LongMemEvalQuestions> {
  if (opts.questionManifest === undefined) return dataset.questions;
  return loadQuestionManifestSelection({
    manifestPath: opts.questionManifest,
    questions: dataset.questions,
    variant: opts.variant,
    datasetSha256: dataset.sha256
  });
}

function selectQuestionWindow(
  questions: LongMemEvalQuestions,
  opts: LongMemEvalRunOptions
) {
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd = opts.limit !== undefined ? offset + opts.limit : questions.length;
  return questions.slice(offset, sliceEnd);
}

function createLongMemEvalSeedRunner(
  window: readonly LongMemEvalQuestion[],
  extractionCacheRoot: string,
  offset: number
) {
  const requiredTurnContents = collectDistinctTurnContents(window);
  return createCompileSeedRunner({
    requiredTurnContents,
    requiredQuestionWindow: { offset, limit: window.length },
    cacheRoot: extractionCacheRoot,
    allowLiveExtraction: false
  });
}

async function resolveSeedDataDirRoot(
  opts: LongMemEvalRunOptions
): Promise<{
  readonly seedDataDirRoot?: string;
  readonly removeSeedDataDirRoot: boolean;
}> {
  if (opts.dataDirRoot !== undefined) {
    const root = externalTempRoot(opts.dataDirRoot);
    return { seedDataDirRoot: root.path, removeSeedDataDirRoot: root.owned };
  }
  const root = await createOwnedTempRoot("alaya-bench-seed-");
  return {
    seedDataDirRoot: root.path,
    removeSeedDataDirRoot: root.owned
  };
}
