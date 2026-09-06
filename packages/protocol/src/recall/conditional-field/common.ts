import { z } from "zod";
import { BoundedIdSchema } from "../../shared/schema-primitives.js";

export const CONDITIONAL_FIELD_SCHEMA_VERSION = 1 as const;
export const MILLIGRADE_BOTTOM = 0;
export const MILLIGRADE_TOP = 1000;
export const ASSOCIATION_DOMAIN_ID = "assoc.bottleneck.milligrade.v1";
export const CONDITIONAL_FIELD_DIGEST_PREFIX = "sha256:";
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export const SchemaVersionSchema = z.literal(CONDITIONAL_FIELD_SCHEMA_VERSION);
export const MilligradeSchema = z.number().int().min(MILLIGRADE_BOTTOM).max(MILLIGRADE_TOP);
export const FacetModeSchema = z.enum(["same_path", "independent"]);
export const ConditionalFieldIdSchema = BoundedIdSchema;
export const Sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN);
export const Sha256DigestSchema = z.string().regex(SHA256_DIGEST_PATTERN);

export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;
export type Milligrade = z.infer<typeof MilligradeSchema>;
export type FacetMode = z.infer<typeof FacetModeSchema>;
export type ConditionalFieldId = z.infer<typeof ConditionalFieldIdSchema>;
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;
export type Sha256Digest = z.infer<typeof Sha256DigestSchema>;

export function formatConditionalFieldDigest(hex: string): string {
  if (!SHA256_HEX_PATTERN.test(hex)) {
    throw new Error("conditional-field digest hex is invalid");
  }
  return `${CONDITIONAL_FIELD_DIGEST_PREFIX}${hex}`;
}
