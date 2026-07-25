import {
  hashLongMemEvalSupplementalSourceBinding,
  type LongMemEvalSupplementalSourceReceiptExtensionWire
} from "@do-soul/alaya-eval/internal";
import { isDeepStrictEqual } from "node:util";
import type { ExtractionCacheManifest } from "../../cache/extraction-cache-manifest.js";
import { computeSupplementalSourceBindingSha256 } from
  "../../cache/supplemental-source-receipt.js";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import type { ExtractionFillCompletion } from "../../fill/fill-completion.js";
import type { LongMemEvalExpansionCapability } from
  "../../../promotion/expansion/expansion-capability.js";
import {
  assertLongMemEvalExpansionLineageMatchesCapability,
  buildLongMemEvalExpansionLineage
} from "../../../promotion/expansion/lineage/expansion-lineage.js";
import type { LongMemEvalExpansionSourceAnchor } from
  "../../../promotion/expansion/lineage/expansion-source-anchor-schema.js";
import { redactProvenanceUrl } from "../../../provenance/paired-environment.js";

export function assertExpansionTargetManifestState(
  manifest: ExtractionCacheManifest,
  anchor: LongMemEvalExpansionSourceAnchor,
  completion: ExtractionFillCompletion,
  capability: LongMemEvalExpansionCapability
): void {
  if (manifest.schema_version !== 3 || manifest.fill_status === undefined ||
      manifest.expansion_source_anchor === undefined) {
    throw invariant("resumed target lacks its live-verifiable source anchor");
  }
  if (manifest.fill_status === "in_progress") {
    assertTargetManifestIdentity(manifest, anchor, completion);
    if (manifest.expansion_lineage === undefined) return;
    throw invariant("in-progress target cannot claim completed expansion lineage");
  }
  const lineage = assertLongMemEvalExpansionLineageMatchesCapability(
    manifest.expansion_lineage,
    capability
  );
  assertTargetManifestIdentity(
    manifest,
    anchor,
    completion,
    lineage.supplemental_source_receipt_extension
  );
  const expected = buildLongMemEvalExpansionLineage(
    capability,
    completion,
    manifest,
    lineage.supplemental_source_receipt_extension
  );
  if (!isDeepStrictEqual(lineage, expected)) {
    throw invariant("completed target lineage differs from live cache closure");
  }
}

function assertTargetManifestIdentity(
  manifest: Extract<ExtractionCacheManifest, { readonly schema_version: 3 }>,
  anchor: LongMemEvalExpansionSourceAnchor,
  completion: ExtractionFillCompletion,
  extension?: LongMemEvalSupplementalSourceReceiptExtensionWire
): void {
  const target = anchor.target_cache;
  const expectedSupplementalBinding = extension === undefined
    ? target.supplemental_source_binding_sha256
    : hashLongMemEvalSupplementalSourceBinding(extension.target_binding);
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
      computeSupplementalSourceBindingSha256(
        manifest.supplemental_source_receipt,
        redactProvenanceUrl
      ) !== expectedSupplementalBinding ||
      manifest.requested_turns !== completion.expectedTurns ||
      manifest.cached_turns !== completion.validTurns ||
      manifest.coverage !== completion.coverage ||
      completion.invalidTurns !== 0 || completion.orphanTurns !== 0) {
    throw invariant("resumed target manifest differs from live partial cache state");
  }
}

function invariant(message: string): ExtractionCacheInvariantError {
  return new ExtractionCacheInvariantError(`500Q expansion refused: ${message}`);
}
