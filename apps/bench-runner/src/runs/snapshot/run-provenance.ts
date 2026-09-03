import { z } from "zod";
import {
  EXTRACTION_CACHE_MANIFEST_VERSION,
  EXTRACTION_REQUEST_PROFILES
} from "../extraction/cache/extraction-cache-manifest.js";
import { EXTRACTION_FILL_IDENTITY_SCHEMA_FIELDS } from
  "../extraction/fill/fill-authority.js";
import {
  LongMemEvalRunProvenanceObjectSchema,
  LongMemEvalRunProvenanceSchema,
  refineRunProvenanceIngestionMode,
  bindVerifiedLazyReceiptToRunProvenance,
  isLongMemEvalRunProvenanceSummaryGateEligible,
  unwrapVerifiedLazyReceiptForRunProvenance,
  type LongMemEvalRunProvenance
} from "../provenance/run.js";
import { ExtractionCacheIdentityBaseSchema } from
  "../provenance/identity/extraction-cache-identity.js";
import { LongMemEvalExpansionLineageSchema } from
  "../../datasets/longmemeval/promotion/expansion/lineage/expansion-lineage-schema.js";
import { LongMemEvalExpansionSourceAnchorSchema } from
  "../../datasets/longmemeval/promotion/expansion/lineage/expansion-source-anchor-schema.js";
import {
  redactSupplementalSourceBinding,
  SupplementalSourceProvenanceBindingSchema
} from
  "../extraction/cache/supplemental-source-receipt.js";
import { redactProvenanceUrl } from "../provenance/paired-environment.js";
import {
  assertSnapshotExtractionAuthorityBinding,
  type SnapshotExtractionAuthority
} from "./extraction-authority.js";
import { compactRunIdentity } from "./ingestion-mode.js";
import { assertLazySemanticAuthorityMatchesExtraction } from
  "../extraction/fill/semantic-fill-authority.js";
import type { VerifiedLazySemanticRunReceipt } from
  "../extraction/fill/semantic-fill-receipt.js";

const SnapshotExtractionCacheIdentitySchema = z.discriminatedUnion(
  "schema_version",
  [
    ExtractionCacheIdentityBaseSchema.extend({
      schema_version: z.literal(1),
      model_family: z.never().optional(),
      request_profile: z.never().optional()
    }).strict(),
    ExtractionCacheIdentityBaseSchema.extend({
      schema_version: z.literal(2),
      model_family: z.string().min(1),
      request_profile: z.never().optional()
    }).strict(),
    ExtractionCacheIdentityBaseSchema.extend({
      schema_version: z.literal(EXTRACTION_CACHE_MANIFEST_VERSION),
      model_family: z.string().min(1),
      request_profile: z.enum(EXTRACTION_REQUEST_PROFILES),
      supplemental_source_receipt: SupplementalSourceProvenanceBindingSchema.optional(),
      expansion_source_anchor: LongMemEvalExpansionSourceAnchorSchema.optional(),
      expansion_lineage: LongMemEvalExpansionLineageSchema.optional(),
      ...EXTRACTION_FILL_IDENTITY_SCHEMA_FIELDS
    }).strict()
  ]
);

export const LongMemEvalSnapshotRunProvenanceSchema =
  LongMemEvalRunProvenanceObjectSchema.extend({
    extraction_cache: SnapshotExtractionCacheIdentitySchema.nullable(),
    compact_run_identity: z.string().regex(/^[a-f0-9]{64}$/u).optional()
  }).strict().superRefine(refineRunProvenanceIngestionMode);

export type LongMemEvalSnapshotRunProvenance = z.infer<
  typeof LongMemEvalSnapshotRunProvenanceSchema
>;

export function compactSnapshotRunProvenance(
  provenance: LongMemEvalRunProvenance
): LongMemEvalSnapshotRunProvenance {
  const captured = freezeSnapshotProvenancePremises(provenance);
  if (captured.lazySemanticRun !== undefined) {
    unwrapVerifiedLazyReceiptForRunProvenance(provenance);
  }
  const cache = provenance.extraction_cache;
  if (cache?.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION) {
    throw new Error("current snapshot requires current extraction run provenance");
  }
  const { content_closure_index: _contentClosureIndex, ...summary } = cache;
  const extractionCache = {
    ...summary,
    ...(summary.supplemental_source_receipt === undefined ? {} : {
      supplemental_source_receipt: redactSupplementalSourceBinding(
        summary.supplemental_source_receipt,
        redactProvenanceUrl
      )
    })
  };
  if (captured.schemaVersion !== 2) {
    return LongMemEvalSnapshotRunProvenanceSchema.parse({
      ...provenance,
      ...capturedIngestionFields(captured),
      extraction_cache: extractionCache
    });
  }
  const substrate = cache.content_closure_sha256 ?? cache.expected_key_set_sha256;
  if (typeof substrate !== "string" || captured.ingestionMode === undefined) {
    throw new Error("compact run provenance v2 requires substrate and ingestion_mode");
  }
  if (captured.ingestionMode === "lazy_field" &&
      captured.overlayIdentity === undefined) {
    throw new Error("lazy_field compact provenance requires semantic_overlay_identity");
  }
  return LongMemEvalSnapshotRunProvenanceSchema.parse({
    ...provenance,
    ...capturedIngestionFields(captured),
    compact_run_identity: compactRunIdentity({
      substrateIdentity: substrate,
      ingestionMode: captured.ingestionMode,
      overlayIdentity: captured.overlayIdentity ?? substrate,
      ...(captured.lazyRunIdentity === undefined
        ? {}
        : { lazyRunIdentity: captured.lazyRunIdentity })
    }),
    extraction_cache: extractionCache
  });
}

export function bindSnapshotRunProvenanceAuthority(
  provenance: LongMemEvalSnapshotRunProvenance,
  authority: SnapshotExtractionAuthority,
  lazyReceiptHandle?: VerifiedLazySemanticRunReceipt
): LongMemEvalRunProvenance {
  const captured = freezeSnapshotProvenancePremises(provenance);
  const capturedHandle = lazyReceiptHandle;
  if (captured.lazySemanticRun !== undefined && capturedHandle === undefined) {
    throw new Error("persisted lazy snapshot provenance requires a verified receipt loader handle");
  }
  if (captured.lazySemanticRun === undefined && capturedHandle !== undefined) {
    throw new Error("snapshot provenance cannot attach a lazy receipt handle without a receipt");
  }
  const cache = captured.extractionCache;
  if (cache?.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION) {
    throw new Error("snapshot run provenance has no current extraction summary");
  }
  assertSnapshotExtractionAuthorityBinding(authority, cache);
  const { compact_run_identity: _compactRunIdentity, ...rest } = provenance;
  assertCompactRunIdentityBinding(provenance);
  const full = LongMemEvalRunProvenanceSchema.parse({
    ...rest,
    ...capturedIngestionFields(captured),
    extraction_cache: {
      ...cache,
      content_closure_index: authority.content_closure_index
    }
  });
  if (capturedHandle === undefined) return full;
  const receipt = bindVerifiedLazyReceiptToRunProvenance(full, capturedHandle)
    .lazy_semantic_run!;
  assertLazySemanticAuthorityMatchesExtraction({
    receipt,
    extraction: {
      schema_version: authority.source_manifest_schema_version,
      manifest_sha256: authority.source_manifest_sha256,
      dataset: authority.dataset,
      dataset_revision: authority.dataset_revision,
      extraction_model: authority.extraction_model,
      model_family: authority.model_family,
      request_profile: authority.request_profile,
      system_prompt_sha256: authority.system_prompt_sha256,
      cache_key_algo: authority.cache_key_algo,
      expected_turns: authority.expected_turns,
      expected_key_set_sha256: authority.expected_key_set_sha256,
      content_closure_sha256: authority.content_closure_sha256,
      content_closure_index: authority.content_closure_index,
      window_offset: authority.window_offset,
      window_limit: authority.window_limit
    },
    ...(full.dataset_sha256 === undefined ? {} : { datasetSha256: full.dataset_sha256 })
  });
  return full;
}

function freezeSnapshotProvenancePremises(
  provenance: Pick<LongMemEvalSnapshotRunProvenance,
    "schema_version" | "ingestion_mode" | "semantic_overlay_identity" | "lazy_semantic_run" |
    "extraction_cache">
) {
  const lazySemanticRun = provenance.lazy_semantic_run === undefined
    ? undefined
    : structuredClone(provenance.lazy_semantic_run);
  const extractionCache = provenance.extraction_cache === undefined ||
    provenance.extraction_cache === null
    ? provenance.extraction_cache
    : structuredClone(provenance.extraction_cache);
  return Object.freeze({
    schemaVersion: provenance.schema_version,
    ingestionMode: provenance.ingestion_mode,
    overlayIdentity: provenance.semantic_overlay_identity,
    lazySemanticRun,
    lazyRunIdentity: lazySemanticRun?.runIdentity,
    extractionCache
  });
}

function capturedIngestionFields(
  captured: ReturnType<typeof freezeSnapshotProvenancePremises>
) {
  if (captured.schemaVersion === 1) {
    return { schema_version: 1 as const };
  }
  return {
    schema_version: 2 as const,
    ingestion_mode: captured.ingestionMode,
    ...(captured.overlayIdentity === undefined
      ? {}
      : { semantic_overlay_identity: captured.overlayIdentity }),
    ...(captured.lazySemanticRun === undefined
      ? {}
      : { lazy_semantic_run: captured.lazySemanticRun })
  };
}

export function isSnapshotRunProvenanceSummaryGateEligible(
  provenance: LongMemEvalSnapshotRunProvenance
): boolean {
  if (!matchesCompactRunIdentityBinding(provenance)) return false;
  return isLongMemEvalRunProvenanceSummaryGateEligible(provenance);
}

function matchesCompactRunIdentityBinding(
  provenance: LongMemEvalSnapshotRunProvenance
): boolean {
  const captured = freezeSnapshotProvenancePremises(provenance);
  const compactRunIdentityValue = provenance.compact_run_identity;
  if (captured.schemaVersion === 1) return compactRunIdentityValue === undefined;
  const expected = expectedCompactRunIdentity(captured);
  return expected !== undefined && compactRunIdentityValue === expected;
}

function expectedCompactRunIdentity(
  captured: ReturnType<typeof freezeSnapshotProvenancePremises>
): string | undefined {
  const cache = captured.extractionCache;
  if (cache?.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION) return undefined;
  const substrate = cache.content_closure_sha256 ?? cache.expected_key_set_sha256;
  if (typeof substrate !== "string" || captured.ingestionMode === undefined) {
    return undefined;
  }
  return compactRunIdentity({
    substrateIdentity: substrate,
    ingestionMode: captured.ingestionMode,
    overlayIdentity: captured.overlayIdentity ?? substrate,
    ...(captured.lazyRunIdentity === undefined
      ? {}
      : { lazyRunIdentity: captured.lazyRunIdentity })
  });
}

function assertCompactRunIdentityBinding(
  provenance: LongMemEvalSnapshotRunProvenance
): void {
  const captured = freezeSnapshotProvenancePremises(provenance);
  const compactRunIdentityValue = provenance.compact_run_identity;
  if (captured.schemaVersion === 1) {
    if (compactRunIdentityValue !== undefined) {
      throw new Error("schema_version 1 cannot carry compact_run_identity");
    }
    return;
  }
  const expected = expectedCompactRunIdentity(captured);
  if (expected === undefined) {
    throw new Error(
      captured.extractionCache?.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION
        ? "snapshot run provenance has no current extraction summary"
        : "compact run provenance v2 requires substrate and ingestion_mode"
    );
  }
  if (compactRunIdentityValue !== expected) {
    throw new Error("compact_run_identity does not match substrate and ingestion_mode");
  }
}
