import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { isDeepStrictEqual } from "node:util";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  readExtractionCacheManifestIdentity,
  type ExtractionCacheManifest
} from "../extraction-cache-manifest.js";
import { resolveCompileSeedExtractionConfig } from "../compile-seed-config.js";
import type { CompileSeedExtractionConfig } from "../compile-seed-types.js";
import type { LongMemEvalQuestion, LongMemEvalVariant } from "../dataset.js";
import { loadDatasetWithIdentity } from "../fetch.js";
import {
  longMemEvalExpansionCapabilityData,
  type LongMemEvalExpansionCapability
} from "../promotion/expansion-capability.js";
import {
  assertLongMemEvalExpansionLineageMatchesCapability,
  buildLongMemEvalExpansionLineage
} from "../promotion/expansion-lineage.js";
import type { LongMemEvalExpansionLineage } from
  "../promotion/expansion-lineage-schema.js";
import { assertCanonicalLongMemEvalExpansionSelection } from
  "../promotion/expansion-selection.js";
import {
  assertLongMemEvalExpansionSourceAnchor,
  buildLongMemEvalExpansionSourceAnchor
} from "../promotion/expansion-source-anchor.js";
import type { LongMemEvalExpansionSourceAnchor } from
  "../promotion/expansion-source-anchor-schema.js";
import { redactProvenanceUrl } from "../provenance/paired-environment.js";
import { hasCompleteExtractionFillAuthority } from "./fill-authority.js";
import {
  inspectExtractionFillCompletion,
  type ExtractionFillCompletion
} from "./fill-completion.js";
import { ExtractionCacheInvariantError } from "./cache-invariant-error.js";
import { collectDistinctTurnContents } from "./turn-contents.js";

export interface ExpansionFillAuthorityOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly expansionCapability?: LongMemEvalExpansionCapability;
}

export interface PreparedExpansionFillAuthority {
  readonly capability: LongMemEvalExpansionCapability;
  readonly cacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly datasetRevision: string;
  readonly sourceAnchor: LongMemEvalExpansionSourceAnchor;
  readonly sourceTurns: readonly string[];
  readonly nextTurns: readonly string[];
  readonly nextQuestions: readonly LongMemEvalQuestion[];
}

export async function prepareExpansionFillAuthority(
  options: ExpansionFillAuthorityOptions,
  cacheRoot: string
): Promise<PreparedExpansionFillAuthority | undefined> {
  assertNonnegativeExpansionWindow(options);
  const dataset = await loadDatasetWithIdentity(options.variant, {
    dataDir: options.dataDir,
    pinnedMetaRoot: options.pinnedMetaRoot
  });
  if (options.variant !== "longmemeval_s" ||
      dataset.promotionAuthority === null) {
    assertCapabilityAbsent(options.expansionCapability);
    return undefined;
  }
  const window = classifyCanonicalExpansionWindow(options, dataset.questions.length);
  if (window === "source") {
    assertCapabilityAbsent(options.expansionCapability);
    return undefined;
  }
  const capability = requireCapability(options.expansionCapability);
  const selection = assertCanonicalLongMemEvalExpansionSelection({
    capability,
    dataset
  });
  const identity = requireStartingIdentity(cacheRoot);
  const config = resolveCompileSeedExtractionConfig(process.env, identity.manifest);
  const sourceTurns = collectDistinctTurnContents(selection.sourceQuestions);
  const nextTurns = collectDistinctTurnContents(selection.nextQuestions);
  const sourceAnchor = authorizeCurrentCacheState({
    capability, identity, config, cacheRoot, sourceTurns, nextTurns
  });
  return Object.freeze({
    capability,
    cacheRoot,
    config,
    datasetRevision: dataset.sha256,
    sourceAnchor,
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
  if (!isDeepStrictEqual(current, authority.sourceAnchor)) {
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
}): LongMemEvalExpansionSourceAnchor {
  const source = sourceCacheAuthority(input.capability);
  const sourceCompletion = inspectCompletion(input, input.sourceTurns);
  const targetCompletion = inspectCompletion(input, input.nextTurns);
  assertConfigContinuity(input.config, input.identity.manifest);
  if (input.identity.manifestSha256 === source.manifestSha256) {
    assertSourceManifest(source, input.identity.manifest);
    assertSourceCompletion(source, sourceCompletion, true);
    return buildLongMemEvalExpansionSourceAnchor(
      input.capability, input.config, targetCompletion
    );
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
  return anchor;
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
  if ((options.offset ?? 0) >= 0) return;
  throw invariant("negative offsets cannot normalize into a canonical 500Q fill");
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

function assertCapabilityAbsent(
  capability: LongMemEvalExpansionCapability | undefined
): void {
  if (capability === undefined) return;
  throw invariant("expansion capability may only authorize canonical full 500Q fill");
}

function invariant(message: string): ExtractionCacheInvariantError {
  return new ExtractionCacheInvariantError(`500Q expansion refused: ${message}`);
}
