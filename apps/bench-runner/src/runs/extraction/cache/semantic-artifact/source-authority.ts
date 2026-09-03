import { z } from "zod";

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const NonEmpty = z.string().trim().min(1).max(512);

export const SemanticSubstrateManifestAuthoritySchema = z.object({
  schemaVersion: z.literal(3),
  manifestSha256: Hex64,
  dataset: NonEmpty,
  datasetRevision: Hex64,
  extractionModel: NonEmpty,
  modelFamily: NonEmpty,
  requestProfile: NonEmpty,
  systemPromptSha256: Hex64,
  cacheKeyAlgorithm: NonEmpty,
  expectedTurns: z.number().int().nonnegative(),
  expectedKeySetSha256: Hex64,
  contentClosureSha256: Hex64,
  contentClosureIndexSha256: Hex64,
  windowOffset: z.number().int().nonnegative(),
  windowLimit: z.number().int().nonnegative()
}).strict().readonly();

export type SemanticSubstrateManifestAuthority = z.infer<
  typeof SemanticSubstrateManifestAuthoritySchema
>;

export const SemanticTaskSourceAuthoritySchema = z.object({
  datasetRevision: Hex64,
  substrateManifest: SemanticSubstrateManifestAuthoritySchema,
  substrateCacheKeys: z.array(Hex64).min(1).readonly()
}).strict().readonly().superRefine((authority, ctx) => {
  if (authority.datasetRevision !== authority.substrateManifest.datasetRevision) {
    ctx.addIssue({ code: "custom", message: "semantic task dataset authority mismatch" });
  }
  if (!sameStrings(authority.substrateCacheKeys, canonicalStrings(authority.substrateCacheKeys))) {
    ctx.addIssue({ code: "custom", message: "semantic task substrate cache keys are not canonical" });
  }
});

export type SemanticTaskSourceAuthority = z.infer<typeof SemanticTaskSourceAuthoritySchema>;

export function canonicalSemanticSourceAuthority(
  authority: SemanticTaskSourceAuthority
): SemanticTaskSourceAuthority {
  const manifest = authority.substrateManifest;
  return {
    datasetRevision: authority.datasetRevision,
    substrateManifest: {
      schemaVersion: manifest.schemaVersion,
      manifestSha256: manifest.manifestSha256,
      dataset: manifest.dataset,
      datasetRevision: manifest.datasetRevision,
      extractionModel: manifest.extractionModel,
      modelFamily: manifest.modelFamily,
      requestProfile: manifest.requestProfile,
      systemPromptSha256: manifest.systemPromptSha256,
      cacheKeyAlgorithm: manifest.cacheKeyAlgorithm,
      expectedTurns: manifest.expectedTurns,
      expectedKeySetSha256: manifest.expectedKeySetSha256,
      contentClosureSha256: manifest.contentClosureSha256,
      contentClosureIndexSha256: manifest.contentClosureIndexSha256,
      windowOffset: manifest.windowOffset,
      windowLimit: manifest.windowLimit
    },
    substrateCacheKeys: [...authority.substrateCacheKeys]
  };
}

function canonicalStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
