import { createHash } from "node:crypto";
import { z } from "zod";
import {
  hashLongMemEvalSupplementalSourceBinding,
  LongMemEvalSupplementalSourceManifestBindingWireSchema,
  LongMemEvalSupplementalSourceProvenanceBindingWireSchema
} from "@do-soul/alaya-eval/internal";
import type { ExtractionRequestProfile } from "../request-profile.js";

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

function invalidBinding(filePath: string): Error {
  return new Error(
    `extraction cache manifest at ${filePath} has invalid supplemental source receipt`
  );
}
