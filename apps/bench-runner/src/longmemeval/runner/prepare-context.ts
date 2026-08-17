import type { LongMemEvalReleaseEvidenceAuthority } from
  "@do-soul/alaya-eval/internal";
import { selectOffsetLimitWindow } from "../../bench/window.js";
import type { BenchRecallWeightOverrides } from
  "../../harness/recall/recall-weight-overrides.js";
import { resolveBenchRunnerVersion } from "../../shared/version.js";
import {
  createCompileSeedRunner,
  EXTRACTION_CACHE_ROOT
} from "../../bench/compile-seed.js";
import type { LongMemEvalDiagnosticsSpool } from "../../bench/diagnostics/spool.js";
import { inspectTurnContentKeySpace } from "../../bench/extraction/turn-contents.js";
import {
  loadDatasetWindowWithIdentity,
  loadDatasetWithIdentity
} from "../ingestion/fetch.js";
import {
  createOwnedTempRoot,
  externalTempRoot
} from "../../bench/lifecycle/owned-temp-root.js";
import { deriveLongMemEvalRunnerReleaseEvidenceAuthority } from
  "../release-evidence-authority.js";
import {
  recallOptionsForPolicyShape,
  resolveBenchEmbeddingProviderLabel,
  resolveCommitInfo
} from "./runner-helpers.js";
import type { LongMemEvalRunOptions } from "../runner.js";
import { loadQuestionManifestSelection } from
  "../../bench/selection/question-manifest.js";
import {
  createLongMemEvalSelectionContract,
  type LongMemEvalSelectionContract
} from "../../bench/selection/contract.js";
import { resolveSourceAssertionSupplementOptions } from
  "../../bench/extraction/cache/semantic-supplement/source-assertion-supplement-runtime.js";
import { createCurrentPostFillCacheAuthorityProof } from
  "../../bench/snapshot/current/current-substrate-authority.js";
import { readExtractionCacheManifest } from
  "../../bench/extraction/cache/extraction-cache-manifest.js";
import { hasCompleteExtractionFillAuthority } from
  "../../bench/extraction/fill/fill-authority.js";
import {
  assertSnapshotProducerInvocationPolicy,
  assertSnapshotProducerReleaseAuthority
} from
  "./policy/snapshot-producer-policy.js";

type LoadedLongMemEvalDataset = Awaited<ReturnType<typeof loadDatasetWithIdentity>>;
type LoadedRunDataset = LoadedLongMemEvalDataset & Readonly<{
  datasetQuestionCount?: number;
}>;
type LongMemEvalQuestions = LoadedLongMemEvalDataset["questions"];
type LongMemEvalQuestion = LongMemEvalQuestions[number];

export interface LongMemEvalRunContext {
  readonly opts: LongMemEvalRunOptions;
  readonly questions: LongMemEvalQuestions;
  readonly window: readonly LongMemEvalQuestion[];
  readonly datasetQuestionCount: number;
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
  const dataset = await loadRunDataset(opts);
  const questions = dataset.questions;
  const selectedQuestions = await selectManifestQuestions(opts, dataset);
  const window = opts.questionManifest === undefined
    ? selectedQuestions
    : selectQuestionWindow(selectedQuestions, opts);
  const commitInfo = resolveCommitInfo();
  const extractionCacheRoot = opts.extractionCacheRoot ?? EXTRACTION_CACHE_ROOT;
  const executionPolicy = resolvePreparationExecutionPolicy(
    dataset, opts, window, extractionCacheRoot, recallWeightOverrides, process.env
  );
  return {
    opts,
    questions,
    window,
    datasetQuestionCount: dataset.datasetQuestionCount ?? questions.length,
    datasetSha256: dataset.sha256,
    datasetChecksumSource: dataset.checksumSource,
    datasetSourcePath: dataset.sourcePath,
    ...executionPolicy,
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
    seedRunner: createLongMemEvalSeedRunner(
      window,
      extractionCacheRoot,
      Math.max(0, opts.offset ?? 0),
      dataset.sha256,
      executionPolicy.captureSnapshot
    ),
    extractionCacheRoot,
    recallWeightOverrides,
    diagnosticsSpool,
    ...(await resolveSeedDataDirRoot(opts))
  };
}

function resolvePreparationExecutionPolicy(
  dataset: LoadedLongMemEvalDataset,
  opts: LongMemEvalRunOptions,
  window: readonly LongMemEvalQuestion[],
  extractionCacheRoot: string,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined,
  env: Readonly<Record<string, string | undefined>>
) {
  const policy = {
    releaseEvidenceAuthority: deriveRunEvidenceAuthority(dataset, opts, window),
    policyShape: opts.policyShape ?? "stress",
    simulateReport: opts.simulateReport ?? "none",
    recallOptions: recallOptionsForPolicyShape(opts.policyShape ?? "stress"),
    captureSnapshot: opts.snapshotOut !== undefined
  } as const;
  if (policy.captureSnapshot) {
    const input = { ...policy, opts, recallWeightOverrides };
    assertSnapshotProducerInvocationPolicy(input, env);
    const manifest = readExtractionCacheManifest(extractionCacheRoot);
    if (manifest === undefined || hasCompleteExtractionFillAuthority(manifest)) {
      assertSnapshotProducerReleaseAuthority(input);
    }
  }
  return policy;
}

async function loadRunDataset(opts: LongMemEvalRunOptions): Promise<LoadedRunDataset> {
  const options = datasetLoadOptions(opts);
  if (opts.questionManifest !== undefined) {
    return await loadDatasetWithIdentity(opts.variant, options);
  }
  return await loadDatasetWindowWithIdentity(opts.variant, {
    ...options,
    offset: Math.max(0, opts.offset ?? 0),
    ...(opts.limit === undefined ? {} : { limit: opts.limit })
  });
}

function deriveRunEvidenceAuthority(
  dataset: LoadedLongMemEvalDataset,
  opts: LongMemEvalRunOptions,
  window: readonly LongMemEvalQuestion[]
): LongMemEvalReleaseEvidenceAuthority | null {
  const offset = Math.max(0, opts.offset ?? 0);
  if (opts.questionManifest !== undefined) return null;
  return deriveLongMemEvalRunnerReleaseEvidenceAuthority({
    datasetAuthority: dataset.promotionAuthority,
    offset,
    selection: {
      kind: "execution_window",
      offset,
      limit: window.length
    }
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
  return selectOffsetLimitWindow(questions, opts);
}

function createLongMemEvalSeedRunner(
  window: readonly LongMemEvalQuestion[],
  extractionCacheRoot: string,
  offset: number,
  datasetSha256: string,
  captureSnapshot: boolean
) {
  const requiredTurns = inspectTurnContentKeySpace(window);
  const requiredQuestionWindow = { offset, limit: window.length };
  const extractionCachePreflightProof = captureSnapshot
    ? createCurrentPostFillCacheAuthorityProof({
        cacheRoot: extractionCacheRoot,
        datasetSha256,
        requiredTurnContents: requiredTurns.distinctTurnContents,
        requiredExtractionTurns: requiredTurns.distinctExtractionTurns,
        requiredQuestionWindow,
        env: process.env
      })
    : undefined;
  const sourceAssertionSupplement = resolveSourceAssertionSupplementOptions(
    process.env
  );
  return createCompileSeedRunner({
    requiredTurnContents: requiredTurns.distinctTurnContents,
    requiredExtractionTurns: requiredTurns.distinctExtractionTurns,
    requiredQuestionWindow,
    cacheRoot: extractionCacheRoot,
    allowLiveExtraction: false,
    ...(extractionCachePreflightProof === undefined ? {} : {
      extractionCachePreflightProof
    }),
    ...(sourceAssertionSupplement === undefined
      ? {}
      : { sourceAssertionSupplement })
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
