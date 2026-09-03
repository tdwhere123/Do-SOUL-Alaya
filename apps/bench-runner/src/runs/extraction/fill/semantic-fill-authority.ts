import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  buildOfficialApiSourceAssertions,
  computeOfficialApiSourceCorpusIdentity,
  OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
  OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION,
  OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
  OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
  OFFICIAL_API_SYSTEM_PROMPT
} from "@do-soul/alaya-soul";
import { computeCacheKey } from "../../compile-seed/cache/cache-key.js";
import type { SemanticFillTask } from "./semantic-fill-executor.js";
import {
  SemanticSubstrateManifestAuthoritySchema,
  SemanticTaskSourceAuthoritySchema,
  type SemanticSubstrateManifestAuthority,
  type SemanticTaskSourceAuthority
} from "../cache/semantic-artifact/source-authority.js";

export {
  SemanticSubstrateManifestAuthoritySchema,
  SemanticTaskSourceAuthoritySchema,
  type SemanticSubstrateManifestAuthority,
  type SemanticTaskSourceAuthority
};

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/u);

export const SemanticRunSourceAuthoritySchema = z.object({
  datasetRevision: Hex64,
  substrateManifest: SemanticSubstrateManifestAuthoritySchema,
  sourceCorpora: z.array(z.object({
    sourceCorpusIdentity: Hex64,
    substrateCacheKeys: z.array(Hex64).min(1).readonly()
  }).strict().readonly()).min(1).readonly()
}).strict().readonly().superRefine((authority, ctx) => {
  if (authority.datasetRevision !== authority.substrateManifest.datasetRevision) {
    ctx.addIssue({ code: "custom", message: "lazy semantic dataset authority mismatch" });
  }
  const canonical = normalizedSourceCorpora(authority.sourceCorpora);
  if (!isDeepStrictEqual(authority.sourceCorpora, canonical)) {
    ctx.addIssue({ code: "custom", message: "lazy semantic source corpus authority is not canonical" });
  }
  // Demand is a windowed subset of the pinned F0-F2 keyset. Equality with
  // expectedTurns would force packing empty-work turns that mint no tasks.
  const cacheKeys = canonical.flatMap((entry) => entry.substrateCacheKeys);
  if (new Set(cacheKeys).size !== cacheKeys.length) {
    ctx.addIssue({ code: "custom", message: "lazy semantic source corpus cache keys are not unique" });
  }
});

export type SemanticRunSourceAuthority = z.infer<typeof SemanticRunSourceAuthoritySchema>;

export function captureSemanticRunSourceAuthority(
  tasks: readonly SemanticFillTask[]
): SemanticRunSourceAuthority {
  if (tasks.length === 0) throw new Error("lazy semantic authority requires nonempty demand");
  const first = SemanticTaskSourceAuthoritySchema.parse(tasks[0]!.sourceAuthority);
  const byCorpus = new Map<string, readonly string[]>();
  for (const task of tasks) {
    const authority = SemanticTaskSourceAuthoritySchema.parse(task.sourceAuthority);
    if (task.binding.datasetRevision !== authority.datasetRevision ||
        !isDeepStrictEqual(authority.substrateManifest, first.substrateManifest)) {
      throw new Error("semantic demand contains foreign dataset or substrate authority");
    }
    const corpus = task.binding.sourceCorpusIdentity;
    const expectedCacheKeys = computeSemanticSourceCorpusCacheKeys(
      task.sourceCorpus, authority.substrateManifest
    );
    if (!sameStrings(expectedCacheKeys, authority.substrateCacheKeys)) {
      throw new Error("semantic demand contains foreign source corpus authority");
    }
    const prior = byCorpus.get(corpus);
    if (prior !== undefined && !sameStrings(prior, authority.substrateCacheKeys)) {
      throw new Error("semantic demand source corpus has conflicting substrate cache authority");
    }
    byCorpus.set(corpus, authority.substrateCacheKeys);
  }
  return SemanticRunSourceAuthoritySchema.parse({
    datasetRevision: first.datasetRevision,
    substrateManifest: first.substrateManifest,
    sourceCorpora: normalizedSourceCorpora([...byCorpus].map(([
      sourceCorpusIdentity, substrateCacheKeys
    ]) => ({ sourceCorpusIdentity, substrateCacheKeys })))
  });
}

export function computeSemanticSourceCorpusCacheKeys(
  sourceCorpus: string,
  substrate: SemanticSubstrateManifestAuthority
): readonly string[] {
  if (digest(OFFICIAL_API_SYSTEM_PROMPT) !== substrate.systemPromptSha256) {
    throw new Error("semantic source corpus cannot bind the current substrate prompt authority");
  }
  const assertions = buildOfficialApiSourceAssertions(sourceCorpus);
  const batchCount = Math.ceil(
    assertions.length / OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH
  );
  if (batchCount < 1) throw new Error("semantic source corpus has no extraction request authority");
  const keys: string[] = [];
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const request = {
      schema_version: OFFICIAL_API_EXTRACTION_REQUEST_SCHEMA_VERSION,
      source_locator_contract_version: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
      batch_contract_version: OFFICIAL_API_EXTRACTION_BATCH_CONTRACT_VERSION,
      source_corpus_identity: computeOfficialApiSourceCorpusIdentity(sourceCorpus),
      batch_index: batchIndex,
      batch_count: batchCount,
      source_assertions: assertions.slice(
        batchIndex * OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
        (batchIndex + 1) * OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH
      )
    };
    keys.push(computeCacheKey(
      substrate.extractionModel,
      substrate.requestProfile as Parameters<typeof computeCacheKey>[1],
      OFFICIAL_API_SYSTEM_PROMPT,
      JSON.stringify(request)
    ));
  }
  return Object.freeze(keys.sort());
}

export function buildSemanticSubstrateManifestAuthority(input: {
  readonly manifestSha256: string;
  readonly manifest: {
    readonly schema_version: number;
    readonly dataset: string;
    readonly dataset_revision: string;
    readonly extraction_model: string;
    readonly model_family?: string;
    readonly request_profile?: string;
    readonly system_prompt_sha256: string;
    readonly cache_key_algo: string;
    readonly expected_turns?: number;
    readonly expected_key_set_sha256?: string;
    readonly content_closure_sha256?: string;
    readonly content_closure_index?: Readonly<Record<string, readonly [string, number, number]>>;
    readonly window_offset?: number;
    readonly window_limit?: number;
  };
}): SemanticSubstrateManifestAuthority {
  const manifest = input.manifest;
  if (manifest.schema_version !== 3 || manifest.model_family === undefined ||
      manifest.request_profile === undefined || manifest.expected_turns === undefined ||
      manifest.expected_key_set_sha256 === undefined ||
      manifest.content_closure_sha256 === undefined ||
      manifest.content_closure_index === undefined || manifest.window_offset === undefined ||
      manifest.window_limit === undefined) {
    throw new Error("lazy semantic fill requires complete F0-F2 substrate manifest authority");
  }
  return SemanticSubstrateManifestAuthoritySchema.parse({
    schemaVersion: 3,
    manifestSha256: input.manifestSha256,
    dataset: manifest.dataset,
    datasetRevision: manifest.dataset_revision,
    extractionModel: manifest.extraction_model,
    modelFamily: manifest.model_family,
    requestProfile: manifest.request_profile,
    systemPromptSha256: manifest.system_prompt_sha256,
    cacheKeyAlgorithm: manifest.cache_key_algo,
    expectedTurns: manifest.expected_turns,
    expectedKeySetSha256: manifest.expected_key_set_sha256,
    contentClosureSha256: manifest.content_closure_sha256,
    contentClosureIndexSha256: digest(JSON.stringify(manifest.content_closure_index)),
    windowOffset: manifest.window_offset,
    windowLimit: manifest.window_limit
  });
}

export function assertLazySemanticAuthorityMatchesExtraction(input: {
  readonly receipt: { readonly sourceAuthority: SemanticRunSourceAuthority };
  readonly extraction: {
    readonly schema_version: number;
    readonly manifest_sha256: string;
    readonly dataset: string;
    readonly dataset_revision: string;
    readonly extraction_model: string;
    readonly model_family?: string;
    readonly request_profile?: string;
    readonly system_prompt_sha256: string;
    readonly cache_key_algo: string;
    readonly expected_turns?: number;
    readonly expected_key_set_sha256?: string;
    readonly content_closure_sha256?: string;
    readonly content_closure_index?: Readonly<Record<string, readonly [string, number, number]>>;
    readonly window_offset?: number;
    readonly window_limit?: number;
  } | null;
  readonly datasetSha256?: string;
}): void {
  if (input.extraction === null) {
    throw new Error("lazy semantic provenance requires current extraction substrate authority");
  }
  const expected = buildSemanticSubstrateManifestAuthority({
    manifestSha256: input.extraction.manifest_sha256,
    manifest: input.extraction
  });
  const actual = SemanticRunSourceAuthoritySchema.parse(input.receipt.sourceAuthority);
  if (!isDeepStrictEqual(actual.substrateManifest, expected)) {
    throw new Error("lazy semantic receipt has foreign snapshot or substrate authority");
  }
  if (actual.datasetRevision !== input.extraction.dataset_revision ||
      (input.datasetSha256 !== undefined && actual.datasetRevision !== input.datasetSha256)) {
    throw new Error("lazy semantic receipt has foreign dataset authority");
  }
  const actualKeys = normalized(actual.sourceCorpora.flatMap((entry) => entry.substrateCacheKeys));
  assertDemandKeysAreSubstrateMembers(
    actualKeys,
    Object.keys(input.extraction.content_closure_index ?? {})
  );
}

export function assertDemandKeysAreSubstrateMembers(
  demandKeys: readonly string[],
  substrateKeys: readonly string[]
): void {
  const allowed = new Set(substrateKeys);
  if (demandKeys.some((key) => !allowed.has(key))) {
    throw new Error("lazy semantic receipt has foreign source corpus substrate authority");
  }
}

function normalizedSourceCorpora(
  entries: readonly Readonly<{
    sourceCorpusIdentity: string;
    substrateCacheKeys: readonly string[];
  }>[]
): readonly Readonly<{ sourceCorpusIdentity: string; substrateCacheKeys: readonly string[] }>[] {
  return entries.map((entry) => ({
    sourceCorpusIdentity: entry.sourceCorpusIdentity,
    substrateCacheKeys: normalized(entry.substrateCacheKeys)
  })).sort((left, right) => left.sourceCorpusIdentity.localeCompare(right.sourceCorpusIdentity));
}

function normalized(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function substrateAuthorityIdentity(
  manifest: SemanticSubstrateManifestAuthority
): string {
  return digest([
    "alaya.semantic_substrate_authority.v1",
    manifest.manifestSha256,
    manifest.dataset,
    manifest.datasetRevision,
    manifest.extractionModel,
    manifest.modelFamily,
    manifest.requestProfile,
    manifest.systemPromptSha256,
    manifest.cacheKeyAlgorithm,
    String(manifest.expectedTurns),
    manifest.expectedKeySetSha256,
    manifest.contentClosureSha256,
    manifest.contentClosureIndexSha256,
    String(manifest.windowOffset),
    String(manifest.windowLimit)
  ].join("\u0000"));
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
