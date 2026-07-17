import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  readExtractionCacheManifestIdentity,
  type ExtractionCacheManifest
} from "./cache/extraction-cache-manifest.js";
import { resolveCompileSeedExtractionConfig } from "../compile-seed/compile-seed-config.js";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import type { LongMemEvalQuestion, LongMemEvalVariant } from "../ingestion/dataset.js";
import { loadDatasetWithIdentity } from "../ingestion/fetch.js";
import {
  longMemEvalExpansionCapabilityData,
  type LongMemEvalExpansionCapability
} from "../promotion/expansion/expansion-capability.js";
import {
  verifyR3SpendApproval,
  type R3SpendApproval,
  type VerifiedR3SpendApproval
} from "../promotion/r3-spend-approval.js";
import {
  assertLongMemEvalExpansionLineageMatchesCapability,
  buildLongMemEvalExpansionLineage
} from "../promotion/expansion/lineage/expansion-lineage.js";
import type { LongMemEvalExpansionLineage } from
  "../promotion/expansion/lineage/expansion-lineage-schema.js";
import { assertCanonicalLongMemEvalExpansionSelection } from
  "../promotion/expansion/expansion-selection.js";
import {
  assertLongMemEvalExpansionSourceAnchor,
  buildLongMemEvalExpansionSourceAnchor
} from "../promotion/expansion/lineage/expansion-source-anchor.js";
import type { LongMemEvalExpansionSourceAnchor } from
  "../promotion/expansion/lineage/expansion-source-anchor-schema.js";
import { redactProvenanceUrl } from "../provenance/paired-environment.js";
import { hasCompleteExtractionFillAuthority } from "./fill/fill-authority.js";
import {
  inspectExtractionFillCompletion,
  type ExtractionFillCompletion
} from "./fill/fill-completion.js";
import { ExtractionCacheInvariantError } from "./cache/cache-invariant-error.js";
import { collectDistinctTurnContents } from "./turn-contents.js";

export interface ExpansionFillAuthorityOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly expansionCapability?: LongMemEvalExpansionCapability;
  readonly r3SpendApproval?: R3SpendApproval;
}

export interface PreparedExpansionFillAuthority {
  readonly capability: LongMemEvalExpansionCapability;
  readonly cacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly datasetRevision: string;
  readonly sourceAnchor: LongMemEvalExpansionSourceAnchor;
  readonly r3SpendApproval: VerifiedR3SpendApproval;
  readonly sourceTurns: readonly string[];
  readonly nextTurns: readonly string[];
  readonly nextQuestions: readonly LongMemEvalQuestion[];
}

type LongMemEvalDatasetWithIdentity = Awaited<ReturnType<typeof loadDatasetWithIdentity>>;

export async function prepareExpansionFillAuthority(
  options: ExpansionFillAuthorityOptions,
  cacheRoot: string
): Promise<PreparedExpansionFillAuthority | undefined> {
  assertNonnegativeExpansionWindow(options);
  const dataset = await loadDatasetWithIdentity(options.variant, {
    dataDir: options.dataDir,
    pinnedMetaRoot: options.pinnedMetaRoot
  });
  if (!requiresCanonicalExpansionAuthority(options, dataset)) return undefined;
  return prepareCanonicalExpansionFillAuthority(options, cacheRoot, dataset);
}

function requiresCanonicalExpansionAuthority(
  options: ExpansionFillAuthorityOptions,
  dataset: LongMemEvalDatasetWithIdentity
): boolean {
  if (options.variant !== "longmemeval_s") {
    assertCapabilityAbsent(options.expansionCapability);
    assertR3SpendApprovalAbsent(options.r3SpendApproval);
    return false;
  }
  if (dataset.promotionAuthority === null) {
    if (selectsFiveHundredQuestions(options, dataset.questions.length)) {
      throw invariant("canonical 500Q extraction requires a promotion-authorized dataset");
    }
    assertCapabilityAbsent(options.expansionCapability);
    assertR3SpendApprovalAbsent(options.r3SpendApproval);
    return false;
  }
  const window = classifyCanonicalExpansionWindow(options, dataset.questions.length);
  if (window === "source") {
    assertCapabilityAbsent(options.expansionCapability);
    assertR3SpendApprovalAbsent(options.r3SpendApproval);
    return false;
  }
  return true;
}

function selectsFiveHundredQuestions(
  options: ExpansionFillAuthorityOptions,
  questionCount: number
): boolean {
  const offset = Math.max(0, options.offset ?? 0);
  const sliceEnd = options.limit === undefined
    ? questionCount
    : offset + options.limit;
  const selectedQuestionCount = Math.max(0, Math.min(questionCount, sliceEnd) - offset);
  return selectedQuestionCount >= 500;
}

function prepareCanonicalExpansionFillAuthority(
  options: ExpansionFillAuthorityOptions,
  cacheRoot: string,
  dataset: LongMemEvalDatasetWithIdentity
): PreparedExpansionFillAuthority {
  const capability = requireCapability(options.expansionCapability);
  const selection = assertCanonicalLongMemEvalExpansionSelection({
    capability,
    dataset
  });
  const identity = requireStartingIdentity(cacheRoot);
  const config = resolveCompileSeedExtractionConfig(process.env, identity.manifest);
  const sourceTurns = collectDistinctTurnContents(selection.sourceQuestions);
  const nextTurns = collectDistinctTurnContents(selection.nextQuestions);
  const current = authorizeCurrentCacheState({
    capability, identity, config, cacheRoot, sourceTurns, nextTurns
  });
  const r3SpendApproval = verifyCurrentR3SpendApproval({
    approval: requireR3SpendApproval(options.r3SpendApproval),
    capability,
    identity,
    targetCompletion: current.targetCompletion
  });
  return Object.freeze({
    capability,
    cacheRoot,
    config,
    datasetRevision: dataset.sha256,
    sourceAnchor: current.sourceAnchor,
    r3SpendApproval,
    sourceTurns: Object.freeze([...sourceTurns]),
    nextTurns: Object.freeze([...nextTurns]),
    nextQuestions: selection.nextQuestions
  });
}

export function revalidateExpansionFillAuthority(
  authority: PreparedExpansionFillAuthority
): void {
  const identity = requireStartingIdentity(authority.cacheRoot);
  const config = resolveCompileSeedExtractionConfig(process.env, identity.manifest);
  const current = authorizeCurrentCacheState({
    capability: authority.capability,
    identity,
    config,
    cacheRoot: authority.cacheRoot,
    sourceTurns: authority.sourceTurns,
    nextTurns: authority.nextTurns
  });
  verifyCurrentR3SpendApproval({
    approval: authority.r3SpendApproval.approval,
    capability: authority.capability,
    identity,
    targetCompletion: current.targetCompletion
  });
  if (!isDeepStrictEqual(current.sourceAnchor, authority.sourceAnchor)) {
    throw invariant("source anchor changed before the write lease was acquired");
  }
}

export function finalizeExpansionFillAuthority(
  authority: PreparedExpansionFillAuthority,
  manifest: ExtractionCacheManifest,
  completion: ExtractionFillCompletion
): LongMemEvalExpansionLineage {
  const source = longMemEvalExpansionCapabilityData(authority.capability)
    .sourceSnapshot.extractionCache;
  assertSourceCompletion(source, inspectExtractionFillCompletion({
    cacheRoot: authority.cacheRoot,
    model: authority.config.model,
    requestProfile: authority.config.requestProfile,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    turnContents: authority.sourceTurns
  }), false);
  const anchor = assertLongMemEvalExpansionSourceAnchor(
    manifest.expansion_source_anchor,
    authority.capability,
    authority.config,
    completion
  );
  if (!isDeepStrictEqual(anchor, authority.sourceAnchor)) {
    throw invariant("final target source anchor changed during fill");
  }
  return buildLongMemEvalExpansionLineage(
    authority.capability,
    completion,
    manifest
  );
}

function authorizeCurrentCacheState(input: {
  readonly capability: LongMemEvalExpansionCapability;
  readonly identity: NonNullable<ReturnType<typeof readExtractionCacheManifestIdentity>>;
  readonly config: CompileSeedExtractionConfig;
  readonly cacheRoot: string;
  readonly sourceTurns: readonly string[];
  readonly nextTurns: readonly string[];
}): {
  readonly sourceAnchor: LongMemEvalExpansionSourceAnchor;
  readonly targetCompletion: ExtractionFillCompletion;
} {
  const source = sourceCacheAuthority(input.capability);
  const sourceCompletion = inspectCompletion(input, input.sourceTurns);
  const targetCompletion = inspectCompletion(input, input.nextTurns);
  assertConfigContinuity(input.config, input.identity.manifest);
  if (input.identity.manifestSha256 === source.manifestSha256) {
    assertSourceManifest(source, input.identity.manifest);
    assertSourceCompletion(source, sourceCompletion, true);
    return {
      sourceAnchor: buildLongMemEvalExpansionSourceAnchor(
        input.capability, input.config, targetCompletion
      ),
      targetCompletion
    };
  }
  const anchor = assertLongMemEvalExpansionSourceAnchor(
    input.identity.manifest.expansion_source_anchor,
    input.capability,
    input.config,
    targetCompletion
  );
  assertSourceCompletion(source, sourceCompletion, false);
  assertTargetManifestState(
    input.identity.manifest, anchor, targetCompletion, input.capability
  );
  return { sourceAnchor: anchor, targetCompletion };
}

function assertSourceManifest(
  source: ReturnType<typeof sourceCacheAuthority>,
  manifest: ExtractionCacheManifest
): void {
  if (manifest.schema_version !== 3 ||
      !hasCompleteExtractionFillAuthority(manifest) ||
      manifest.window_offset !== 0 || manifest.window_limit !== 100 ||
      manifest.extraction_model !== source.extractionModel ||
      manifest.model_family !== source.modelFamily ||
      manifest.request_profile !== source.requestProfile ||
      redactProvenanceUrl(manifest.provider_url) !== source.providerUrl ||
      manifest.system_prompt_sha256 !== source.systemPromptSha256 ||
      manifest.cache_key_algo !== source.cacheKeyAlgo ||
      manifest.dataset !== source.dataset ||
      manifest.dataset_revision !== source.datasetRevision ||
      manifest.expected_turns !== source.expectedTurns ||
      manifest.expected_key_set_sha256 !== source.expectedKeySetSha256 ||
      manifest.content_closure_sha256 !== source.contentClosureSha256) {
    throw invariant("starting cache does not preserve the authorized 100Q identity");
  }
}

function assertConfigContinuity(
  config: CompileSeedExtractionConfig,
  manifest: ExtractionCacheManifest
): void {
  const family = config.modelFamily ?? config.model;
  if (config.model !== manifest.extraction_model ||
      family !== manifest.model_family ||
      config.requestProfile !== manifest.request_profile ||
      config.providerUrl !== manifest.provider_url ||
      computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT) !==
        manifest.system_prompt_sha256 ||
      manifest.cache_key_algo !== EXTRACTION_CACHE_KEY_ALGO) {
    throw invariant("live extraction config would mix a different provider identity");
  }
}

function assertSourceCompletion(
  source: ReturnType<typeof sourceCacheAuthority>,
  completion: ExtractionFillCompletion,
  requireNoOrphans: boolean
): void {
  if (completion.expectedTurns !== source.expectedTurns ||
      completion.validTurns !== source.expectedTurns ||
      completion.missingTurns !== 0 || completion.invalidTurns !== 0 ||
      (requireNoOrphans && completion.orphanTurns !== 0) ||
      completion.expectedKeySetSha256 !== source.expectedKeySetSha256 ||
      completion.contentClosureSha256 !== source.contentClosureSha256) {
    throw invariant("authorized 100Q cache content closure changed");
  }
}

function inspectCompletion(
  input: {
    readonly cacheRoot: string;
    readonly config: CompileSeedExtractionConfig;
  },
  turnContents: readonly string[]
): ExtractionFillCompletion {
  return inspectExtractionFillCompletion({
    cacheRoot: input.cacheRoot,
    model: input.config.model,
    requestProfile: input.config.requestProfile,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    turnContents
  });
}

function assertTargetManifestState(
  manifest: ExtractionCacheManifest,
  anchor: LongMemEvalExpansionSourceAnchor,
  completion: ExtractionFillCompletion,
  capability: LongMemEvalExpansionCapability
): void {
  if (manifest.schema_version !== 3 || manifest.fill_status === undefined ||
      manifest.expansion_source_anchor === undefined) {
    throw invariant("resumed target lacks its live-verifiable source anchor");
  }
  assertTargetManifestIdentity(manifest, anchor, completion);
  if (manifest.fill_status === "in_progress") {
    if (manifest.expansion_lineage === undefined) return;
    throw invariant("in-progress target cannot claim completed expansion lineage");
  }
  const lineage = assertLongMemEvalExpansionLineageMatchesCapability(
    manifest.expansion_lineage,
    capability
  );
  const expected = buildLongMemEvalExpansionLineage(
    capability,
    completion,
    manifest
  );
  if (!isDeepStrictEqual(lineage, expected)) {
    throw invariant("completed target lineage differs from live cache closure");
  }
}

function assertTargetManifestIdentity(
  manifest: Extract<ExtractionCacheManifest, { readonly schema_version: 3 }>,
  anchor: LongMemEvalExpansionSourceAnchor,
  completion: ExtractionFillCompletion
): void {
  const target = anchor.target_cache;
  if (manifest.extraction_model !== target.extraction_model ||
      manifest.model_family !== target.model_family ||
      manifest.request_profile !== target.request_profile ||
      redactProvenanceUrl(manifest.provider_url) !== target.provider_url ||
      manifest.system_prompt_sha256 !== target.system_prompt_sha256 ||
      manifest.cache_key_algo !== target.cache_key_algo ||
      manifest.dataset !== target.dataset ||
      manifest.dataset_revision !== target.dataset_revision ||
      manifest.window_offset !== 0 || manifest.window_limit !== 500 ||
      manifest.expected_turns !== completion.expectedTurns ||
      manifest.expected_key_set_sha256 !== completion.expectedKeySetSha256 ||
      manifest.requested_turns !== completion.expectedTurns ||
      manifest.cached_turns !== completion.validTurns ||
      manifest.coverage !== completion.coverage ||
      completion.invalidTurns !== 0 || completion.orphanTurns !== 0) {
    throw invariant("resumed target manifest differs from live partial cache state");
  }
}

function sourceCacheAuthority(capability: LongMemEvalExpansionCapability) {
  return longMemEvalExpansionCapabilityData(capability).sourceSnapshot.extractionCache;
}

function assertNonnegativeExpansionWindow(options: ExpansionFillAuthorityOptions): void {
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw invariant("negative offsets or non-integer offsets cannot normalize into a canonical 500Q fill");
  }
  if (options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
    throw invariant("extraction fill limit must be a non-negative safe integer");
  }
}

function classifyCanonicalExpansionWindow(
  options: ExpansionFillAuthorityOptions,
  datasetQuestionCount: number
): "source" | "target" {
  if (datasetQuestionCount !== 500) {
    throw invariant("canonical longmemeval_s dataset must contain exactly 500 questions");
  }
  const offset = options.offset ?? 0;
  const limit = options.limit ?? datasetQuestionCount;
  if (offset === 0 && limit === 100) return "source";
  if (offset === 0 && limit === datasetQuestionCount) return "target";
  throw invariant("canonical fill window must be exactly 0..100 or 0..500");
}

function requireStartingIdentity(cacheRoot: string) {
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity !== undefined) return identity;
  throw invariant("500Q expansion requires the authorized 100Q cache manifest");
}

function requireCapability(
  capability: LongMemEvalExpansionCapability | undefined
): LongMemEvalExpansionCapability {
  if (capability !== undefined) return capability;
  throw invariant("canonical 500Q extraction-fill requires live promotion capability");
}

function requireR3SpendApproval(
  approval: R3SpendApproval | undefined
): R3SpendApproval {
  if (approval !== undefined) return approval;
  throw invariant(
    "canonical 500Q extraction-fill requires a valid fresh R3 spend approval"
  );
}

function verifyCurrentR3SpendApproval(input: {
  readonly approval: R3SpendApproval;
  readonly capability: LongMemEvalExpansionCapability;
  readonly identity: NonNullable<ReturnType<typeof readExtractionCacheManifestIdentity>>;
  readonly targetCompletion: ExtractionFillCompletion;
}): VerifiedR3SpendApproval {
  const data = longMemEvalExpansionCapabilityData(input.capability);
  const startingMissing = input.targetCompletion.missingTurns;
  try {
    return verifyR3SpendApproval(input.approval, {
      matrixAuthorizationSha256: data.matrixAuthorizationSha256,
      sourceSelectionSha256: selectionIdentitySha256(data.sourceSelection),
      sourceSelectedCount: data.sourceSelection.selected_count,
      finalCacheIdentitySha256: input.identity.manifestSha256,
      targetSelectionSha256: selectionIdentitySha256(data.nextSelection),
      targetSelectedCount: data.nextSelection.selected_count,
      startingMissing,
      maximumAttempts: Math.ceil(startingMissing * 1.1),
      successfulShardCeiling: startingMissing
    });
  } catch (cause) {
    throw invariant(
      `R3 spend approval is not valid for the current 100Q to 500Q state: ${describeCause(cause)}`
    );
  }
}

function selectionIdentitySha256(selection: {
  readonly schema_version: number;
  readonly dataset_sha256: string;
  readonly selected_id_digest: string;
  readonly selected_count: number;
  readonly expected_cohort_counts: Readonly<{ readonly answerable: number; readonly abstention: number }>;
  readonly cohort_assignment_digest: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    schema_version: selection.schema_version,
    dataset_sha256: selection.dataset_sha256,
    selected_id_digest: selection.selected_id_digest,
    selected_count: selection.selected_count,
    expected_cohort_counts: selection.expected_cohort_counts,
    cohort_assignment_digest: selection.cohort_assignment_digest
  }), "utf8").digest("hex");
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function assertCapabilityAbsent(
  capability: LongMemEvalExpansionCapability | undefined
): void {
  if (capability === undefined) return;
  throw invariant("expansion capability may only authorize canonical full 500Q fill");
}

function assertR3SpendApprovalAbsent(approval: R3SpendApproval | undefined): void {
  if (approval === undefined) return;
  throw invariant("R3 spend approval may only authorize canonical full 500Q fill");
}

function invariant(message: string): ExtractionCacheInvariantError {
  return new ExtractionCacheInvariantError(`500Q expansion refused: ${message}`);
}
