import type { MemoryEntry } from "@do-soul/alaya-protocol";

const INDEPENDENT_PROJECTION_FIELD_KEYS = [
  "projection_schema_version",
  "event_time_start",
  "event_time_end",
  "valid_from",
  "valid_to",
  "time_precision",
  "time_source",
  "canonical_entities"
] as const;

const PREFERENCE_PROJECTION_FIELD_KEYS = [
  "preference_subject",
  "preference_predicate",
  "preference_object",
  "preference_category",
  "preference_polarity"
] as const;

const PROJECTION_FIELD_KEYS = [
  ...INDEPENDENT_PROJECTION_FIELD_KEYS,
  ...PREFERENCE_PROJECTION_FIELD_KEYS
] as const;

// Update-owned projection fields. Storage update also accepts creation-only
// `facet_tags`; do not add that column here to look consistent with the writer.
export type ReconciliationMemoryProjectionFields = Pick<
  MemoryEntry,
  (typeof PROJECTION_FIELD_KEYS)[number]
>;

export type ReconciliationMemoryUpdateFields = {
  readonly content: string;
  readonly domain_tags: readonly string[];
  readonly evidence_refs: readonly string[];
} & Partial<ReconciliationMemoryProjectionFields>;

type MutableProjectionFields = {
  -readonly [K in keyof ReconciliationMemoryProjectionFields]?: ReconciliationMemoryProjectionFields[K];
};

function hasPreferenceProjection(
  value: ReconciliationMemoryProjectionFields
): boolean {
  return PREFERENCE_PROJECTION_FIELD_KEYS.some(
    (key) => value[key] !== undefined && value[key] !== null
  );
}

function buildProjectionReplacementFields(
  incoming: ReconciliationMemoryProjectionFields | undefined
): MutableProjectionFields {
  if (incoming === undefined) {
    return {};
  }
  const fields: MutableProjectionFields = {};
  for (const key of INDEPENDENT_PROJECTION_FIELD_KEYS) {
    const value = incoming[key];
    if (value !== undefined) {
      fields[key] = value as never;
    }
  }
  if (hasPreferenceProjection(incoming)) {
    for (const key of PREFERENCE_PROJECTION_FIELD_KEYS) {
      fields[key] = (incoming[key] ?? null) as never;
    }
  }
  return fields;
}

export function buildUpdateFields(
  existing: Readonly<MemoryEntry>,
  incomingContent: string,
  incomingDomainTags: readonly string[],
  incomingEvidenceRef: string,
  incomingProjectionFields: ReconciliationMemoryProjectionFields | undefined
): ReconciliationMemoryUpdateFields {
  const evidenceRefs = existing.evidence_refs.includes(incomingEvidenceRef)
    ? existing.evidence_refs
    : [...existing.evidence_refs, incomingEvidenceRef];
  return {
    content: incomingContent,
    domain_tags: incomingDomainTags,
    evidence_refs: evidenceRefs,
    ...buildProjectionReplacementFields(incomingProjectionFields)
  };
}

export function updateFieldsMatch(
  row: Readonly<MemoryEntry>,
  fields: ReconciliationMemoryUpdateFields
): boolean {
  if (row.content !== fields.content || !sameStringMultiset(row.domain_tags, fields.domain_tags)) {
    return false;
  }
  if (!sameStringMultiset(row.evidence_refs, fields.evidence_refs)) {
    return false;
  }
  return PROJECTION_FIELD_KEYS.every(
    (key) => fields[key] === undefined || projectionValuesMatch(row[key], fields[key])
  );
}

function sameStringMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}

function projectionValuesMatch(
  actual: MemoryEntry[(typeof PROJECTION_FIELD_KEYS)[number]] | undefined,
  expected: MemoryEntry[(typeof PROJECTION_FIELD_KEYS)[number]] | undefined
): boolean {
  if (expected === null) {
    return actual === null || actual === undefined;
  }
  // canonical_entities is array-valued; compare as a duplicate-sensitive
  // multiset, not by reference.
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && sameStringMultiset(actual, expected);
  }
  return actual === expected;
}
