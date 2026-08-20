import type {
  BenchPolicyShape,
  BenchSimulateReportMode
} from "@do-soul/alaya-eval";
import { parseRecallRuntimeConfigFromEnv } from "@do-soul/alaya-core";
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
  assertDistinctSnapshotRestorePaths,
  planRecallEvalDataRoot,
  prepareRecallEvalDataRoot,
  recallEvalEmbeddingMode,
  recallEvalEmbeddingProviderKind
} from "./recall-eval-runtime.js";
import { assertExpansionRecallAuthority } from
  "../../../longmemeval/promotion/expansion/authority/expansion-recall-authority.js";
import { assertCacheOnlyEnvironment } from
  "../../snapshot/current/current-substrate-authority.js";
import type { SnapshotMeasurementOracleAccessor } from
  "../../snapshot/measurement-oracle.js";
import type { SnapshotExtractionAuthority } from
  "../../snapshot/extraction-authority.js";
import { assertProductDefaultBiEncoderEnvironment } from
  "../../../longmemeval/promotion/product/product-bi-encoder-policy.js";
import { assertProductDefaultRecallEnvironment } from
  "../../../longmemeval/promotion/verifiers/product-policy-verifier.js";
import type { EvidenceSearchProjectionRebuildReport } from
  "../../snapshot/recall-eval/evidence-search-projection-rebuild.js";
import {
  createRecallEvalSelectionBoundarySpool
} from "./recall-eval-selection-replay.js";
import type { LongMemEvalSelectionBoundarySpool } from
  "../../selection-replay/selection-boundary-spool.js";
import type { WarmDerivedSnapshotBinding } from
  "../../snapshot/recall-eval/warm-derived/warm-derived-snapshot-receipt.js";
import {
  readQuerySemanticFactorCache,
  type LoadedQuerySemanticFactorCache
} from "../../query-factors/query-semantic-factor-cache.js";
import { buildExpectedEmbeddingCacheOverlayBinding } from
  "../../snapshot/recall-eval/embedding-cache-overlay/runtime-binding.js";
import type { RecallEvalMemoryProfile } from
  "../../measurement/recall-eval-memory-profile.js";
import { finalizeOwnedTempRoot } from "../owned-temp-root.js";
import { throwLifecycleErrors } from "../errors.js";

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
  readonly derivedEvidenceProjectionRebuild:
    EvidenceSearchProjectionRebuildReport | null;
  readonly warmDerivedSnapshot: WarmDerivedSnapshotBinding | null;
  readonly selectionBoundarySpool: LongMemEvalSelectionBoundarySpool | null;
  readonly querySemanticFactorCache: LoadedQuerySemanticFactorCache | null;
  readonly memoryProfile: RecallEvalMemoryProfile | null;
}

export async function prepareRecallEvalRunContext(
  options: RecallEvalOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined,
  ambientEnv: Readonly<Record<string, string | undefined>> = process.env,
  memoryProfile: RecallEvalMemoryProfile | null = null
): Promise<RecallEvalRunContext> {
  if (options.dataDirRoot !== undefined) {
    await assertDistinctSnapshotRestorePaths(
      options.snapshotDbPath,
      options.dataDirRoot
    );
  }
  assertDerivedProjectionRebuildBoundary(options);
  assertProductDefaultRecallEnvironment(
    recallEvalInvocationPolicyEnvironment(ambientEnv),
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
  return withRecallEvalSnapshot(options, async (bundle) => {
    await memoryProfile?.sample({ phase: "snapshot_authority_verified" });
    const context = await prepareBoundRecallEvalRunContext(
      options, recallWeightOverrides, ambientEnv, bundle, memoryProfile
    );
    return context;
  });
}

function assertDerivedProjectionRebuildBoundary(
  options: RecallEvalOptions
): void {
  if (options.seedExtractionSystemPromptPath !== undefined &&
      options.experiment !== true) {
    throw new Error("historical extraction prompt requires experiment mode");
  }
  if (options.factFrameRetrofitLedgerPath !== undefined &&
      options.derivedEvidenceProjectionRebuild !== true) {
    throw new Error("fact-frame retrofit ledger requires derived evidence projection rebuild");
  }
  if (options.warmDerivedSnapshotReceiptPath !== undefined &&
      options.experiment !== true) {
    throw new Error("warm derived snapshot restore requires experiment mode");
  }
  if (options.embeddingCacheOverlayReceiptPath !== undefined &&
      (options.legacySnapshot === true ||
       options.derivedEvidenceProjectionRebuild === true ||
       options.warmDerivedSnapshotReceiptPath !== undefined)) {
    throw new Error(
      "embedding cache overlay cannot use legacy or derived snapshot inputs"
    );
  }
  if (options.warmDerivedSnapshotReceiptPath !== undefined &&
      options.derivedEvidenceProjectionRebuild === true) {
    throw new Error("warm derived snapshot restore cannot be combined with projection rebuild");
  }
  if (options.warmDerivedSnapshotReceiptPath !== undefined &&
      (options.legacySnapshot === true || options.expansionCapability !== undefined)) {
    throw new Error("warm derived snapshot restore cannot use legacy or promotion inputs");
  }
  if (options.derivedEvidenceProjectionRebuild !== true) return;
  if (options.experiment !== true) {
    throw new Error("derived evidence projection rebuild requires experiment mode");
  }
  if (options.legacySnapshot === true || options.expansionCapability !== undefined) {
    throw new Error(
      "derived evidence projection rebuild cannot use legacy or promotion inputs"
    );
  }
}

function recallEvalInvocationPolicyEnvironment(
  env: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string | undefined>> {
  // Diagnostic treatments bypass the product-default comparison, but malformed
  // values must still fail before any benchmark artifact is read.
  parseRecallRuntimeConfigFromEnv(env);
  const diagnostic = { ...env };
  delete diagnostic.ALAYA_RECALL_FINAL_AUTHORITY_MAX_HEAD_DROP;
  delete diagnostic.ALAYA_RECALL_CONF_H1_MAX_PRODUCT;
  return diagnostic;
}

async function prepareBoundRecallEvalRunContext(
  options: RecallEvalOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined,
  ambientEnv: Readonly<Record<string, string | undefined>>,
  bundle: RecallEvalSnapshotBundle,
  memoryProfile: RecallEvalMemoryProfile | null
): Promise<RecallEvalRunContext> {
  await assertExpansionRecallAuthority({
    options,
    bundle,
    recallWeightOverrides,
    env: ambientEnv
  });
  const { policyShape, recallOptions, plannedDataDir, daemonLaunch } =
    resolveRecallEvalLaunch(options, ambientEnv);
  const { window, querySemanticFactorCache, baseRuntimeAttribution } =
    await prepareRecallEvalAttribution(
      options, bundle, daemonLaunch, recallOptions, recallWeightOverrides
    );
  const overlayExpected = options.embeddingCacheOverlayReceiptPath === undefined
    ? undefined
    : buildExpectedEmbeddingCacheOverlayBinding({
        manifest: bundle.manifest,
        snapshotManifestSha256: bundle.snapshotManifestSha256,
        embeddingSupplement: baseRuntimeAttribution.embedding_supplement
      });
  const dataDir = await prepareRecallEvalDataRoot(
    options, bundle, plannedDataDir, overlayExpected
  );
  const runtimeAttribution = dataDir.embeddingCacheOverlay === null
    ? baseRuntimeAttribution
    : Object.freeze({
        ...baseRuntimeAttribution,
        embedding_cache_overlay: dataDir.embeddingCacheOverlay
      });
  const selectionBoundarySpool = await createSelectionSpoolOrFinalizeDataRoot(
    ambientEnv, dataDir
  );
  return buildBoundRecallEvalRunContext({
    options, bundle, window, policyShape, recallOptions, recallWeightOverrides,
    daemonLaunch, dataDir, runtimeAttribution, selectionBoundarySpool,
    querySemanticFactorCache, memoryProfile
  });
}

async function createSelectionSpoolOrFinalizeDataRoot(
  ambientEnv: Readonly<Record<string, string | undefined>>,
  dataDir: Awaited<ReturnType<typeof prepareRecallEvalDataRoot>>
): Promise<LongMemEvalSelectionBoundarySpool | null> {
  try {
    return await createRecallEvalSelectionBoundarySpool(ambientEnv);
  } catch (primaryError) {
    let cleanupError: unknown;
    try {
      await finalizeOwnedTempRoot(
        { path: dataDir.path, owned: dataDir.owned }, false
      );
    } catch (error) {
      cleanupError = error;
    }
    throwLifecycleErrors(
      "recall-eval context acquisition failed",
      [primaryError, cleanupError]
    );
    throw new Error("recall-eval context acquisition lost its failure");
  }
}

async function prepareRecallEvalAttribution(
  options: RecallEvalOptions,
  bundle: RecallEvalSnapshotBundle,
  daemonLaunch: BenchDaemonLaunchConfig,
  recallOptions: ReturnType<typeof resolveRecallEvalLaunch>["recallOptions"],
  recallWeightOverrides: BenchRecallWeightOverrides | undefined
) {
  const window = selectWindow(bundle.sidecar.questions, options);
  const querySemanticFactorCache = options.querySemanticFactorCachePath === undefined
    ? null
    : await readQuerySemanticFactorCache({
        path: options.querySemanticFactorCachePath,
        required_source_texts: window.map((question) => question.question)
      });
  const baseRuntimeAttribution = await buildRecallEvalRuntimeAttribution(
    bundle.manifest,
    daemonLaunch.environment,
    {
      snapshotManifestSha256: bundle.snapshotManifestSha256,
      datasetSha256: bundle.datasetSha256,
      recallOptions,
      recallWeightOverrides,
      ...(querySemanticFactorCache === null
        ? {}
        : { querySemanticFactorCache: querySemanticFactorCache.binding }),
      nonPromotableDerivedRebuild:
        options.derivedEvidenceProjectionRebuild === true ||
        options.warmDerivedSnapshotReceiptPath !== undefined
    }
  );
  return { window, querySemanticFactorCache, baseRuntimeAttribution };
}

function buildBoundRecallEvalRunContext(input: Readonly<{
  options: RecallEvalOptions;
  bundle: RecallEvalSnapshotBundle;
  window: readonly LongMemEvalSnapshotQuestion[];
  policyShape: BenchPolicyShape;
  recallOptions: ReturnType<typeof resolveRecallEvalLaunch>["recallOptions"];
  recallWeightOverrides: BenchRecallWeightOverrides | undefined;
  daemonLaunch: BenchDaemonLaunchConfig;
  dataDir: Awaited<ReturnType<typeof prepareRecallEvalDataRoot>>;
  runtimeAttribution: RecallEvalRunContext["runtimeAttribution"];
  selectionBoundarySpool: LongMemEvalSelectionBoundarySpool | null;
  querySemanticFactorCache: LoadedQuerySemanticFactorCache | null;
  memoryProfile: RecallEvalMemoryProfile | null;
}>): RecallEvalRunContext {
  return {
    options: input.options,
    manifest: input.bundle.manifest,
    window: input.window,
    sidecarQuestionCount: input.bundle.sidecar.questions.length,
    dataDirRoot: input.dataDir.path,
    ownsDataDirRoot: input.dataDir.owned,
    policyShape: input.policyShape,
    simulateReport: input.options.simulateReport ?? "none",
    recallOptions: input.recallOptions,
    alayaVersion: resolveBenchRunnerVersion(),
    commitSha7: resolveBenchCommitSha7(),
    runAt: new Date(),
    recallWeightOverrides: input.recallWeightOverrides,
    daemonLaunch: input.daemonLaunch,
    runtimeAttribution: input.runtimeAttribution,
    datasetSha256: resolveDatasetSha(input.bundle),
    measurementForQuestion: input.bundle.measurementForQuestion,
    extractionAuthority: input.bundle.extractionAuthority,
    derivedEvidenceProjectionRebuild: input.dataDir.evidenceProjectionRebuild,
    warmDerivedSnapshot: input.dataDir.warmDerivedSnapshot,
    selectionBoundarySpool: input.selectionBoundarySpool,
    querySemanticFactorCache: input.querySemanticFactorCache,
    memoryProfile: input.memoryProfile
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
