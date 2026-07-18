import { isDeepStrictEqual } from "node:util";
import {
  longMemEvalExpansionCapabilityData,
  type LongMemEvalExpansionCapability
} from "../expansion-capability.js";
import type { ExtractionFillCompletion } from "../../../extraction/fill/fill-completion.js";
import type { ExtractionCacheManifest } from "../../../extraction/cache/extraction-cache-manifest.js";
import { redactProvenanceUrl } from "../../../provenance/paired-environment.js";
import { computeSupplementalSourceBindingSha256 } from
  "../../../extraction/cache/supplemental-source-receipt.js";
import {
  LongMemEvalExpansionLineageSchema,
  type LongMemEvalExpansionLineage
} from "./expansion-lineage-schema.js";
export {
  LongMemEvalExpansionLineageSchema,
  type LongMemEvalExpansionLineage
} from "./expansion-lineage-schema.js";

export function buildLongMemEvalExpansionLineage(
  capability: LongMemEvalExpansionCapability,
  completion: ExtractionFillCompletion,
  targetManifest: ExtractionCacheManifest
): LongMemEvalExpansionLineage {
  if (completion.validTurns !== completion.expectedTurns ||
      completion.missingTurns !== 0 || completion.invalidTurns !== 0 ||
      completion.orphanTurns !== 0 || completion.contentClosureSha256 === null) {
    throw new Error("500Q expansion lineage requires an exact completed target cache");
  }
  const data = longMemEvalExpansionCapabilityData(capability);
  assertTargetCacheContinuity(data, completion, targetManifest);
  return LongMemEvalExpansionLineageSchema.parse({
    schema_version: 1,
    kind: "longmemeval_100_to_500_expansion",
    contract_sha256: data.contractSha256,
    policy_version: data.policyVersion,
    code: data.code,
    source_selection: data.sourceSelection,
    next_selection: data.nextSelection,
    matrix_sha256: data.matrix.sha256,
    product_default: data.productDefault,
    source_snapshot: expansionSourceSnapshotRecord(data.sourceSnapshot),
    source_cache: expansionSourceCacheRecord(data.sourceSnapshot.extractionCache),
    target_cache: targetCacheLineage(targetManifest, completion)
  });
}

export function assertLongMemEvalExpansionLineageMatchesCapability(
  lineage: unknown,
  capability: LongMemEvalExpansionCapability
): LongMemEvalExpansionLineage {
  const parsed = LongMemEvalExpansionLineageSchema.parse(lineage);
  const data = longMemEvalExpansionCapabilityData(capability);
  const expected = {
    contract_sha256: data.contractSha256,
    policy_version: data.policyVersion,
    code: data.code,
    source_selection: data.sourceSelection,
    next_selection: data.nextSelection,
    matrix_sha256: data.matrix.sha256,
    product_default: data.productDefault,
    source_snapshot: expansionSourceSnapshotRecord(data.sourceSnapshot),
    source_cache: expansionSourceCacheRecord(data.sourceSnapshot.extractionCache)
  };
  const { target_cache: _target, schema_version: _schema, kind: _kind, ...actual } = parsed;
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error("500Q expansion lineage differs from live promotion capability");
  }
  return parsed;
}

export function expansionSourceSnapshotRecord(
  snapshot: ReturnType<typeof longMemEvalExpansionCapabilityData>["sourceSnapshot"]
) {
  return {
    db_path: snapshot.dbPath,
    manifest_sha256: snapshot.manifestSha256,
    db_sha256: snapshot.dbSha256,
    sidecar_sha256: snapshot.sidecarSha256
  };
}

export function expansionSourceCacheRecord(
  cache: ReturnType<typeof longMemEvalExpansionCapabilityData>["sourceSnapshot"]["extractionCache"]
) {
  return {
    manifest_sha256: cache.manifestSha256,
    extraction_model: cache.extractionModel,
    model_family: cache.modelFamily,
    request_profile: cache.requestProfile,
    provider_url: cache.providerUrl,
    system_prompt_sha256: cache.systemPromptSha256,
    cache_key_algo: cache.cacheKeyAlgo,
    dataset: cache.dataset,
    dataset_revision: cache.datasetRevision,
    window_offset: cache.windowOffset,
    window_limit: cache.windowLimit,
    expected_turns: cache.expectedTurns,
    expected_key_set_sha256: cache.expectedKeySetSha256,
    content_closure_sha256: cache.contentClosureSha256,
    ...(cache.supplementalSourceBindingSha256 === undefined ? {} : {
      supplemental_source_binding_sha256: cache.supplementalSourceBindingSha256
    })
  };
}

function assertTargetCacheContinuity(
  data: ReturnType<typeof longMemEvalExpansionCapabilityData>,
  completion: ExtractionFillCompletion,
  manifest: ExtractionCacheManifest
): asserts manifest is Extract<ExtractionCacheManifest, { readonly schema_version: 3 }> {
  const source = data.sourceSnapshot.extractionCache;
  if (manifest.schema_version !== 3 || manifest.fill_status !== "complete" ||
      manifest.extraction_model !== source.extractionModel ||
      manifest.model_family !== source.modelFamily ||
      manifest.request_profile !== source.requestProfile ||
      redactProvenanceUrl(manifest.provider_url) !== source.providerUrl ||
      manifest.system_prompt_sha256 !== source.systemPromptSha256 ||
      manifest.cache_key_algo !== source.cacheKeyAlgo ||
      manifest.dataset !== source.dataset ||
      manifest.dataset_revision !== data.nextSelection.dataset_sha256 ||
      manifest.window_offset !== 0 || manifest.window_limit !== 500 ||
      manifest.expected_turns !== completion.expectedTurns ||
      manifest.expected_key_set_sha256 !== completion.expectedKeySetSha256 ||
      computeSupplementalSourceBindingSha256(
        manifest.supplemental_source_receipt,
        redactProvenanceUrl
      ) !== source.supplementalSourceBindingSha256 ||
      manifest.content_closure_sha256 !== completion.contentClosureSha256) {
    throw new Error("500Q target cache does not preserve source extraction identity");
  }
}

function targetCacheLineage(
  manifest: Extract<ExtractionCacheManifest, { readonly schema_version: 3 }>,
  completion: ExtractionFillCompletion
) {
  return {
    extraction_model: manifest.extraction_model,
    model_family: manifest.model_family,
    request_profile: manifest.request_profile,
    provider_url: redactProvenanceUrl(manifest.provider_url),
    system_prompt_sha256: manifest.system_prompt_sha256,
    cache_key_algo: manifest.cache_key_algo,
    dataset: manifest.dataset,
    dataset_revision: manifest.dataset_revision,
    window_offset: 0,
    window_limit: 500,
    expected_turns: completion.expectedTurns,
    expected_key_set_sha256: completion.expectedKeySetSha256,
    content_closure_sha256: completion.contentClosureSha256,
    ...(manifest.supplemental_source_receipt === undefined ? {} : {
      supplemental_source_binding_sha256: computeSupplementalSourceBindingSha256(
        manifest.supplemental_source_receipt,
        redactProvenanceUrl
      )
    })
  };
}
