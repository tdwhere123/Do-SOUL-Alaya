import { z } from "zod";
import type { LongMemEvalRunOptions } from "../runner.js";
import { resolveEffectiveExtractionCacheRoot } from
  "../compile-seed/compile-seed-config.js";
import {
  EXTRACTION_CACHE_MANIFEST_VERSION,
  EXTRACTION_REQUEST_PROFILES,
  readExtractionCacheManifestIdentity
} from "../extraction/cache/extraction-cache-manifest.js";
import { EXTRACTION_FILL_AUTHORITY_SCHEMA_FIELDS } from
  "../extraction/fill/fill-authority.js";
import { LongMemEvalExpansionLineageSchema } from
  "../promotion/expansion/lineage/expansion-lineage-schema.js";
import { LongMemEvalExpansionSourceAnchorSchema } from
  "../promotion/expansion/lineage/expansion-source-anchor-schema.js";
import {
  redactSupplementalSourceBinding,
  SupplementalSourceProvenanceBindingSchema
} from "../extraction/cache/supplemental-source-receipt.js";
import { redactProvenanceUrl } from "./paired-environment.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const ExtractionCacheIdentityBaseSchema = z.object({
  manifest_sha256: Sha256Schema,
  extraction_model: z.string().min(1),
  provider_url: z.string().min(1),
  system_prompt_sha256: Sha256Schema,
  cache_key_algo: z.string().min(1),
  dataset: z.string().min(1),
  dataset_revision: z.string().min(1),
  requested_turns: z.number().int().nonnegative().optional(),
  cached_turns: z.number().int().nonnegative().optional(),
  coverage: z.number().min(0).max(1).optional(),
  storage: z.enum(["git-tracked", "archive"]),
  archive_url: z.string().min(1).optional(),
  archive_sha256: Sha256Schema.optional(),
  built_at: z.string().min(1),
  builder: z.string().min(1)
}).strict();

export const ExtractionCacheIdentitySchema = z.discriminatedUnion("schema_version", [
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
    ...EXTRACTION_FILL_AUTHORITY_SCHEMA_FIELDS
  }).strict()
]);

export type ExtractionCacheIdentity = z.infer<typeof ExtractionCacheIdentitySchema>;

export function readExtractionCacheIdentity(
  opts: LongMemEvalRunOptions,
  env: Readonly<Record<string, string | undefined>>
): ExtractionCacheIdentity | null {
  const cacheRoot = resolveEffectiveExtractionCacheRoot(opts.extractionCacheRoot, env);
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity === undefined) return null;
  const { manifest } = identity;
  return ExtractionCacheIdentitySchema.parse({
    manifest_sha256: identity.manifestSha256,
    ...manifest,
    provider_url: redactProvenanceUrl(manifest.provider_url),
    ...(manifest.supplemental_source_receipt === undefined ? {} : {
      supplemental_source_receipt: redactSupplementalSourceBinding(
        manifest.supplemental_source_receipt,
        redactProvenanceUrl
      )
    }),
    ...(manifest.archive_url === undefined ? {} : {
      archive_url: redactProvenanceUrl(manifest.archive_url)
    })
  });
}
