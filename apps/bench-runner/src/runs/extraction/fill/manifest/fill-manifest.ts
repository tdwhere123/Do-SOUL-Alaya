import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { CompileSeedExtractionConfig } from "../../../compile-seed/compile-seed-types.js";
import type { LongMemEvalVariant } from "../../../../datasets/longmemeval/ingestion/dataset.js";
import type { ExtractionFillCompletion } from "../fill-completion.js";
import type {
  ExtractionFillManifestContract,
  ExtractionFillStatus
} from "./fill-manifest-contract.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  computeSystemPromptSha256,
  readExtractionCacheManifestIdentity,
  writeExtractionCacheManifest,
  type ExtractionCacheManifest
} from "../../cache/extraction-cache-manifest.js";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import { assertManifestlessCacheIsEmpty } from "./fill-root-guard.js";
import type { LongMemEvalExpansionSourceAnchor } from
  "../../../../datasets/longmemeval/promotion/expansion/lineage/expansion-source-anchor-schema.js";
import type { ExtractionTargetSelectionReceipt } from
  "../../authority/target-selection/receipt.js";
import { publishBytesExclusiveDurable } from "./durable-exclusive-publication.js";
import type { SupplementalSourceManifestBinding } from
  "../../cache/supplemental-source-receipt.js";

export function buildFillManifest(input: {
  readonly config: CompileSeedExtractionConfig;
  readonly variant: LongMemEvalVariant;
  readonly existingManifest: ExtractionCacheManifest | undefined;
  readonly datasetRevision: string;
  readonly status: ExtractionFillStatus;
  readonly windowOffset: number;
  readonly windowLimit: number;
  readonly completion: ExtractionFillCompletion;
  readonly expansionSourceAnchor?: LongMemEvalExpansionSourceAnchor;
  readonly supplementalSourceReceipt?: SupplementalSourceManifestBinding;
  readonly builtAt?: string;
}): ExtractionCacheManifest {
  const completion = input.completion;
  const contentClosure = requireContentClosure(input.status, completion);
  return {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: input.config.model,
    model_family: input.config.modelFamily ?? input.config.model,
    request_profile: input.config.requestProfile,
    provider_url: input.config.providerUrl,
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: input.variant.replace(/_/u, "-"),
    dataset_revision: input.datasetRevision,
    requested_turns: completion.expectedTurns,
    cached_turns: completion.validTurns,
    coverage: completion.coverage,
    fill_status: input.status,
    window_offset: input.windowOffset,
    window_limit: input.windowLimit,
    expected_turns: completion.expectedTurns,
    expected_key_set_sha256: completion.expectedKeySetSha256,
    ...(input.expansionSourceAnchor === undefined ? {} : {
      expansion_source_anchor: input.expansionSourceAnchor
    }),
    ...resolveSupplementalBinding(input),
    ...(contentClosure ?? {}),
    storage: input.existingManifest?.storage ?? "git-tracked",
    built_at: input.builtAt ?? new Date().toISOString(),
    builder: "extraction-fill"
  };
}

function resolveSupplementalBinding(
  input: Parameters<typeof buildFillManifest>[0]
): { readonly supplemental_source_receipt?: SupplementalSourceManifestBinding } {
  const existing = input.existingManifest?.supplemental_source_receipt;
  const next = input.supplementalSourceReceipt;
  if (next !== undefined && (input.status !== "complete" || existing !== undefined)) {
    throw new ExtractionCacheInvariantError(
      "supplemental source binding may only finalize an unbound manifest"
    );
  }
  const binding = next ?? existing;
  return binding === undefined ? {} : { supplemental_source_receipt: binding };
}

export function buildMaterializedTargetFillManifest(input: {
  readonly sourceManifest: Extract<ExtractionCacheManifest, { readonly schema_version: 3 }>;
  readonly targetSelection: ExtractionTargetSelectionReceipt;
  readonly expectedTurns: number;
  readonly cachedTurns: number;
  readonly expectedKeySetSha256: string;
  readonly builtAt: string;
}): Extract<ExtractionCacheManifest, { readonly schema_version: 3 }> {
  const source = input.sourceManifest;
  const target = input.targetSelection.final_identity;
  return {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: source.extraction_model,
    model_family: source.model_family,
    request_profile: source.request_profile,
    provider_url: source.provider_url,
    system_prompt_sha256: source.system_prompt_sha256,
    cache_key_algo: source.cache_key_algo,
    dataset: target.dataset_variant.replace(/_/u, "-"),
    dataset_revision: target.dataset_revision_sha256,
    requested_turns: input.expectedTurns,
    cached_turns: input.cachedTurns,
    coverage: input.expectedTurns === 0 ? 1 : input.cachedTurns / input.expectedTurns,
    fill_status: "in_progress",
    window_offset: input.targetSelection.initial_selection.offset,
    window_limit: input.targetSelection.initial_selection.limit,
    expected_turns: input.expectedTurns,
    expected_key_set_sha256: input.expectedKeySetSha256,
    storage: source.storage,
    ...(source.archive_url === undefined ? {} : { archive_url: source.archive_url }),
    ...(source.archive_sha256 === undefined ? {} : { archive_sha256: source.archive_sha256 }),
    ...(source.supplemental_source_receipt === undefined ? {} : {
      supplemental_source_receipt: source.supplemental_source_receipt
    }),
    built_at: input.builtAt,
    builder: "audited-cache-materializer"
  };
}

export function writeNewMaterializedTargetFillManifest(
  cacheRoot: string,
  manifest: Extract<ExtractionCacheManifest, { readonly schema_version: 3 }>,
  operationId: string,
  temporaryDirectory: string = dirname(cacheRoot)
): string {
  const path = join(cacheRoot, "manifest.json");
  const bytes = serializeMaterializedTargetFillManifest(manifest);
  publishBytesExclusiveDurable({
    destination: path, bytes, ownerIdentity: operationId,
    temporaryDirectory
  });
  return createHash("sha256").update(bytes).digest("hex");
}

export function serializeMaterializedTargetFillManifest(
  manifest: Extract<ExtractionCacheManifest, { readonly schema_version: 3 }>
): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function requireContentClosure(
  status: ExtractionFillStatus,
  completion: ExtractionFillCompletion
): Pick<
  ExtractionFillManifestContract,
  "content_closure_sha256" | "content_closure_index"
> | undefined {
  if (status !== "complete") return undefined;
  if (completion.contentClosureSha256 !== null &&
      completion.contentClosureIndex != null) {
    return {
      content_closure_sha256: completion.contentClosureSha256,
      content_closure_index: completion.contentClosureIndex
    };
  }
  throw new ExtractionCacheInvariantError(
    "complete extraction-fill manifest requires a content closure"
  );
}

export function pinExtractionCacheIdentity(input: {
  readonly cacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly variant: LongMemEvalVariant;
  readonly existingIdentity: ReturnType<typeof readExtractionCacheManifestIdentity>;
  readonly datasetRevision: string;
  readonly windowOffset: number;
  readonly windowLimit: number;
  readonly completion: ExtractionFillCompletion;
  readonly expansionSourceAnchor?: LongMemEvalExpansionSourceAnchor;
}): { readonly manifest: ExtractionCacheManifest; readonly manifestSha256: string } {
  const existingManifest = resolveExistingManifest(input);
  writeExtractionCacheManifest(input.cacheRoot, buildFillManifest({
    config: input.config,
    variant: input.variant,
    existingManifest,
    datasetRevision: input.datasetRevision,
    status: "in_progress",
    windowOffset: input.windowOffset,
    windowLimit: input.windowLimit,
    completion: input.completion,
    ...(input.expansionSourceAnchor === undefined ? {} : {
      expansionSourceAnchor: input.expansionSourceAnchor
    })
  }));
  const identity = readExtractionCacheManifestIdentity(input.cacheRoot);
  if (identity === undefined) {
    throw new ExtractionCacheInvariantError(
      "extraction-fill failed to pin its cache manifest identity"
    );
  }
  return identity;
}

function resolveExistingManifest(input: {
  readonly cacheRoot: string;
  readonly existingIdentity: ReturnType<typeof readExtractionCacheManifestIdentity>;
  readonly datasetRevision: string;
}): ExtractionCacheManifest | undefined {
  const manifest = input.existingIdentity?.manifest;
  if (manifest === undefined) return undefined;
  if (manifest.dataset_revision === input.datasetRevision) return manifest;
  if (manifest.dataset_revision === "unpinned") {
    assertUnpinnedCacheIsEmpty(input.cacheRoot, manifest);
    return manifest;
  }
  throw new ExtractionCacheInvariantError(
    "extraction cache dataset revision mismatch: " +
      `manifest=${manifest.dataset_revision} verified=${input.datasetRevision}`
  );
}

function assertUnpinnedCacheIsEmpty(
  cacheRoot: string,
  manifest: ExtractionCacheManifest
): void {
  if (manifest.requested_turns !== 0 || manifest.cached_turns !== 0) {
    throw new ExtractionCacheInvariantError(
      "unpinned non-empty extraction cache cannot acquire dataset provenance; " +
        "use a new cache root"
    );
  }
  assertManifestlessCacheIsEmpty(cacheRoot);
}
