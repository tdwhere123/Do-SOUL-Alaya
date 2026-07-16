import { isDeepStrictEqual } from "node:util";
import type { CompileSeedExtractionConfig } from "../compile-seed-types.js";
import type { ExtractionCacheManifest } from "../extraction-cache-manifest.js";
import {
  assertExtractionFillComplete,
  type ExtractionFillCompletion
} from "../extraction/fill-completion.js";
import type { LongMemEvalExpansionCapability } from "./expansion-capability.js";
import {
  assertLongMemEvalExpansionLineageMatchesCapability,
  buildLongMemEvalExpansionLineage
} from "./expansion-lineage.js";
import { assertLongMemEvalExpansionSourceAnchor } from
  "./expansion-source-anchor.js";

export function assertCompleteLongMemEvalExpansionCache(input: {
  readonly capability: LongMemEvalExpansionCapability;
  readonly manifest: ExtractionCacheManifest;
  readonly completion: ExtractionFillCompletion;
}): void {
  const { manifest, completion, capability } = input;
  assertExtractionFillComplete(completion);
  if (manifest.schema_version !== 3 || manifest.fill_status !== "complete" ||
      manifest.window_offset !== 0 || manifest.window_limit !== 500 ||
      manifest.expansion_source_anchor === undefined ||
      manifest.expansion_lineage === undefined ||
      manifest.requested_turns !== completion.expectedTurns ||
      manifest.cached_turns !== completion.validTurns || manifest.coverage !== 1 ||
      manifest.expected_turns !== completion.expectedTurns ||
      manifest.expected_key_set_sha256 !== completion.expectedKeySetSha256 ||
      manifest.content_closure_sha256 !== completion.contentClosureSha256) {
    throw new Error("500Q expansion cache manifest differs from live complete closure");
  }
  const config = extractionConfig(manifest);
  assertLongMemEvalExpansionSourceAnchor(
    manifest.expansion_source_anchor,
    capability,
    config,
    completion
  );
  const actual = assertLongMemEvalExpansionLineageMatchesCapability(
    manifest.expansion_lineage,
    capability
  );
  const expected = buildLongMemEvalExpansionLineage(capability, completion, manifest);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error("500Q expansion lineage differs from live target cache closure");
  }
}

function extractionConfig(
  manifest: Extract<ExtractionCacheManifest, { readonly schema_version: 3 }>
): CompileSeedExtractionConfig {
  return {
    providerUrl: manifest.provider_url,
    model: manifest.extraction_model,
    modelFamily: manifest.model_family,
    requestProfile: manifest.request_profile,
    apiKey: null
  };
}
