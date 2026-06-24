import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { normalizeTemporalIsoString } from "../temporal-date.js";
import type { MemoryMaterializationInput } from "./contracts.js";

interface TemporalProjectionPayload {
  readonly event_time_start?: string;
  readonly event_time_end?: string;
  readonly valid_from?: string;
  readonly valid_to?: string;
  readonly time_precision?: MemoryMaterializationInput["time_precision"];
  readonly time_source?: MemoryMaterializationInput["time_source"];
  readonly projection_schema_version?: 1;
}

export function readMemoryTemporalProjectionPayload(
  rawPayload: CandidateMemorySignal["raw_payload"]
): Partial<Pick<
  MemoryMaterializationInput,
  "event_time_start" | "event_time_end" | "valid_from" | "valid_to" | "time_precision" | "time_source"
>> {
  const explicitProjection = readTemporalProjectionRecord(rawPayload.temporal_projection);
  if (explicitProjection !== null) {
    return explicitProjection;
  }
  const timeConcernProjection = readTemporalProjectionRecord(rawPayload.time_concern);
  return timeConcernProjection ?? {};
}

function readTemporalProjectionRecord(value: unknown): TemporalProjectionPayload | null {
  const candidate = toUnknownRecord(value);
  if (candidate === null) {
    return null;
  }
  const projection: TemporalProjectionPayload = {
    ...readProjectionSchemaVersion(candidate.projection_schema_version ?? candidate.version),
    ...readOptionalTemporalDate(candidate, "event_time_start"),
    ...readOptionalTemporalDate(candidate, "event_time_end"),
    ...readOptionalTemporalDate(candidate, "valid_from"),
    ...readOptionalTemporalDate(candidate, "valid_to"),
    ...readOptionalTemporalEnum(candidate, "time_precision"),
    ...readOptionalTemporalEnum(candidate, "time_source")
  };
  return Object.keys(projection).length === 0 ? null : projection;
}

function readOptionalTemporalDate(
  record: Record<string, unknown>,
  key: "event_time_start" | "event_time_end" | "valid_from" | "valid_to"
): Partial<TemporalProjectionPayload> {
  const value = normalizePayloadString(record[key]);
  if (value === null) {
    return {};
  }
  const normalized = normalizeTemporalIsoString(value);
  return normalized === null ? {} : { [key]: normalized };
}

function readOptionalTemporalEnum(
  record: Record<string, unknown>,
  key: "time_precision" | "time_source"
): Partial<TemporalProjectionPayload> {
  const value = normalizePayloadString(record[key]);
  if (value === null) {
    return {};
  }
  if (key === "time_precision") {
    return isTimePrecision(value) ? { time_precision: value } : {};
  }
  return isTimeSource(value) ? { time_source: value } : {};
}

function normalizePayloadString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function toUnknownRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function readProjectionSchemaVersion(value: unknown): Pick<TemporalProjectionPayload, "projection_schema_version"> | Record<string, never> {
  return value === 1 || value === "1" ? { projection_schema_version: 1 } : {};
}

function isTimePrecision(value: string): value is NonNullable<MemoryMaterializationInput["time_precision"]> {
  return value === "day" || value === "month" || value === "year" ||
    value === "range" || value === "relative" || value === "unknown";
}

function isTimeSource(value: string): value is NonNullable<MemoryMaterializationInput["time_source"]> {
  return value === "explicit" || value === "session_timestamp" || value === "relative_resolved";
}
