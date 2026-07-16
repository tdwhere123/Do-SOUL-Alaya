import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type { BenchPolicyShape, BenchSimulateReportMode } from "@do-soul/alaya-eval";
import type { BenchEmbeddingMode } from "../../harness/daemon-types.js";
import { ALAYA_RECALL_WEIGHT_OVERRIDES_ENV } from
  "../../harness/recall-weight-overrides.js";
import { resolveEffectiveExtractionCacheRoot } from "../compile-seed-config.js";
import type { LongMemEvalVariant } from "../dataset.js";
import {
  readExtractionCacheManifestIdentity
} from "../extraction-cache-manifest.js";
import { inspectExtractionFillCompletion } from "../extraction/fill-completion.js";
import { collectDistinctTurnContents } from "../extraction/turn-contents.js";
import { loadDatasetWithIdentity } from "../fetch.js";
import type { LongMemEvalQaRunOption } from "../runner.js";
import { assertCompleteLongMemEvalExpansionCache } from
  "./expansion-cache-authority.js";
import type { LongMemEvalExpansionCapability } from "./expansion-capability.js";
import { assertCanonicalLongMemEvalExpansionSelection } from
  "./expansion-selection.js";
import { assertCacheOnlyEnvironment } from
  "../snapshot/current-substrate-authority.js";
import { assertProductFormationEnvironment } from
  "../product-formation-policy.js";
export { assertCacheOnlyEnvironment } from
  "../snapshot/current-substrate-authority.js";

export interface ExpansionSnapshotOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly questionManifest?: string;
  readonly snapshotOut?: string;
  readonly extractionCacheRoot?: string;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly policyShape?: BenchPolicyShape;
  readonly simulateReport?: BenchSimulateReportMode;
  readonly weightOverridesJson?: string;
  readonly qa?: LongMemEvalQaRunOption;
  readonly concurrency?: number;
  readonly expansionCapability?: LongMemEvalExpansionCapability;
}

export async function assertExpansionSnapshotAuthority(
  options: ExpansionSnapshotOptions,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  assertNonnegativeOffset(options.offset);
  if (!maySelectFull(options)) {
    assertCapabilityAbsent(options.expansionCapability);
    return;
  }
  const dataset = await loadDatasetWithIdentity(options.variant, {
    dataDir: options.dataDir,
    pinnedMetaRoot: options.pinnedMetaRoot
  });
  const selectedCount = dataset.questions.slice(0, options.limit).length;
  if (selectedCount !== 500) {
    assertCapabilityAbsent(options.expansionCapability);
    return;
  }
  const capability = requireCapability(options.expansionCapability);
  assertExactSnapshotInvocation(options, env);
  const selection = assertCanonicalLongMemEvalExpansionSelection({ capability, dataset });
  const cacheRoot = resolveEffectiveExtractionCacheRoot(
    options.extractionCacheRoot,
    env
  );
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity === undefined || identity.manifest.schema_version !== 3) {
    throw new Error("500Q snapshot requires a complete expansion cache manifest");
  }
  const manifest = identity.manifest;
  assertCompleteLongMemEvalExpansionCache({
    capability,
    manifest,
    completion: inspectExtractionFillCompletion({
      cacheRoot,
      model: manifest.extraction_model,
      requestProfile: manifest.request_profile,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      turnContents: collectDistinctTurnContents(selection.nextQuestions)
    })
  });
}

function assertExactSnapshotInvocation(
  options: ExpansionSnapshotOptions,
  env: Readonly<Record<string, string | undefined>>
): void {
  if (options.snapshotOut === undefined) {
    throw new Error("canonical 500Q runner is snapshot-production only");
  }
  if ((options.limit !== undefined && options.limit !== 500) ||
      options.questionManifest !== undefined || (options.concurrency ?? 1) !== 1 ||
      (options.policyShape ?? "stress") !== "stress" ||
      (options.simulateReport ?? "none") !== "none" ||
      options.weightOverridesJson !== undefined ||
      env[ALAYA_RECALL_WEIGHT_OVERRIDES_ENV] !== undefined ||
      (options.embeddingMode ?? "disabled") !== "disabled" || options.qa !== undefined) {
    throw new Error("500Q snapshot invocation differs from the neutral producer contract");
  }
  assertCacheOnlyEnvironment(env);
  assertProductFormationEnvironment(env, "500Q snapshot producer product formation");
}

function maySelectFull(options: ExpansionSnapshotOptions): boolean {
  return options.variant === "longmemeval_s" && (options.offset ?? 0) === 0 &&
    (options.limit === undefined || options.limit >= 500);
}

function assertNonnegativeOffset(offset: number | undefined): void {
  if ((offset ?? 0) >= 0) return;
  throw new Error("500Q snapshot refuses a normalized negative offset");
}

function requireCapability(
  capability: LongMemEvalExpansionCapability | undefined
): LongMemEvalExpansionCapability {
  if (capability !== undefined) return capability;
  throw new Error("canonical 500Q snapshot requires live promotion capability");
}

function assertCapabilityAbsent(
  capability: LongMemEvalExpansionCapability | undefined
): void {
  if (capability === undefined) return;
  throw new Error("expansion capability may only authorize canonical full 500Q snapshot");
}
