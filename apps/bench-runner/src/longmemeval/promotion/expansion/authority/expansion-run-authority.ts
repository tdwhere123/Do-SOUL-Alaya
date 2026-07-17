import { isDeepStrictEqual } from "node:util";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { ALAYA_RECALL_WEIGHT_OVERRIDES_ENV } from
  "../../../../harness/recall/recall-weight-overrides.js";
import { readOptionalTreatmentBoolean } from
  "../../../../harness/strict-treatment-config.js";
import { resolveEffectiveExtractionCacheRoot } from
  "../../../compile-seed/compile-seed-config.js";
import { readExtractionCacheManifestIdentity } from
  "../../../extraction/cache/extraction-cache-manifest.js";
import { inspectExtractionFillCompletion } from
  "../../../extraction/fill/fill-completion.js";
import { collectDistinctTurnContents } from
  "../../../extraction/turn-contents.js";
import { assertProductDefaultBiEncoderEnvironment } from
  "../../product/product-bi-encoder-policy.js";
import { assertProductFormationEnvironment } from
  "../../product/product-formation-policy.js";
import type { LongMemEvalRunOptions } from "../../../runner.js";
import {
  captureSnapshotExtractionAuthority,
  type CapturedSnapshotExtractionAuthority
} from "../../../snapshot/extraction-authority.js";
import { assertCacheOnlyEnvironment } from
  "../../../snapshot/current/current-substrate-authority.js";
import { assertCompleteLongMemEvalExpansionCache } from
  "./expansion-cache-authority.js";
import type { LongMemEvalExpansionCapability } from
  "../expansion-capability.js";
import { loadCanonicalLongMemEvalExpansionSelection } from
  "../expansion-selection.js";
import { assertExpansionSnapshotAuthority } from
  "./expansion-snapshot-authority.js";
import { assertProductDefaultRecallEnvironment } from
  "../../verifiers/product-policy-verifier.js";
import {
  verifyLongMemEvalFanoutChild,
  type VerifiedLongMemEvalFanoutChild
} from "../../fanout-authority.js";

export interface VerifiedExpansionRunAuthority {
  readonly extraction: CapturedSnapshotExtractionAuthority;
  readonly questionCount: 500;
  readonly fanoutChild: VerifiedLongMemEvalFanoutChild | null;
}

const verifiedRunAuthorities = new WeakMap<
  object,
  VerifiedExpansionRunAuthority
>();

export async function assertExpansionRunAuthority(
  options: LongMemEvalRunOptions,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  if (options.snapshotOut !== undefined || options.expansionCapability === undefined) {
    await assertExpansionSnapshotAuthority(options, env);
    return;
  }
  await assertExpansionProductRun(options, options.expansionCapability, env);
}

export function verifiedExpansionRunAuthority(
  capability: LongMemEvalExpansionCapability | undefined
): VerifiedExpansionRunAuthority | null {
  if (capability === undefined) return null;
  return verifiedRunAuthorities.get(capability) ?? null;
}

async function assertExpansionProductRun(
  options: LongMemEvalRunOptions,
  capability: LongMemEvalExpansionCapability,
  env: Readonly<Record<string, string | undefined>>
): Promise<void> {
  assertProductRunInvocation(options, env);
  const captured = await captureVerifiedExpansionCache(options, capability, env);
  const fanoutChild = await verifyLongMemEvalFanoutChild({
    capability,
    extraction: captured,
    options,
    env
  });
  assertStandaloneOrFanoutInvocation(options, fanoutChild);
  verifiedRunAuthorities.set(capability, Object.freeze({
    extraction: captured,
    questionCount: 500 as const,
    fanoutChild
  }));
}

async function captureVerifiedExpansionCache(
  options: LongMemEvalRunOptions,
  capability: LongMemEvalExpansionCapability,
  env: Readonly<Record<string, string | undefined>>
): Promise<CapturedSnapshotExtractionAuthority> {
  const selection = await loadCanonicalLongMemEvalExpansionSelection({
    capability,
    variant: "longmemeval_s",
    dataDir: options.dataDir,
    pinnedMetaRoot: options.pinnedMetaRoot
  });
  const cacheRoot = resolveEffectiveExtractionCacheRoot(
    options.extractionCacheRoot,
    env
  );
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity?.manifest.schema_version !== 3) {
    throw new Error("500Q product-B run requires a complete expansion cache manifest");
  }
  const captured = captureSnapshotExtractionAuthority(cacheRoot);
  if (captured.compact.manifest_sha256 !== identity.manifestSha256) {
    throw new Error("500Q expansion cache changed during authority capture");
  }
  const completion = inspectExtractionFillCompletion({
    cacheRoot,
    model: identity.manifest.extraction_model,
    requestProfile: identity.manifest.request_profile,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    turnContents: collectDistinctTurnContents(selection.nextQuestions)
  });
  assertCompleteLongMemEvalExpansionCache({
    capability,
    manifest: identity.manifest,
    completion
  });
  assertCapturedSummaryStable(captured, cacheRoot);
  return captured;
}

function assertProductRunInvocation(
  options: LongMemEvalRunOptions,
  env: Readonly<Record<string, string | undefined>>
): void {
  const offset = options.offset ?? 0;
  const limit = options.limit;
  const concurrency = options.concurrency ?? 1;
  const cross = readOptionalTreatmentBoolean(
    env.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK,
    "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
  );
  if (options.variant !== "longmemeval_s" || !Number.isSafeInteger(offset) ||
      offset < 0 || !Number.isSafeInteger(limit) || limit === undefined ||
      limit < 1 || offset + limit > 500 || !Number.isSafeInteger(concurrency) ||
      concurrency < 1 || concurrency > 32) {
    throw new Error("500Q product-B run requires a contained window and concurrency 1..32");
  }
  if (concurrency > 1 && (offset !== 0 || limit !== 500)) {
    throw new Error("500Q process fan-out parent must cover exact [0,500)");
  }
  if (options.promotionContractPath?.trim().length === 0 ||
      options.promotionContractPath === undefined || options.snapshotOut !== undefined ||
      options.questionManifest !== undefined || options.dataDirRoot !== undefined ||
      options.qa !== undefined || options.weightOverridesJson !== undefined ||
      env[ALAYA_RECALL_WEIGHT_OVERRIDES_ENV] !== undefined ||
      (options.policyShape ?? "stress") !== "stress" ||
      (options.simulateReport ?? "none") !== "none" ||
      options.embeddingMode !== "env" ||
      (options.embeddingProviderKind ?? "local_onnx") !== "local_onnx" ||
      cross === true) {
    throw new Error("500Q product-B run differs from the promoted product-B contract");
  }
  assertCacheOnlyEnvironment(env);
  assertProductFormationEnvironment(env, "500Q product-B full-run formation");
  assertProductDefaultBiEncoderEnvironment(env, "500Q product-B full-run");
  assertProductDefaultRecallEnvironment(
    env,
    { maxResults: 10, conflictAwareness: true },
    undefined,
    "500Q product-B full-run"
  );
}

function assertStandaloneOrFanoutInvocation(
  options: LongMemEvalRunOptions,
  fanoutChild: VerifiedLongMemEvalFanoutChild | null
): void {
  const offset = options.offset ?? 0;
  const concurrency = options.concurrency ?? 1;
  if (fanoutChild !== null) return;
  if (concurrency !== 1 || offset !== 0 || options.limit !== 500) {
    throw new Error(
      "500Q product-B standalone run must cover exact [0,500); " +
        "partial windows require a verified parent fanout context"
    );
  }
}

function assertCapturedSummaryStable(
  captured: CapturedSnapshotExtractionAuthority,
  cacheRoot: string
): void {
  const current = captureSnapshotExtractionAuthority(cacheRoot);
  if (!isDeepStrictEqual(current.authority, captured.authority)) {
    throw new Error("500Q expansion cache changed during closure verification");
  }
}
