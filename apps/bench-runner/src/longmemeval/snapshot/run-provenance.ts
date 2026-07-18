import { z } from "zod";
import {
  EXTRACTION_CACHE_MANIFEST_VERSION,
  EXTRACTION_REQUEST_PROFILES
} from "../extraction/cache/extraction-cache-manifest.js";
import { EXTRACTION_FILL_IDENTITY_SCHEMA_FIELDS } from
  "../extraction/fill/fill-authority.js";
import {
  LongMemEvalRunProvenanceSchema,
  isLongMemEvalRunProvenanceSummaryGateEligible,
  type LongMemEvalRunProvenance
} from "../provenance/run.js";
import { ExtractionCacheIdentityBaseSchema } from
  "../provenance/extraction-cache-identity.js";
import { LongMemEvalExpansionLineageSchema } from
  "../promotion/expansion/lineage/expansion-lineage-schema.js";
import { LongMemEvalExpansionSourceAnchorSchema } from
  "../promotion/expansion/lineage/expansion-source-anchor-schema.js";
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
  LongMemEvalRunProvenanceSchema.extend({
    extraction_cache: SnapshotExtractionCacheIdentitySchema.nullable()
  }).strict();

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
  return LongMemEvalSnapshotRunProvenanceSchema.parse({
    ...provenance,
    extraction_cache: {
      ...summary,
      ...(summary.supplemental_source_receipt === undefined ? {} : {
        supplemental_source_receipt: redactSupplementalSourceBinding(
          summary.supplemental_source_receipt,
          redactProvenanceUrl
        )
      })
    }
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
  return LongMemEvalRunProvenanceSchema.parse({
    ...provenance,
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
