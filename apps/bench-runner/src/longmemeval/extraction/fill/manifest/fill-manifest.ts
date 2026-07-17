import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type { CompileSeedExtractionConfig } from "../../../compile-seed/compile-seed-types.js";
import type { LongMemEvalVariant } from "../../../ingestion/dataset.js";
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
  "../../../promotion/expansion/lineage/expansion-source-anchor-schema.js";

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
    ...(contentClosure ?? {}),
    storage: input.existingManifest?.storage ?? "git-tracked",
    built_at: new Date().toISOString(),
    builder: "extraction-fill"
  };
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
