import type { MemoryEntry, RecallCandidate } from "@do-soul/alaya-protocol";
import type { RecallCandidateAnswerFeatures } from "../runtime/recall-service-types.js";

export const RECALL_DIAGNOSTIC_EVIDENCE_GIST_MAX_CHARS = 8192;

export function buildRecallCandidateAnswerFeatures(
  entry: Readonly<MemoryEntry>,
  objectKind: RecallCandidate["object_kind"],
  rawEvidenceGist: string | undefined
): Readonly<RecallCandidateAnswerFeatures> {
  if (objectKind === "synthesis_capsule") {
    return buildSynthesisAnswerFeatures(entry);
  }
  const gist = normalizeEvidenceGist(rawEvidenceGist);
  return Object.freeze({
    content: entry.content,
    evidence_gist: gist.value,
    evidence_gist_truncated: gist.truncated,
    domain_tags: Object.freeze([...entry.domain_tags]),
    evidence_refs: Object.freeze([...entry.evidence_refs]),
    facet_tags: freezeFacetTags(entry.facet_tags),
    canonical_entities: Object.freeze([...(entry.canonical_entities ?? [])]),
    projection_schema_version: entry.projection_schema_version ?? null,
    event_time_start: entry.event_time_start ?? null,
    event_time_end: entry.event_time_end ?? null,
    valid_from: entry.valid_from ?? null,
    valid_to: entry.valid_to ?? null,
    time_precision: entry.time_precision ?? null,
    time_source: entry.time_source ?? null,
    preference_subject: entry.preference_subject ?? null,
    preference_predicate: entry.preference_predicate ?? null,
    preference_object: entry.preference_object ?? null,
    preference_category: entry.preference_category ?? null,
    preference_polarity: entry.preference_polarity ?? null
  });
}

function buildSynthesisAnswerFeatures(
  entry: Readonly<MemoryEntry>
): Readonly<RecallCandidateAnswerFeatures> {
  return Object.freeze({
    content: entry.content,
    evidence_gist: null,
    evidence_gist_truncated: false,
    domain_tags: Object.freeze([]),
    evidence_refs: Object.freeze([...entry.evidence_refs]),
    facet_tags: Object.freeze([]),
    canonical_entities: Object.freeze([]),
    projection_schema_version: null,
    event_time_start: null,
    event_time_end: null,
    valid_from: null,
    valid_to: null,
    time_precision: null,
    time_source: null,
    preference_subject: null,
    preference_predicate: null,
    preference_object: null,
    preference_category: null,
    preference_polarity: null
  });
}

function freezeFacetTags(
  facetTags: MemoryEntry["facet_tags"]
): NonNullable<MemoryEntry["facet_tags"]> {
  return Object.freeze((facetTags ?? []).map((tag) => Object.freeze({ ...tag })));
}

function normalizeEvidenceGist(
  rawEvidenceGist: string | undefined
): Readonly<{ readonly value: string | null; readonly truncated: boolean }> {
  const trimmed = rawEvidenceGist?.trim() ?? "";
  if (trimmed.length === 0) {
    return Object.freeze({ value: null, truncated: false });
  }
  const truncated = trimmed.length > RECALL_DIAGNOSTIC_EVIDENCE_GIST_MAX_CHARS;
  return Object.freeze({
    value: truncated
      ? trimmed.slice(0, RECALL_DIAGNOSTIC_EVIDENCE_GIST_MAX_CHARS)
      : trimmed,
    truncated
  });
}
