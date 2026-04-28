import { z } from "zod";
import {
  CanonicalAliasDomain,
  governanceSubjectQualifierAliasDomain,
  type CanonicalAliasResolver
} from "./canonical-alias.js";
import { NonEmptyStringSchema } from "../schema-primitives.js";

const CanonicalDomainRegex = /^[\p{L}\p{N}_.-]+$/u;
const CanonicalTokenWhitespaceRegex = /\s+/g;
const CanonicalTokenIllegalCharactersRegex = /[^\p{L}\p{N}_.-]/gu;
const CanonicalTokenRepeatedUnderscoreRegex = /_+/g;
const CanonicalTokenBoundaryUnderscoreRegex = /^_+|_+$/g;

const GovernanceQualifierSchema = z.record(NonEmptyStringSchema).readonly();

export const GovernanceQualifierAliasMapSchema = z
  .record(z.record(NonEmptyStringSchema).readonly())
  .readonly();

export type GovernanceQualifierAliasMap = z.infer<typeof GovernanceQualifierAliasMapSchema>;

export const GOVERNANCE_SUBJECT_QUALIFIER_ALIASES = GovernanceQualifierAliasMapSchema.parse({});

export const GovernanceSubjectSchema = z
  .object({
    subject_domain: NonEmptyStringSchema.regex(CanonicalDomainRegex),
    subject_qualifiers: GovernanceQualifierSchema,
    canonical_key: NonEmptyStringSchema
  })
  .readonly();

export type GovernanceSubject = z.infer<typeof GovernanceSubjectSchema>;

export interface GovernanceSubjectCanonicalizationOptions {
  readonly aliasResolver?: CanonicalAliasResolver;
  readonly qualifierAliases?: GovernanceQualifierAliasMap;
}

export function canonicalGovernanceSubject(
  domain: string,
  qualifiers: Record<string, string> = {},
  options: GovernanceSubjectCanonicalizationOptions = {}
): GovernanceSubject {
  const normalizedDomain = resolveCanonicalValue(
    domain,
    CanonicalAliasDomain.GOVERNANCE_SUBJECT_DOMAIN,
    options.aliasResolver
  );

  if (normalizedDomain.length === 0) {
    throw new Error("governance_subject domain must not be empty.");
  }

  const normalizedQualifiers = normalizeQualifiers(
    qualifiers,
    options.qualifierAliases ?? GOVERNANCE_SUBJECT_QUALIFIER_ALIASES,
    options.aliasResolver
  );
  const qualifierEntries = Object.entries(normalizedQualifiers);
  const canonicalKey =
    qualifierEntries.length === 0
      ? normalizedDomain
      : `${normalizedDomain}::${qualifierEntries.map(([key, value]) => `${key}=${value}`).join(",")}`;

  return GovernanceSubjectSchema.parse({
    subject_domain: normalizedDomain,
    subject_qualifiers: normalizedQualifiers,
    canonical_key: canonicalKey
  });
}

function normalizeQualifiers(
  qualifiers: Record<string, string>,
  aliasMap: GovernanceQualifierAliasMap,
  aliasResolver?: CanonicalAliasResolver
): Record<string, string> {
  const parsedQualifiers = z.record(z.string()).parse(qualifiers);
  const dedupedQualifiers = new Map<string, string>();

  for (const [rawKey, rawValue] of Object.entries(parsedQualifiers)) {
    const key = canonicalizeToken(rawKey);

    if (key.length === 0) {
      continue;
    }

    const value = canonicalizeToken(rawValue);

    if (value.length === 0) {
      continue;
    }

    const aliasValue = aliasMap[key]?.[value] ?? value;
    const normalizedValue = resolveCanonicalValue(
      aliasValue,
      governanceSubjectQualifierAliasDomain(key),
      aliasResolver
    );

    if (normalizedValue.length === 0) {
      continue;
    }

    dedupedQualifiers.set(key, normalizedValue);
  }

  const sortedEntries = [...dedupedQualifiers.entries()].sort(([leftKey], [rightKey]) =>
    compareCanonicalKeys(leftKey, rightKey)
  );

  return Object.freeze(Object.fromEntries(sortedEntries));
}

function resolveCanonicalValue(
  value: string,
  aliasDomain: string,
  aliasResolver?: CanonicalAliasResolver
): string {
  const resolvedValue = aliasResolver === undefined ? value : aliasResolver(value, aliasDomain);
  return canonicalizeToken(resolvedValue);
}

export function canonicalizeToken(value: string): string {
  return value
    .trim()
    .normalize("NFC")
    .toLowerCase()
    .replace(CanonicalTokenWhitespaceRegex, "_")
    .replace(CanonicalTokenIllegalCharactersRegex, "")
    .replace(CanonicalTokenRepeatedUnderscoreRegex, "_")
    .replace(CanonicalTokenBoundaryUnderscoreRegex, "");
}

function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
