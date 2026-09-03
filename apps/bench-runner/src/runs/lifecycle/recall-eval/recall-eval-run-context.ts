import type {
  BenchPolicyShape,
  BenchSimulateReportMode
} from "@do-soul/alaya-eval";
import {
  assertRecallZeroLiveExtraction,
  parseRecallRuntimeConfigFromEnv
} from "@do-soul/alaya-core";
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
  "../../../datasets/longmemeval/promotion/expansion/authority/expansion-recall-authority.js";
import { assertCacheOnlyEnvironment } from
  "../../snapshot/current/current-substrate-authority.js";
import type { SnapshotMeasurementOracleAccessor } from
  "../../snapshot/measurement-oracle.js";
import type { SnapshotExtractionAuthority } from
  "../../snapshot/extraction-authority.js";
import { assertProductDefaultBiEncoderEnvironment } from
  "../../../datasets/longmemeval/promotion/product/product-bi-encoder-policy.js";
import { assertProductDefaultRecallEnvironment } from
  "../../../datasets/longmemeval/promotion/verifiers/product-policy-verifier.js";
import type { EvidenceSearchProjectionRebuildReport } from
  "../../snapshot/recall-eval/evidence-search-projection-rebuild.js";
import type { LongMemEvalSelectionBoundarySpool } from
  "../../selection-replay/selection-boundary-spool.js";
import type { WarmDerivedSnapshotBinding } from
  "../../snapshot/recall-eval/warm-derived/warm-derived-snapshot-receipt.js";
import {
  assertBoundQuerySemanticFactorCacheFileDigest,
  bindQuerySemanticFactorCacheFileToRequest,
  loadedQuerySemanticFactorCacheFromBound,
  type LoadedQuerySemanticFactorCache
} from "../../query-factors/query-semantic-factor-cache.js";
import { EXTRACTION_CACHE_MANIFEST_VERSION } from
  "../../extraction/cache/extraction-cache-manifest.js";
import { isCurrentExtractionRequestProfile } from
  "../../extraction/request-profile.js";
import { buildExpectedEmbeddingCacheOverlayBinding } from
  "../../snapshot/recall-eval/embedding-cache-overlay/runtime-binding.js";
import type { RecallEvalMemoryProfile } from
  "../../measurement/recall-eval-memory-profile.js";

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
  readonly sourceExtractionSystemPromptSha256: string | undefined;
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
  assertRecallZeroLiveExtraction();
  const embeddingMode = options.embeddingMode ?? recallEvalEmbeddingMode(ambientEnv);
  if (embeddingMode === "env") {
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
  return buildBoundRecallEvalRunContext({
    options, bundle, window, policyShape, recallOptions, recallWeightOverrides,
    daemonLaunch, dataDir, runtimeAttribution, selectionBoundarySpool: null,
    querySemanticFactorCache, memoryProfile
  });
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
    : await bindRecallEvalQuerySemanticFactorCache(options, bundle);
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

export async function bindRecallEvalQuerySemanticFactorCache(
  options: RecallEvalOptions,
  bundle: RecallEvalSnapshotBundle
): Promise<LoadedQuerySemanticFactorCache> {
  const path = options.querySemanticFactorCachePath;
  const authority = bundle.extractionAuthority;
  const provenance = bundle.manifest.extraction_provenance;
  if (path === undefined || authority === null) {
    throw new Error("recall-eval query cache current bind requires snapshot extraction authority");
  }
  if (provenance == null ||
      provenance.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION) {
    throw new Error("recall-eval query cache current bind requires current snapshot extraction provenance");
  }
  if (authority.request_profile !== provenance.request_profile ||
      authority.extraction_model !== provenance.extraction_model) {
    throw new Error("recall-eval query cache current bind has mismatched extraction identity");
  }
  if (!isCurrentExtractionRequestProfile(authority.request_profile)) {
    throw new Error("recall-eval query cache request profile is not current authority");
  }
  const bound = await bindQuerySemanticFactorCacheFileToRequest(path, {
    requestProfile: authority.request_profile,
    model: authority.extraction_model,
    providerRoute: provenance.provider_url,
    snapshotPath: options.snapshotDbPath
  });
  if (options.querySemanticFactorCacheFileSha256 !== undefined) {
    assertBoundQuerySemanticFactorCacheFileDigest(
      path, options.querySemanticFactorCacheFileSha256
    );
  }
  return loadedQuerySemanticFactorCacheFromBound(bound);
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
    memoryProfile: input.memoryProfile,
    sourceExtractionSystemPromptSha256: input.bundle.sourceExtractionSystemPromptSha256
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
    embeddingMode: options.embeddingMode ?? recallEvalEmbeddingMode(ambientEnv),
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
