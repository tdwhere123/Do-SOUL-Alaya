import { z } from "zod";
import { BoundedLabelSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";

const canonicalAliasDomainPrefix = "governance_subject.qualifier." as const;

export const CanonicalAliasDomain = {
  GOVERNANCE_SUBJECT_DOMAIN: "governance_subject.domain",
  PATH_ANCHOR_OBLIGATION: "path_anchor.obligation",
  PATH_ANCHOR_CONCERN: "path_anchor.concern",
  PATH_ANCHOR_WINDOW: "path_anchor.window"
} as const;

export const CanonicalAliasEntrySchema = z
  .object({
    alias: NonEmptyStringSchema,
    canonical: NonEmptyStringSchema,
    language: NonEmptyStringSchema,
    domain: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export const CanonicalAliasMapSchema = z
  .record(BoundedLabelSchema, z.array(CanonicalAliasEntrySchema).readonly())
  .readonly();

export type CanonicalAliasEntry = z.infer<typeof CanonicalAliasEntrySchema>;
export type CanonicalAliasMap = z.infer<typeof CanonicalAliasMapSchema>;
export type CanonicalAliasResolver = (input: string, domain: string) => string;

export function governanceSubjectQualifierAliasDomain(qualifierKey: string): string {
  const normalizedQualifierKey = qualifierKey.trim();

  if (normalizedQualifierKey.length === 0) {
    throw new Error("governance subject qualifier alias domain must not be empty.");
  }

  return `${canonicalAliasDomainPrefix}${normalizedQualifierKey}`;
}
