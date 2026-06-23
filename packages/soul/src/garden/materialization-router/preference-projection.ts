import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import type { MemoryMaterializationInput } from "./contracts.js";

interface PreferenceProfilePayload {
  readonly preference_subject?: string;
  readonly preference_predicate?: string;
  readonly preference_object?: string;
  readonly preference_category?: string;
  readonly preference_polarity?: MemoryMaterializationInput["preference_polarity"];
  readonly projection_schema_version?: 1;
}

export function readMemoryPreferenceProfilePayload(
  rawPayload: CandidateMemorySignal["raw_payload"]
): Partial<Pick<
  MemoryMaterializationInput,
  | "preference_subject"
  | "preference_predicate"
  | "preference_object"
  | "preference_category"
  | "preference_polarity"
>> {
  return readPreferenceProfileRecord(rawPayload.preference_profile) ?? {};
}

function readPreferenceProfileRecord(value: unknown): PreferenceProfilePayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const profile: PreferenceProfilePayload = {
    ...readProjectionSchemaVersion(candidate.projection_schema_version ?? candidate.version),
    ...readOptionalProfileString(candidate, "preference_subject", "subject"),
    ...readOptionalProfileString(candidate, "preference_predicate", "predicate"),
    ...readOptionalProfileString(candidate, "preference_object", "object"),
    ...readOptionalProfileString(candidate, "preference_category", "category"),
    ...readOptionalPolarity(candidate.polarity ?? candidate.preference_polarity)
  };
  return Object.keys(profile).length === 0 ? null : profile;
}

function readOptionalProfileString(
  record: Record<string, unknown>,
  outputKey: "preference_subject" | "preference_predicate" | "preference_object" | "preference_category",
  inputKey: "subject" | "predicate" | "object" | "category"
): Partial<PreferenceProfilePayload> {
  const value = normalizeProfileString(record[outputKey] ?? record[inputKey]);
  return value === null ? {} : { [outputKey]: value };
}

function readOptionalPolarity(value: unknown): Pick<PreferenceProfilePayload, "preference_polarity"> | Record<string, never> {
  if (value === "positive" || value === "negative" || value === "neutral") {
    return { preference_polarity: value };
  }
  return {};
}

function readProjectionSchemaVersion(value: unknown): Pick<PreferenceProfilePayload, "projection_schema_version"> | Record<string, never> {
  return value === 1 || value === "1" ? { projection_schema_version: 1 } : {};
}

function normalizeProfileString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized.slice(0, 1024);
}
