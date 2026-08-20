import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  buildLongMemEvalSupplementalSourceReceiptExtension,
  hashLongMemEvalSupplementalSourceBinding,
  LongMemEvalSupplementalSourceManifestBindingWireSchema,
  LongMemEvalSupplementalSourceProvenanceBindingWireSchema,
  type LongMemEvalSupplementalSourceReceiptExtensionWire
} from "@do-soul/alaya-eval/authority";
import { redactProvenanceUrl } from "../../provenance/paired-environment.js";
import {
  EXTRACTION_REQUEST_PROFILES,
  type ExtractionRequestProfile
} from "../request-profile.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SupplementalSourceShardSchema = z.object({
  cache_key: Sha256Schema,
  raw_json_sha256: Sha256Schema
}).strict().readonly();
const SupplementalSourceReceiptSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("longmemeval-extraction-supplemental-source"),
  created_at: z.string().min(1),
  physical_source: z.object({
    provider_url: z.string().min(1),
    model: z.string().min(1)
  }).strict().readonly(),
  logical_cache_identity: z.object({
    provider_url: z.string().min(1),
    model: z.string().min(1),
    request_profile: z.enum(EXTRACTION_REQUEST_PROFILES),
    system_prompt_sha256: Sha256Schema
  }).strict().readonly(),
  mapping_basis: z.literal("operator-attested-same-model-transport-alias"),
  shard_count: z.number().int().positive(),
  key_set_sha256: Sha256Schema,
  content_sha256: Sha256Schema,
  shards: z.array(SupplementalSourceShardSchema).min(1).readonly(),
  receipt_sha256: Sha256Schema
}).strict().readonly();

export interface SupplementalSourceShard {
  readonly cache_key: string;
  readonly raw_json_sha256: string;
}

export interface SupplementalSourceReceipt {
  readonly schema_version: 1;
  readonly kind: "longmemeval-extraction-supplemental-source";
  readonly created_at: string;
  readonly physical_source: {
    readonly provider_url: string;
    readonly model: string;
  };
  readonly logical_cache_identity: {
    readonly provider_url: string;
    readonly model: string;
    readonly request_profile: ExtractionRequestProfile;
    readonly system_prompt_sha256: string;
  };
  readonly mapping_basis: "operator-attested-same-model-transport-alias";
  readonly shard_count: number;
  readonly key_set_sha256: string;
  readonly content_sha256: string;
  readonly shards: readonly SupplementalSourceShard[];
  readonly receipt_sha256: string;
}

export const SupplementalSourceManifestBindingSchema =
  LongMemEvalSupplementalSourceManifestBindingWireSchema;
export const SupplementalSourceProvenanceBindingSchema =
  LongMemEvalSupplementalSourceProvenanceBindingWireSchema;

export type SupplementalSourceManifestBinding = z.infer<
  typeof SupplementalSourceManifestBindingSchema
>;
export type SupplementalSourceProvenanceBinding = z.infer<
  typeof SupplementalSourceProvenanceBindingSchema
>;

export function createSupplementalSourceReceipt(input: {
  readonly createdAt: string;
  readonly physicalProviderUrl: string;
  readonly physicalModel: string;
  readonly logicalProviderUrl: string;
  readonly logicalModel: string;
  readonly requestProfile: ExtractionRequestProfile;
  readonly systemPromptSha256: string;
  readonly shards: readonly SupplementalSourceShard[];
}): SupplementalSourceReceipt {
  const shards = [...input.shards].sort((left, right) =>
    left.cache_key.localeCompare(right.cache_key)
  );
  const unsigned = {
    schema_version: 1 as const,
    kind: "longmemeval-extraction-supplemental-source" as const,
    created_at: input.createdAt,
    physical_source: {
      provider_url: input.physicalProviderUrl,
      model: input.physicalModel
    },
    logical_cache_identity: {
      provider_url: input.logicalProviderUrl,
      model: input.logicalModel,
      request_profile: input.requestProfile,
      system_prompt_sha256: input.systemPromptSha256
    },
    mapping_basis: "operator-attested-same-model-transport-alias" as const,
    shard_count: shards.length,
    key_set_sha256: digest(shards.map((shard) => shard.cache_key).join("\n")),
    content_sha256: digest(shards.map((shard) =>
      `${shard.cache_key}\0${shard.raw_json_sha256}`
    ).join("\n")),
    shards
  };
  return Object.freeze({ ...unsigned, receipt_sha256: digest(JSON.stringify(unsigned)) });
}

export function parseSupplementalSourceReceipt(
  value: unknown,
  label: string
): SupplementalSourceReceipt {
  const parsed = SupplementalSourceReceiptSchema.parse(value);
  assertUniqueShardKeys(parsed.shards, label);
  const rebuilt = createSupplementalSourceReceipt({
    createdAt: parsed.created_at,
    physicalProviderUrl: parsed.physical_source.provider_url,
    physicalModel: parsed.physical_source.model,
    logicalProviderUrl: parsed.logical_cache_identity.provider_url,
    logicalModel: parsed.logical_cache_identity.model,
    requestProfile: parsed.logical_cache_identity.request_profile,
    systemPromptSha256: parsed.logical_cache_identity.system_prompt_sha256,
    shards: parsed.shards
  });
  if (!isDeepStrictEqual(parsed, rebuilt)) {
    throw new Error(`supplemental source receipt at ${label} has invalid digest inventory`);
  }
  return rebuilt;
}

export function buildSupplementalSourceReceiptExtension(
  sourceValue: unknown,
  targetValue: unknown,
  expectedLogicalIdentity: SupplementalSourceReceipt["logical_cache_identity"]
): LongMemEvalSupplementalSourceReceiptExtensionWire {
  const source = parseSupplementalSourceReceipt(sourceValue, "source receipt");
  const target = parseSupplementalSourceReceipt(targetValue, "target receipt");
  assertReceiptIdentityContinuity(source, target);
  if (!isDeepStrictEqual(source.logical_cache_identity, expectedLogicalIdentity)) {
    throw new Error("supplemental source receipt differs from logical cache identity");
  }
  const targetByKey = new Map(target.shards.map((shard) => [shard.cache_key, shard]));
  for (const shard of source.shards) {
    if (targetByKey.get(shard.cache_key)?.raw_json_sha256 !== shard.raw_json_sha256) {
      throw new Error("target supplemental receipt does not contain the source receipt");
    }
  }
  const sourceKeys = new Set(source.shards.map((shard) => shard.cache_key));
  const addedShards = target.shards.filter((shard) => !sourceKeys.has(shard.cache_key));
  return buildLongMemEvalSupplementalSourceReceiptExtension({
    source_binding: provenanceBinding(source),
    target_binding: provenanceBinding(target),
    source_shards: source.shards,
    added_shards: addedShards
  });
}

export function supplementalSourceManifestBinding(
  receipt: SupplementalSourceReceipt
): SupplementalSourceManifestBinding {
  return Object.freeze({
    kind: receipt.kind,
    receipt_sha256: receipt.receipt_sha256,
    shard_count: receipt.shard_count,
    key_set_sha256: receipt.key_set_sha256,
    physical_provider_url: receipt.physical_source.provider_url,
    physical_model: receipt.physical_source.model
  });
}

export function redactSupplementalSourceBinding(
  binding: SupplementalSourceManifestBinding | SupplementalSourceProvenanceBinding,
  redactProviderUrl: (value: string) => string
): SupplementalSourceProvenanceBinding {
  if (SupplementalSourceProvenanceBindingSchema.safeParse(binding).success) {
    return SupplementalSourceProvenanceBindingSchema.parse(binding);
  }
  return SupplementalSourceProvenanceBindingSchema.parse({
    ...binding,
    physical_provider_url: redactProviderUrl(binding.physical_provider_url)
  });
}

export function computeSupplementalSourceBindingSha256(
  binding: SupplementalSourceManifestBinding | SupplementalSourceProvenanceBinding |
    undefined,
  redactProviderUrl: (value: string) => string
): string | undefined {
  if (binding === undefined) return undefined;
  return hashLongMemEvalSupplementalSourceBinding(
    redactSupplementalSourceBinding(binding, redactProviderUrl)
  );
}

export function parseSupplementalSourceBinding(
  value: unknown,
  filePath: string
): SupplementalSourceManifestBinding | undefined {
  if (value === undefined) return undefined;
  const parsed = SupplementalSourceManifestBindingSchema.safeParse(value);
  if (!parsed.success) throw invalidBinding(filePath);
  return parsed.data;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertUniqueShardKeys(
  shards: readonly SupplementalSourceShard[],
  label: string
): void {
  if (new Set(shards.map((shard) => shard.cache_key)).size !== shards.length) {
    throw new Error(`supplemental source receipt at ${label} has duplicate cache keys`);
  }
}

function assertReceiptIdentityContinuity(
  source: SupplementalSourceReceipt,
  target: SupplementalSourceReceipt
): void {
  if (!isDeepStrictEqual(source.physical_source, target.physical_source) ||
      !isDeepStrictEqual(
        source.logical_cache_identity,
        target.logical_cache_identity
      ) ||
      source.mapping_basis !== target.mapping_basis) {
    throw new Error("supplemental source receipt extension changes provider identity");
  }
}

function provenanceBinding(
  receipt: SupplementalSourceReceipt
): SupplementalSourceProvenanceBinding {
  return redactSupplementalSourceBinding(
    supplementalSourceManifestBinding(receipt),
    redactProvenanceUrl
  );
}

function invalidBinding(filePath: string): Error {
  return new Error(
    `extraction cache manifest at ${filePath} has invalid supplemental source receipt`
  );
}
