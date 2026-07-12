import { createHash } from "node:crypto";

const RETAINED_STRING_LIMITS = {
  matched_text: 1_024,
  distilled_fact: 2_048,
  source_assertion: 2_048,
  proposed_matched_text: 1_024,
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
  return {
    ...projection,
    bench_source_raw_payload_projected: true,
    bench_source_raw_payload_key_count: Object.keys(rawPayload).length,
    bench_source_raw_payload_char_count: serialized.length,
    bench_source_raw_payload_sha256: `sha256:${createHash("sha256")
      .update(serialized, "utf8")
      .digest("hex")}`
  };
}

function addStructuredProjection(
  projection: Record<string, unknown>,
  rawPayload: Readonly<Record<string, unknown>>
): void {
  const canonicalEntities = projectCanonicalEntities(rawPayload.canonical_entities);
  const temporalProjection = projectRecord(rawPayload.temporal_projection, TEMPORAL_STRING_KEYS, 64);
  const preferenceProfile = projectRecord(rawPayload.preference_profile, PREFERENCE_STRING_KEYS, 512);
  const sourceGrounding = projectSourceGrounding(rawPayload.source_grounding);
  if (canonicalEntities.length > 0) projection.canonical_entities = canonicalEntities;
  if (temporalProjection !== null) projection.temporal_projection = temporalProjection;
  if (preferenceProfile !== null) projection.preference_profile = preferenceProfile;
  if (sourceGrounding !== null) projection.source_grounding = sourceGrounding;
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
  return projection;
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
