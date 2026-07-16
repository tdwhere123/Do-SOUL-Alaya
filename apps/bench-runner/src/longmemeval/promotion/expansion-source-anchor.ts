import { isDeepStrictEqual } from "node:util";
import type { CompileSeedExtractionConfig } from "../compile-seed-types.js";
import type { ExtractionFillCompletion } from "../extraction/fill-completion.js";
import { redactProvenanceUrl } from "../provenance/paired-environment.js";
import {
  longMemEvalExpansionCapabilityData,
  type LongMemEvalExpansionCapability
} from "./expansion-capability.js";
import {
  expansionSourceCacheRecord,
  expansionSourceSnapshotRecord
} from "./expansion-lineage.js";
import {
  LongMemEvalExpansionSourceAnchorSchema,
  type LongMemEvalExpansionSourceAnchor
} from "./expansion-source-anchor-schema.js";

export function buildLongMemEvalExpansionSourceAnchor(
  capability: LongMemEvalExpansionCapability,
  config: CompileSeedExtractionConfig,
  target: ExtractionFillCompletion
): LongMemEvalExpansionSourceAnchor {
  const data = longMemEvalExpansionCapabilityData(capability);
  assertTargetExpectation(data, config, target);
  return LongMemEvalExpansionSourceAnchorSchema.parse({
    schema_version: 1,
    kind: "longmemeval_100_to_500_source_anchor",
    contract_sha256: data.contractSha256,
    policy_version: data.policyVersion,
    code: data.code,
    source_selection: data.sourceSelection,
    next_selection: data.nextSelection,
    matrix_sha256: data.matrix.sha256,
    product_default: data.productDefault,
    source_snapshot: expansionSourceSnapshotRecord(data.sourceSnapshot),
    source_cache: expansionSourceCacheRecord(data.sourceSnapshot.extractionCache),
    target_cache: targetExpectation(data, config, target)
  });
}

export function assertLongMemEvalExpansionSourceAnchor(
  anchor: unknown,
  capability: LongMemEvalExpansionCapability,
  config: CompileSeedExtractionConfig,
  target: ExtractionFillCompletion
): LongMemEvalExpansionSourceAnchor {
  const parsed = LongMemEvalExpansionSourceAnchorSchema.parse(anchor);
  const expected = buildLongMemEvalExpansionSourceAnchor(capability, config, target);
  if (!isDeepStrictEqual(parsed, expected)) {
    throw new Error("500Q expansion source anchor differs from live capability");
  }
  return parsed;
}

function assertTargetExpectation(
  data: ReturnType<typeof longMemEvalExpansionCapabilityData>,
  config: CompileSeedExtractionConfig,
  target: ExtractionFillCompletion
): void {
  const source = data.sourceSnapshot.extractionCache;
  if (config.model !== source.extractionModel ||
      (config.modelFamily ?? config.model) !== source.modelFamily ||
      config.requestProfile !== source.requestProfile ||
      redactProvenanceUrl(config.providerUrl) !== source.providerUrl ||
      target.invalidTurns !== 0 || target.orphanTurns !== 0 ||
      target.expectedTurns <= 0) {
    throw new Error("500Q target expectation would change source extraction identity");
  }
}

function targetExpectation(
  data: ReturnType<typeof longMemEvalExpansionCapabilityData>,
  config: CompileSeedExtractionConfig,
  target: ExtractionFillCompletion
) {
  const source = data.sourceSnapshot.extractionCache;
  return {
    extraction_model: config.model,
    model_family: config.modelFamily ?? config.model,
    request_profile: config.requestProfile,
    provider_url: redactProvenanceUrl(config.providerUrl),
    system_prompt_sha256: source.systemPromptSha256,
    cache_key_algo: source.cacheKeyAlgo,
    dataset: source.dataset,
    dataset_revision: data.nextSelection.dataset_sha256,
    window_offset: 0,
    window_limit: 500,
    expected_turns: target.expectedTurns,
    expected_key_set_sha256: target.expectedKeySetSha256
  };
}
