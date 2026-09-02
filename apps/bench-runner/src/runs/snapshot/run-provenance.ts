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
  isLongMemEvalRunProvenanceSummaryGateEligible,
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
  if (provenance.schema_version !== 2) {
    return LongMemEvalSnapshotRunProvenanceSchema.parse({
      ...provenance,
      extraction_cache: extractionCache
    });
  }
  const substrate = cache.content_closure_sha256 ?? cache.expected_key_set_sha256;
  if (typeof substrate !== "string" || provenance.ingestion_mode === undefined) {
    throw new Error("compact run provenance v2 requires substrate and ingestion_mode");
  }
  if (provenance.ingestion_mode === "lazy_field" &&
      provenance.semantic_overlay_identity === undefined) {
    throw new Error("lazy_field compact provenance requires semantic_overlay_identity");
  }
  return LongMemEvalSnapshotRunProvenanceSchema.parse({
    ...provenance,
    compact_run_identity: compactRunIdentity({
      substrateIdentity: substrate,
      ingestionMode: provenance.ingestion_mode,
      overlayIdentity: provenance.semantic_overlay_identity ?? substrate
    }),
    extraction_cache: extractionCache
  });
}

export function bindSnapshotRunProvenanceAuthority(
  provenance: LongMemEvalSnapshotRunProvenance,
  authority: SnapshotExtractionAuthority
): LongMemEvalRunProvenance {
  const cache = provenance.extraction_cache;
  if (cache?.schema_version !== EXTRACTION_CACHE_MANIFEST_VERSION) {
    throw new Error("snapshot run provenance has no current extraction summary");
  }
  assertSnapshotExtractionAuthorityBinding(authority, cache);
  const { compact_run_identity, ...rest } = provenance;
  if (provenance.schema_version === 1 && compact_run_identity !== undefined) {
    throw new Error("schema_version 1 cannot carry compact_run_identity");
  }
  if (provenance.schema_version === 2) {
    const substrate = cache.content_closure_sha256 ?? cache.expected_key_set_sha256;
    if (typeof substrate !== "string" || provenance.ingestion_mode === undefined) {
      throw new Error("compact run provenance v2 requires substrate and ingestion_mode");
    }
    const expected = compactRunIdentity({
      substrateIdentity: substrate,
      ingestionMode: provenance.ingestion_mode,
      overlayIdentity: provenance.semantic_overlay_identity ?? substrate
    });
    if (compact_run_identity !== expected) {
      throw new Error("compact_run_identity does not match substrate and ingestion_mode");
    }
  }
  return LongMemEvalRunProvenanceSchema.parse({
    ...rest,
    extraction_cache: {
      ...cache,
      content_closure_index: authority.content_closure_index
    }
  });
}

export function isSnapshotRunProvenanceSummaryGateEligible(
  provenance: LongMemEvalSnapshotRunProvenance
): boolean {
  return isLongMemEvalRunProvenanceSummaryGateEligible(provenance);
}
