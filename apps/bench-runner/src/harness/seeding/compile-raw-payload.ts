import { createHash } from "node:crypto";
import {
  AssociativeFactFrameSchema,
  BOUNDED_JSON_OBJECT_MAX_CHARS,
  OpenSemanticFactorGraphProposalSchema,
  parseVerifiedUserAssertionSourceHash
} from "@do-soul/alaya-protocol";
import {
  parseOfficialApiSemanticFactorGraphProjectionAudit,
  parseOfficialApiSourceLocator
} from "@do-soul/alaya-soul";

const PREFERENCE_FIELD_MAX_CHARS = 1_024;
const PREFERENCE_PROFILE_OMITTED_REASON =
  "proposed_preference_profile_omitted_for_payload_bound";

const RETAINED_STRING_LIMITS = {
  matched_text: 2_048,
  distilled_fact: 2_048,
  source_assertion: 2_048,
  proposed_matched_text: 2_048,
  proposed_distilled_fact: 2_048,
  full_turn_content: 2_048,
  turn_content_excerpt: 256,
  provider_kind: 200,
  extraction_reason: 400,
  extracted_object_kind: 200,
  extraction_provider: 200
} as const;

const TEMPORAL_STRING_KEYS = [
  "event_time_start",
  "event_time_end",
  "valid_from",
  "valid_to",
  "time_precision",
  "time_source"
] as const;
const PREFERENCE_STRING_KEYS = [
  "preference_subject",
  "preference_predicate",
  "preference_object",
  "preference_category",
  "preference_polarity"
] as const;
const BENCH_INTEGER_KEYS = [
  "bench_turn_seed_index",
  "bench_full_turn_tokens",
  "bench_stored_content_tokens",
  "bench_full_turn_char_count"
] as const;
const OPTIONAL_DUPLICATE_KEYS = [
  "matched_text",
  "distilled_fact",
  "source_assertion",
  "proposed_matched_text",
  "proposed_distilled_fact",
  "turn_content_excerpt",
  "provider_kind",
  "extraction_reason",
  "extracted_object_kind",
  "extraction_provider",
  "bench_turn_seed_index",
  "bench_full_turn_tokens",
  "bench_stored_content_tokens",
  "bench_full_turn_char_count",
  "bench_full_turn_sha256",
  "bench_source_raw_payload_key_count",
  "bench_source_raw_payload_char_count",
  "bench_source_raw_payload_sha256"
] as const;
const OPTIONAL_SEMANTIC_PROJECTION_KEYS = [
  "fact_frame",
  "semantic_factor_graph"
] as const;
const V2_RECEIPT_REQUIRED_DUPLICATE_KEYS = new Set<string>([
  "matched_text",
  "distilled_fact",
  "source_assertion"
]);

export function projectCompileRawPayload(
  rawPayload: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  for (const [key, limit] of Object.entries(RETAINED_STRING_LIMITS)) {
    const value = rawPayload[key];
    if (typeof value === "string" && value.length > 0) {
      projection[key] = value.slice(0, limit);
    }
  }
  addStructuredProjection(projection, rawPayload);
  const serialized = canonicalJsonString(rawPayload);
  return fitProjectedPayload({
    ...projection,
    bench_source_raw_payload_projected: true,
    bench_source_raw_payload_key_count: Object.keys(rawPayload).length,
    bench_source_raw_payload_char_count: serialized.length,
    bench_source_raw_payload_sha256: `sha256:${createHash("sha256")
      .update(serialized, "utf8")
      .digest("hex")}`
  });
}

function addStructuredProjection(
  projection: Record<string, unknown>,
  rawPayload: Readonly<Record<string, unknown>>
): void {
  const canonicalEntities = projectCanonicalEntities(rawPayload.canonical_entities);
  const temporalProjection = projectRecord(rawPayload.temporal_projection, TEMPORAL_STRING_KEYS, 64);
  const preferenceProfile = projectPreferenceProfile(rawPayload.preference_profile);
  const sourceGrounding = projectSourceGrounding(rawPayload.source_grounding);
  const sourceLocator = parseOfficialApiSourceLocator(rawPayload.source_locator);
  const semanticFactorGraph = OpenSemanticFactorGraphProposalSchema.safeParse(
    rawPayload.semantic_factor_graph
  );
  const semanticFactorGraphProjection =
    parseOfficialApiSemanticFactorGraphProjectionAudit(
      rawPayload.semantic_factor_graph_projection
    );
  const factFrame = AssociativeFactFrameSchema.safeParse(rawPayload.fact_frame);
  if (canonicalEntities.length > 0) projection.canonical_entities = canonicalEntities;
  if (temporalProjection !== null) projection.temporal_projection = temporalProjection;
  if (preferenceProfile !== null) projection.preference_profile = preferenceProfile;
  if (sourceGrounding !== null) projection.source_grounding = sourceGrounding;
  if (sourceLocator !== null) projection.source_locator = sourceLocator;
  if (semanticFactorGraph.success) {
    projection.semantic_factor_graph = semanticFactorGraph.data;
  }
  if (semanticFactorGraphProjection !== null) {
    projection.semantic_factor_graph_projection = semanticFactorGraphProjection;
  }
  if (factFrame.success) projection.fact_frame = factFrame.data;
  addVerifiedSourceReceipt(projection, rawPayload);
  if (rawPayload.bench_seed === true) projection.bench_seed = true;
  for (const key of BENCH_INTEGER_KEYS) {
    const value = rawPayload[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      projection[key] = value;
    }
  }
  const digest = rawPayload.bench_full_turn_sha256;
  if (typeof digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(digest)) {
    projection.bench_full_turn_sha256 = digest;
  }
}

function projectSourceGrounding(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || (source.status !== "grounded" && source.status !== "rejected")) return null;
  const projection: Record<string, unknown> = { version: 1, status: source.status };
  for (const key of ["content_basis", "source_assertion", "proposed_matched_text"] as const) {
    const field = source[key];
    if (typeof field === "string" && field.length > 0) projection[key] = field.slice(0, 2_048);
  }
  if (Array.isArray(source.reasons)) {
    projection.reasons = source.reasons
      .filter((reason): reason is string => typeof reason === "string")
      .slice(0, 8)
      .map((reason) => reason.slice(0, 128));
  }
  const proposedPreference = source.proposed_preference_profile;
  const projectedPreference = projectPreferenceProfile(proposedPreference);
  if (projectedPreference !== null) {
    projection.proposed_preference_profile = projectedPreference;
  } else if (isRecord(proposedPreference)) {
    addOmittedPreferenceAudit(projection, proposedPreference);
  }
  return projection;
}

function projectPreferenceProfile(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const projected: Record<string, unknown> = {};
  if (value.projection_schema_version === 1) projected.projection_schema_version = 1;
  for (const key of PREFERENCE_STRING_KEYS) {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) continue;
    if (field.length > PREFERENCE_FIELD_MAX_CHARS) return null;
    projected[key] = field;
  }
  return Object.keys(projected).length === 0 ? null : projected;
}

function fitProjectedPayload(
  projection: Record<string, unknown>
): Record<string, unknown> {
  if (fitsRawPayload(projection)) return projection;
  const grounding = isRecord(projection.source_grounding)
    ? projection.source_grounding
    : null;
  if (grounding !== null && isRecord(grounding.proposed_preference_profile)) {
    const proposed = grounding.proposed_preference_profile;
    delete grounding.proposed_preference_profile;
    addOmittedPreferenceAudit(grounding, proposed);
  }
  const preservesV2Receipt = parseVerifiedUserAssertionSourceHash(
    typeof projection.verified_user_assertion_source_hash === "string"
      ? projection.verified_user_assertion_source_hash : null
  )?.version === 2;
  for (const key of OPTIONAL_DUPLICATE_KEYS) {
    if (fitsRawPayload(projection)) return projection;
    if (preservesV2Receipt && V2_RECEIPT_REQUIRED_DUPLICATE_KEYS.has(key)) continue;
    delete projection[key];
  }
  compactGroundingReasons(grounding);
  for (const key of ["canonical_entities", "temporal_projection"] as const) {
    if (fitsRawPayload(projection)) return projection;
    delete projection[key];
  }
  for (const key of OPTIONAL_SEMANTIC_PROJECTION_KEYS) {
    if (fitsRawPayload(projection)) return projection;
    omitSemanticProjection(projection, key);
  }
  if (!fitsRawPayload(projection)) {
    throw new Error("Compile raw-payload projection exceeded its bounded core.");
  }
  return projection;
}

function addVerifiedSourceReceipt(
  projection: Record<string, unknown>,
  rawPayload: Readonly<Record<string, unknown>>
): void {
  const receipt = rawPayload.verified_user_assertion_source_hash;
  if (
    typeof receipt === "string" &&
    parseVerifiedUserAssertionSourceHash(receipt) !== null
  ) {
    projection.verified_user_assertion_source_hash = receipt;
  }
}

function omitSemanticProjection(
  projection: Record<string, unknown>,
  key: typeof OPTIONAL_SEMANTIC_PROJECTION_KEYS[number]
): void {
  if (!(key in projection)) return;
  delete projection[key];
  const existing = projection.bench_source_raw_payload_omitted_projections;
  projection.bench_source_raw_payload_omitted_projections = Object.freeze([
    ...(Array.isArray(existing)
      ? existing.filter((value): value is string => typeof value === "string")
      : []),
    key
  ]);
}

function compactGroundingReasons(grounding: Record<string, unknown> | null): void {
  if (grounding === null || !Array.isArray(grounding.reasons)) return;
  grounding.reasons = grounding.reasons.includes(PREFERENCE_PROFILE_OMITTED_REASON)
    ? [PREFERENCE_PROFILE_OMITTED_REASON]
    : [];
}

function fitsRawPayload(value: Readonly<Record<string, unknown>>): boolean {
  return JSON.stringify(value).length <= BOUNDED_JSON_OBJECT_MAX_CHARS;
}

function addOmittedPreferenceAudit(
  grounding: Record<string, unknown>,
  proposed: Readonly<Record<string, unknown>>
): void {
  grounding.proposed_preference_profile_sha256 = digest(proposed);
  const reasons = Array.isArray(grounding.reasons)
    ? grounding.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  grounding.reasons = [...new Set([...reasons, PREFERENCE_PROFILE_OMITTED_REASON])];
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex")}`;
}

function projectCanonicalEntities(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .slice(0, 3)
    .map((entry) => entry.slice(0, 512));
}

function projectRecord(
  value: unknown,
  keys: readonly string[],
  stringLimit: number
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  if (source.projection_schema_version === 1) projected.projection_schema_version = 1;
  for (const key of keys) {
    const field = source[key];
    if (typeof field === "string" && field.length > 0) {
      projected[key] = field.slice(0, stringLimit);
    }
  }
  return Object.keys(projected).length === 0 ? null : projected;
}

export function isRawPayloadBoundError(error: unknown): boolean {
  const issues = readIssues(error);
  return issues.some((issue) => {
    const path = Array.isArray(issue.path) ? issue.path : [];
    return path[0] === "raw_payload" &&
      typeof issue.message === "string" &&
      issue.message.includes("must serialize to at most");
  });
}

function readIssues(error: unknown): readonly Record<string, unknown>[] {
  if (typeof error !== "object" || error === null || !("issues" in error)) return [];
  const issues = error.issues;
  return Array.isArray(issues)
    ? issues.filter((issue): issue is Record<string, unknown> =>
        typeof issue === "object" && issue !== null)
    : [];
}

function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
