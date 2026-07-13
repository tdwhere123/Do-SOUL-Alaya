import type {
  BenchPolicyShape,
  BenchSimulateReportMode
} from "@do-soul/alaya-eval";
import {
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../../shared/version.js";
import type { BenchRecallOptions } from "../../harness/daemon.js";
import {
  createBenchDaemonLaunchConfig,
  type BenchDaemonLaunchConfig
} from "../../harness/daemon-environment.js";
import type { BenchRecallWeightOverrides } from "../../harness/recall-weight-overrides.js";
import {
  assertRecallEvalProductPolicyEnvironment,
  readRecallEvalMaxResults
} from "../provenance/effective-recall-config.js";
import type {
  LongMemEvalSnapshotManifest,
  LongMemEvalSnapshotQuestion
} from "../snapshot.js";
import { loadRecallEvalSnapshot } from "../snapshot/recall-eval-loader.js";
import type { RecallEvalOptions } from "./recall-eval-contract.js";
import {
  buildRecallEvalRuntimeAttribution,
  planRecallEvalDataRoot,
  prepareRecallEvalDataRoot,
  recallEvalEmbeddingMode,
  recallEvalEmbeddingProviderKind
} from "./recall-eval-runtime.js";

export interface RecallEvalRunContext {
  readonly options: RecallEvalOptions;
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly window: readonly LongMemEvalSnapshotQuestion[];
  readonly sidecarQuestionCount: number;
  readonly dataDirRoot: string;
  readonly ownsDataDirRoot: boolean;
  readonly policyShape: BenchPolicyShape;
  readonly simulateReport: BenchSimulateReportMode;
  readonly recallOptions: BenchRecallOptions;
  readonly alayaVersion: string;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
  readonly daemonLaunch: BenchDaemonLaunchConfig;
  readonly runtimeAttribution: Awaited<ReturnType<typeof buildRecallEvalRuntimeAttribution>>;
  readonly datasetSha256: string | null;
}

export async function prepareRecallEvalRunContext(
  options: RecallEvalOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined,
  ambientEnv: Readonly<Record<string, string | undefined>> = process.env
): Promise<RecallEvalRunContext> {
  assertRecallEvalProductPolicyEnvironment(ambientEnv);
  const bundle = await loadRecallEvalSnapshot(options);
  const policyShape = options.policyShape ?? "stress";
  const recallOptions = {
    maxResults: readRecallEvalMaxResults(ambientEnv.ALAYA_RECALL_EVAL_MAX_RESULTS),
    conflictAwareness: policyShape !== "chat"
  };
  const plannedDataDir = planRecallEvalDataRoot(options);
  const daemonLaunch = createBenchDaemonLaunchConfig({
    dataDir: plannedDataDir.path,
    embeddingMode: recallEvalEmbeddingMode(ambientEnv),
    embeddingProviderKind: recallEvalEmbeddingProviderKind(ambientEnv),
    ambientEnv
  });
  const runtimeAttribution = await buildRecallEvalRuntimeAttribution(
    bundle.manifest,
    daemonLaunch.environment,
    {
      snapshotManifestSha256: bundle.snapshotManifestSha256,
      datasetSha256: bundle.datasetSha256,
      recallOptions,
      recallWeightOverrides
    }
  );
  const dataDir = await prepareRecallEvalDataRoot(options, bundle, plannedDataDir);
  return {
    options,
    manifest: bundle.manifest,
    window: selectWindow(bundle.sidecar.questions, options),
    sidecarQuestionCount: bundle.sidecar.questions.length,
    dataDirRoot: dataDir.path,
    ownsDataDirRoot: dataDir.owned,
    policyShape,
    simulateReport: options.simulateReport ?? "none",
    recallOptions,
    alayaVersion: resolveBenchRunnerVersion(),
    commitSha7: resolveBenchCommitSha7(),
    runAt: new Date(),
    recallWeightOverrides,
    daemonLaunch,
    runtimeAttribution,
    datasetSha256: resolveDatasetSha(bundle)
  };
}

function selectWindow(
  questions: readonly LongMemEvalSnapshotQuestion[],
  options: RecallEvalOptions
): readonly LongMemEvalSnapshotQuestion[] {
  const offset = Math.max(0, options.offset ?? 0);
  const end = options.limit === undefined ? questions.length : offset + options.limit;
  return questions.slice(offset, end);
}

function resolveDatasetSha(
  bundle: Awaited<ReturnType<typeof loadRecallEvalSnapshot>>
): string | null {
  if (bundle.datasetSha256 !== null) return bundle.datasetSha256;
  if (bundle.manifest.dataset_sha256 !== undefined) return bundle.manifest.dataset_sha256;
  const revision = bundle.manifest.extraction_provenance?.dataset_revision;
  return revision !== undefined && /^[a-f0-9]{64}$/u.test(revision) ? revision : null;
}
