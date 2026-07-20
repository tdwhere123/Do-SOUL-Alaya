import type {
  BenchPolicyShape,
  BenchSimulateReportMode
} from "@do-soul/alaya-eval";
import {
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../../../shared/version.js";
import type { BenchRecallOptions } from "../../../harness/daemon.js";
import {
  createBenchDaemonLaunchConfig,
  type BenchDaemonLaunchConfig
} from "../../../harness/daemon/daemon-environment.js";
import type { BenchRecallWeightOverrides } from "../../../harness/recall/recall-weight-overrides.js";
import { readRecallEvalMaxResults } from
  "../../provenance/effective-recall-config.js";
import type {
  LongMemEvalSnapshotManifest,
  LongMemEvalSnapshotQuestion
} from "../../snapshot/materialize.js";
import {
  withRecallEvalSnapshot,
  type RecallEvalSnapshotBundle
} from "../../snapshot/recall-eval/recall-eval-loader.js";
import type { RecallEvalOptions } from "./recall-eval-contract.js";
import {
  buildRecallEvalRuntimeAttribution,
  planRecallEvalDataRoot,
  prepareRecallEvalDataRoot,
  recallEvalEmbeddingMode,
  recallEvalEmbeddingProviderKind
} from "./recall-eval-runtime.js";
import { assertExpansionRecallAuthority } from
  "../../promotion/expansion/authority/expansion-recall-authority.js";
import { assertCacheOnlyEnvironment } from
  "../../snapshot/current/current-substrate-authority.js";
import type { SnapshotMeasurementOracleAccessor } from
  "../../snapshot/measurement-oracle.js";
import type { SnapshotExtractionAuthority } from
  "../../snapshot/extraction-authority.js";
import { assertProductDefaultBiEncoderEnvironment } from
  "../../promotion/product/product-bi-encoder-policy.js";
import { assertProductDefaultRecallEnvironment } from
  "../../promotion/verifiers/product-policy-verifier.js";

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
  readonly measurementForQuestion: SnapshotMeasurementOracleAccessor | null;
  readonly extractionAuthority: SnapshotExtractionAuthority | null;
}

export async function prepareRecallEvalRunContext(
  options: RecallEvalOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined,
  ambientEnv: Readonly<Record<string, string | undefined>> = process.env
): Promise<RecallEvalRunContext> {
  assertProductDefaultRecallEnvironment(
    ambientEnv,
    {
      maxResults: readRecallEvalMaxResults(
        ambientEnv.ALAYA_RECALL_EVAL_MAX_RESULTS
      ),
      conflictAwareness: (options.policyShape ?? "stress") !== "chat"
    },
    // Diagnostic overrides stay attributable below; 500Q and promotion
    // separately require the effective policy to remain product-default.
    undefined,
    "recall-eval invocation"
  );
  assertCacheOnlyEnvironment(ambientEnv);
  if (recallEvalEmbeddingMode(ambientEnv) === "env") {
    assertProductDefaultBiEncoderEnvironment(
      ambientEnv,
      "recall-eval product treatment"
    );
  }
  return withRecallEvalSnapshot(options, (bundle) => prepareBoundRecallEvalRunContext(
    options,
    recallWeightOverrides,
    ambientEnv,
    bundle
  ));
}

async function prepareBoundRecallEvalRunContext(
  options: RecallEvalOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined,
  ambientEnv: Readonly<Record<string, string | undefined>>,
  bundle: RecallEvalSnapshotBundle
): Promise<RecallEvalRunContext> {
  await assertExpansionRecallAuthority({
    options,
    bundle,
    recallWeightOverrides,
    env: ambientEnv
  });
  const { policyShape, recallOptions, plannedDataDir, daemonLaunch } =
    resolveRecallEvalLaunch(options, ambientEnv);
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
    datasetSha256: resolveDatasetSha(bundle),
    measurementForQuestion: bundle.measurementForQuestion,
    extractionAuthority: bundle.extractionAuthority
  };
}

function resolveRecallEvalLaunch(
  options: RecallEvalOptions,
  ambientEnv: Readonly<Record<string, string | undefined>>
) {
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
  return { policyShape, recallOptions, plannedDataDir, daemonLaunch };
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
  bundle: RecallEvalSnapshotBundle
): string | null {
  if (bundle.datasetSha256 !== null) return bundle.datasetSha256;
  if (bundle.manifest.dataset_sha256 !== undefined) return bundle.manifest.dataset_sha256;
  const revision = bundle.manifest.extraction_provenance?.dataset_revision;
  return revision !== undefined && /^[a-f0-9]{64}$/u.test(revision) ? revision : null;
}
